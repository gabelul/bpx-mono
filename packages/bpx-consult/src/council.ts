/**
 * council — the multi-model consensus mode.
 *
 * N personas run in parallel (Promise.allSettled, my-zen's asyncio.gather
 * pattern), each with its own model + stance-injected system prompt. A
 * synthesizer model merges their verdicts into one recommendation, annotated
 * with a confidence score and any disagreement.
 *
 * Shares callAdvisor with solo — that factoring was deliberate, and it pays off
 * here: each member is just `callAdvisor` with a different persona prompt.
 */

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message, ThinkingLevel } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { callAdvisor, resolveAdvisor, type ResolvedAdvisor } from "./advisor.js";
import { buildConsultContext, type ContextBudget } from "./context-engine.js";
import type { BpxConsultConfig } from "./config.js";
import {
	computeConfidence,
	detectDisagreement,
	type MemberResult,
	validateStance,
} from "./consensus.js";
import { personaSystemPrompt, resolvePersona, type Persona } from "./personas.js";

export interface CouncilDetails {
	mode: "council";
	members: Array<{ persona: string; model: string; status: string }>;
	/** Estimated input tokens each member saw (post context-engine re-fit). */
	fittedTokens?: number;
	omitted?: number;
	synthesizer: string;
	confidence: number;
	confidenceBreakdown?: { successRatio: number; agreementRatio: number; avgAlignment: number };
	disagreement?: string;
	usage?: { input: number; output: number; total: number };
	stopReason?: string;
	errorMessage?: string;
}

const SYNTHESIZER_SYSTEM_PROMPT = `You are a synthesizer model. Several advisor personas have reviewed the same coding task, each from a different stance (advocating, critiquing, or weighing). Your job is to merge their views into ONE recommendation for the executor.

Rules:
- Read every member's reply. Weigh them by substance, not by count.
- If the members agreed, say so plainly and give the consensus recommendation.
- If they disagreed, SURFACE the disagreement. Do not paper over it. State what each side argued, then give your best call on which is right and why. A false consensus is worse than an honest split.
- Be concrete. The executor needs a PLAN, a CORRECTION, or a STOP signal — give it one, not a summary of opinions.
- You never call tools. You synthesize and advise.`;

export interface ExecuteCouncilInput {
	ctx: ExtensionContext;
	config: BpxConsultConfig;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<CouncilDetails> | undefined;
	question?: string;
}

