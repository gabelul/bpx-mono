/**
 * advisor — the shared model-resolution + side-call core.
 *
 * Every mode (solo, council member, debate side, synthesizer) eventually needs
 * the same thing: given a provider/model string + thinking level, resolve it to
 * a Model object, fetch auth, run completeSimple against a fitted context, and
 * return the text. That lives here so the modes stay small.
 */

import type { Api, Message, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "@juicesharp/rpiv-config";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedAdvisor {
	model: Model<Api>;
	label: string; // "provider/modelId" for display
}

/**
 * Resolve a "provider/model" string to a Model via the registry.
 *
 * Returns undefined if the string is malformed or the model isn't registered.
 * Callers surface a configured error rather than throwing — a missing advisor
 * model is a config problem, not a crash.
 */
export function resolveAdvisor(ctx: ExtensionContext, modelKey: string | undefined): ResolvedAdvisor | undefined {
	if (!modelKey) return undefined;
	const parsed = parseModelKey(modelKey);
	if (!parsed) return undefined;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) return undefined;
	return { model, label: `${parsed.provider}/${parsed.modelId}` };
}

/**
 * Clamp a requested thinking level to what the model actually supports.
 * Config values can exceed a model's support (JSON edits, AI-generated
 * personas, model reassignment) — providers react unpredictably to unsupported
 * levels, so every inline call normalizes here. Picks the highest supported
 * level at or below the request; if none sits below, the lowest supported
 * level. Models supporting only "off" receive no reasoning option.
 * Undefined ("model default") passes through untouched. Never mutates config —
 * the raw value stays on disk.
 */
export function clampThinkingLevel(model: Model<Api>, requested?: ThinkingLevel): ThinkingLevel | undefined {
	if (!requested) return undefined;
	// ModelThinkingLevel is wider than ThinkingLevel (it includes "off") — only
	// real effort levels participate in the clamp.
	const supported = getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel =>
		(EFFORT_ORDER as string[]).includes(level),
	);
	if (supported.length === 0) return undefined;
	if (supported.includes(requested)) return requested;
	const rank = (level: ThinkingLevel) => EFFORT_ORDER.indexOf(level);
	const requestRank = rank(requested);
	const below = supported.filter((level) => rank(level) < requestRank).sort((a, b) => rank(a) - rank(b));
	return below[below.length - 1] ?? supported.slice().sort((a, b) => rank(a) - rank(b))[0];
}

const EFFORT_ORDER: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * Fetch API key + headers for a model. Wraps the registry call in the same
 * ok/error shape rpiv-advisor uses so error text is consistent.
 */
export async function getAuth(ctx: ExtensionContext, model: Model<Api>): Promise<
	| { ok: true; apiKey: string; headers: Record<string, string> }
	| { ok: false; error: string }
> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, error: auth.error };
	if (!auth.apiKey) return { ok: false, error: "no api key resolved" };
	return { ok: true, apiKey: auth.apiKey, headers: auth.headers ?? {} };
}

// ---------------------------------------------------------------------------
// The side-call
// ---------------------------------------------------------------------------

export interface ConsultCallInput {
	ctx: ExtensionContext;
	advisor: ResolvedAdvisor;
	systemPrompt: string;
	messages: Message[];
	thinkingLevel?: ThinkingLevel;
	signal: AbortSignal | undefined;
	/** Session id for prompt-cache routing on repeated consultations. Optional. */
	sessionId?: string;
	/** Cap on the advisor's response tokens. Enforces responseReserveTokens on the output side. Optional. */
	maxTokens?: number;
	/** Called once per completed provider response, before status or text is interpreted. */
	onUsage?: (usage: Usage) => void;
}

export interface ConsultCallResult {
	text: string;
	usage: { input: number; output: number; total: number } | undefined;
	stopReason: string;
	errorMessage?: string;
	/** Set when the requested thinking level exceeded the model's support and
	 * was clamped down for the call. Callers surface this in probes and tests;
	 * config on disk keeps the raw requested value. */
	effortAdjusted?: { requested: ThinkingLevel; effective: ThinkingLevel | "off" };
}

/**
 * Run a single advisor side-call. Used by solo directly; council calls it once
 * per member in parallel.
 *
 * `tools: []` reaffirms the "advisor never calls tools" contract even when the
 * forwarded messages contain prior toolCall/toolResult blocks — same guard as
 * rpiv-advisor (btw.ts:235). The advisor reads and advises; it does not act.
 */
export async function callAdvisor(input: ConsultCallInput): Promise<ConsultCallResult> {
	const { ctx, advisor, systemPrompt, messages, thinkingLevel, signal } = input;
	const auth = await getAuth(ctx, advisor.model);

	if (!auth.ok) {
		return { text: "", usage: undefined, stopReason: "error", errorMessage: auth.error };
	}

	const effectiveLevel = clampThinkingLevel(advisor.model, thinkingLevel);
	const response = await completeSimple(
		advisor.model,
		{ systemPrompt, messages, tools: [] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effectiveLevel, sessionId: input.sessionId, maxTokens: input.maxTokens },
	);
	if (response.usage) input.onUsage?.(response.usage);
	const effortAdjusted: ConsultCallResult["effortAdjusted"] =
		thinkingLevel && effectiveLevel !== thinkingLevel ? { requested: thinkingLevel, effective: effectiveLevel ?? "off" } : undefined;

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	// Reasoning models sometimes reply with thinking blocks but no text. Fall
	// back to the thinking content rather than reporting an empty response — the
	// advisor did speak, just in its reasoning channel. Mirrors pi-advisor.
	if (!text) {
		const thinking = response.content
			.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof (c as { thinking?: string }).thinking === "string")
			.map((c) => (c as { thinking: string }).thinking)
			.join("\n")
			.trim();
		if (thinking) {
			return {
				text: `(reasoning)\n${thinking}`,
				usage: response.usage ? { input: response.usage.input, output: response.usage.output, total: response.usage.totalTokens } : undefined,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
				effortAdjusted,
			};
		}
	}

	return {
		text,
		usage: response.usage
			? {
					input: response.usage.input,
					output: response.usage.output,
					total: response.usage.totalTokens,
				}
			: undefined,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		effortAdjusted,
	};
}