export async function executeCouncil(input: ExecuteCouncilInput): Promise<AgentToolResult<CouncilDetails>> {
	const { ctx, config, signal, onUpdate, question } = input;

	const councilConfig = config.modes?.council;
	const roster = councilConfig?.members ?? [];
	const synthesizerKey = councilConfig?.synthesizer?.model;
	const parallel = councilConfig?.parallel ?? true;

	if (roster.length === 0) {
		return err(
			"No council members configured. Set modes.council.members in ~/.pi/agent/bpx-consult.json.",
			{ mode: "council", members: [], synthesizer: "(none)", confidence: 0 },
		);
	}

	// Resolve personas (defaults + user overrides).
	const personas: Persona[] = [];
	for (const name of roster) {
		const p = resolvePersona(name, config.personas as never);
		if (!p) {
			return err(
				`Unknown persona "${name}". Check modes.council.members or personas in config.`,
				{ mode: "council", members: [], synthesizer: "(none)", confidence: 0 },
			);
		}
		personas.push(p);
	}

	// Resolve the synthesizer model.
	const synth = resolveAdvisor(ctx, synthesizerKey);
	if (!synth) {
		return err(
			`No synthesizer model configured (got "${synthesizerKey ?? "(none)"}"). Set modes.council.synthesizer.model.`,
			{ mode: "council", members: [], synthesizer: "(none)", confidence: 0 },
		);
	}

	// Build the shared context once — every member sees the same fitted transcript.
	const contextBudget = config.contextBudget as ContextBudget;
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages: Message[] = convertToLlm(sessionMessages);
	const directive = question?.trim() ? `Specific question from the executor: ${question.trim()}` : undefined;

	const fit = buildConsultContext({
		// Fit to the SMALLEST member window so every member sees the same payload.
		// (We resolve each member's window below; for simplicity v1 fits to the
		// synthesizer's window, which is typically the largest — members get the
		// same content and their own providers handle it. If a member's window is
		// smaller than the payload, callAdvisor's provider will reject it; that
		// surfaces as a per-member error rather than a crash. v1.1 can re-fit per
		// member once we have a real per-call budget read.)
		sessionMessages: branchMessages,
		advisorContextWindow: synth.model.contextWindow,
		budget: contextBudget,
		directive,
	});

	onUpdate?.({
		content: [{ type: "text", text: `Consulting council: ${personas.map((p) => p.name).join(", ")}…` }],
		details: {
			mode: "council",
			members: personas.map((p) => ({ persona: p.name, model: p.defaultModel ?? "(inherit)", status: "pending" })),
			synthesizer: synth.label,
			confidence: 0,
		},
	});

	// Fan out — each member is a callAdvisor with its persona prompt + model.
	const sessionId = ctx.sessionManager.getSessionId();
	const memberTasks = personas.map(async (persona): Promise<MemberResult> => {
		const modelKey = persona.defaultModel ?? config.modes?.solo?.model;
		const advisor: ResolvedAdvisor | undefined = resolveAdvisor(ctx, modelKey);
		if (!advisor) {
			return {
				persona: persona.name,
				stance: persona.stance,
				model: modelKey ?? "(none)",
				status: "error",
				text: "",
				errorMessage: `Could not resolve model "${modelKey ?? "(none)"}" for persona ${persona.name}.`,
				alignment: 0,
			};
		}
		const thinkingLevel: ThinkingLevel | undefined = persona.thinkingLevel;
		try {
			const result = await callAdvisor({
				ctx,
				advisor,
				systemPrompt: personaSystemPrompt(persona),
				messages: fit.messages,
				thinkingLevel,
				signal,
				sessionId,
			});
			const status: "ok" | "error" = result.stopReason === "error" || result.stopReason === "aborted" || !result.text
				? "error"
				: "ok";
			return {
				persona: persona.name,
				stance: persona.stance,
				model: advisor.label,
				status,
				text: result.text,
				errorMessage: status === "error" ? result.errorMessage ?? result.stopReason : undefined,
				alignment: status === "ok" ? validateStance(result.text, persona.stance) : 0,
				usage: result.usage,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return {
				persona: persona.name,
				stance: persona.stance,
				model: advisor.label,
				status: "error",
				text: "",
				errorMessage: message,
				alignment: 0,
			};
		}
	});

	// Promise.allSettled semantics: one flaky member never crashes the council.
	const settled = parallel
		? await Promise.allSettled(memberTasks)
		: await runSequential(memberTasks);
	const memberResults: MemberResult[] = settled.map((s) =>
		s.status === "fulfilled" ? s.value : {
			persona: "(unknown)",
			stance: "neutral",
			model: "(unknown)",
			status: "error",
			text: "",
			errorMessage: s.reason instanceof Error ? s.reason.message : String(s.reason),
			alignment: 0,
		},
	);

	const confidence = computeConfidence(memberResults);
	const disagreement = detectDisagreement(memberResults);

	// If every member failed, don't bother the synthesizer.
	const successful = memberResults.filter((r) => r.status === "ok");
	if (successful.length === 0) {
		const errs = memberResults.map((r) => `- ${r.persona} (${r.model}): ${r.errorMessage}`).join("\n");
		return err(
			`All council members failed:\n${errs}`,
			{
				mode: "council",
				members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
				synthesizer: synth.label,
				confidence: 0,
				fittedTokens: fit.estimatedTokens,
				omitted: fit.omittedCount,
				errorMessage: "all members failed",
			},
		);
	}

	// Synthesize.
	const memberBlock = memberResults
		.map((r) => {
			const header = `### ${r.persona} [${r.stance}] — ${r.model} — ${r.status}`;
			if (r.status !== "ok") return `${header}\n(ERROR: ${r.errorMessage ?? "no reply"})`;
			return `${header}\n${r.text}`;
		})
		.join("\n\n---\n\n");

	const disagreementNote = disagreement ? `\n\nNOTE: ${disagreement}` : "";
	const synthUserPrompt = `The council has reviewed the task. Here are their replies:\n\n${memberBlock}${disagreementNote}\n\nConfidence in the consensus: ${confidence.confidence} (success ${confidence.successRatio}, agreement ${confidence.agreementRatio}, stance-alignment ${confidence.avgAlignment}).\n\nSynthesize ONE recommendation for the executor. Return a PLAN, a CORRECTION, or a STOP signal.`;

	try {
		const synthResult = await callAdvisor({
			ctx,
			advisor: synth,
			systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
			messages: [{ role: "user", content: synthUserPrompt, timestamp: Date.now() }],
			thinkingLevel: councilConfig?.synthesizer?.thinkingLevel,
			signal,
			sessionId,
		});

		const details: CouncilDetails = {
			mode: "council",
			members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			synthesizer: synth.label,
			confidence: confidence.confidence,
			confidenceBreakdown: {
				successRatio: confidence.successRatio,
				agreementRatio: confidence.agreementRatio,
				avgAlignment: confidence.avgAlignment,
			},
			disagreement,
			usage: synthResult.usage,
			stopReason: synthResult.stopReason,
			errorMessage: synthResult.errorMessage,
		};

		if (!synthResult.text) {
			return err("Council synthesizer returned no usable text.", { ...details, errorMessage: synthResult.errorMessage ?? "empty synthesis" });
		}

		return ok(synthResult.text, details);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err(`Council synthesizer call threw: ${message}`, {
			mode: "council",
			members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
			synthesizer: synth.label,
			confidence: confidence.confidence,
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			errorMessage: message,
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runSequential<T>(tasks: Array<Promise<T>>): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = [];
	for (const task of tasks) {
		try {
			results.push({ status: "fulfilled", value: await task });
		} catch (reason) {
			results.push({ status: "rejected", reason });
		}
	}
	return results;
}

function ok(text: string, details: CouncilDetails): AgentToolResult<CouncilDetails> {
	return { content: [{ type: "text", text }], details };
}

function err(text: string, details: CouncilDetails): AgentToolResult<CouncilDetails> {
	return { content: [{ type: "text", text }], details };
}
