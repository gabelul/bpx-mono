/**
 * council — the multi-model consensus mode.
 *
 * N personas run in parallel (Promise.allSettled), each with its own model
 * + stance-injected system prompt. A
 * synthesizer model merges their verdicts into one recommendation, annotated
 * with a confidence score and any disagreement.
 *
 * Shares callAdvisor with solo — that factoring was deliberate, and it pays off
 * here: each member is just `callAdvisor` with a different persona prompt.
 */

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { callAdvisor, resolveAdvisor, type ResolvedAdvisor } from "./advisor.js";
import { callCliAdvisor, type CliBackendConfig } from "./cli-backend.js";
import { withTimeout } from "./timeout.js";
import { buildConsultContext, summarizeLedger, type ContextBudget, type LedgerSummary } from "./context-engine.js";
import type { BpxConsultConfig } from "./config.js";
import { callSeatRoute, resolveSeatRoute } from "./route.js";
import {
	computeConfidence,
	detectDisagreement,
	type MemberResult,
	validateStance,
} from "./consensus.js";
import { personaSystemPrompt, resolvePersona, type Persona } from "./personas.js";
import { ConsultUsage } from "./usage.js";
import { withoutLegacyShowMessages } from "./deliver.js";
import type { SelectedAttachment } from "./attachments.js";

export interface CouncilDetails {
	mode: "council";
	members: Array<{ persona: string; model: string; status: string }>;
	/** Estimated input tokens each member saw (post context-engine re-fit). */
	fittedTokens?: number;
	omitted?: number;
	/** §E.0 evidence-ledger roll-up for the shared member context (kept/compressed/clipped/dropped). */
	ledger?: LedgerSummary;
	synthesizer: string;
	confidence: number;
	phase?: string;
	confidenceBreakdown?: { successRatio: number; agreementRatio: number; avgAlignment: number };
	disagreement?: string;
	usage?: { input: number; output: number; total: number };
	stopReason?: string;
	errorMessage?: string;
}

export const SYNTHESIZER_SYSTEM_PROMPT = `You are a synthesizer model. Several advisor personas have reviewed the same coding task, each from a different stance (advocating, critiquing, or weighing). Your job is to merge their views into ONE recommendation for the executor.

Rules:
- The user message contains MULTIPLE replies, each under a "### <persona> [<stance>]" header. READ EVERY SECTION before synthesizing. Do not begin your synthesis until you have read all of them — if you think you only saw one, re-read the message; they are all there.
- Weigh the replies by substance, not by count.
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
	attachments?: readonly SelectedAttachment[];
}

/**
 * A resolved council member — inline (registry model, callAdvisor) or CLI
 * (external subprocess, callCliAdvisor). The fan-out dispatches on `kind` so a
 * council can mix inline + CLI members in parallel: one provider dying (rate
 * limit, dead key) no longer collapses the whole council when a CLI seat can
 * carry a stance instead.
 */
type ResolvedMember =
	| { persona: Persona; kind: "inline"; advisor: ResolvedAdvisor; contextWindow: number; modelLabel: string }
	| { persona: Persona; kind: "cli"; backend: CliBackendConfig; contextWindow: number; modelLabel: string };

export async function executeCouncil(input: ExecuteCouncilInput): Promise<AgentToolResult<CouncilDetails>> {
	const { ctx, config, signal, onUpdate, question, attachments } = input;
	const usageTracker = new ConsultUsage();

	const councilConfig = config.modes?.council;
	const roster = councilConfig?.members ?? [];
	const synthesizerKey = councilConfig?.synthesizer?.model;
	const parallel = councilConfig?.parallel ?? true;

	if (roster.length === 0) {
		return err(
			"No council members configured. Set modes.council.members in ~/.pi/agent/bpx-consult.json.",
			{ mode: "council", members: [], synthesizer: "(none)", confidence: 0, errorMessage: "no council members configured" },
		);
	}

	// Resolve personas (defaults + user overrides).
	const personas: Persona[] = [];
	for (const name of roster) {
		const p = resolvePersona(name, config.personas as never);
		if (!p) {
			return err(
				`Unknown persona "${name}". Check modes.council.members or personas in config.`,
				{ mode: "council", members: [], synthesizer: "(none)", confidence: 0, errorMessage: `unknown persona: ${name}` },
			);
		}
		personas.push(p);
	}

	// Resolve the synthesizer model.
	const synth = resolveSeatRoute(config, { ...councilConfig?.synthesizer, model: synthesizerKey }, (key) => resolveAdvisor(ctx, key));
	if (synth.kind === "error") {
		return err(`No synthesizer route: ${synth.message}`, { mode: "council", members: [], synthesizer: "(none)", confidence: 0, errorMessage: synth.message });
	}

	// Resolve member models UPFRONT so we can fit the shared context to the
	// smallest window among them + synthesizer. §I: every member must fit, no
	// exceptions. Resolving here (instead of inside the fan-out) also lets us
	// bail early with a clear error if a persona's model is missing.
	const sessionId = ctx.sessionManager.getSessionId();
	const { resolved: memberAdvisors, preFailed } = resolveCouncilMembers(personas, config, (key) => resolveAdvisor(ctx, key));

	// If EVERY member failed to resolve, bail — there's no council to run.
	if (memberAdvisors.length === 0) {
		return err(
			`No council members could resolve their models:\n${preFailed.map((r) => "- " + r.errorMessage).join("\n")}`,
			{ mode: "council", members: preFailed.map((r) => ({ persona: r.persona, model: r.model, status: r.status })), synthesizer: synth.label, confidence: 0, errorMessage: "no council members resolved" },
		);
	}

	// Build the shared context once, fitted to the SMALLEST window in the council.
	// Every member sees the same payload, and the smallest-window member is
	// guaranteed to fit — that's what closes the §I breach.
	const contextBudget = config.contextBudget as ContextBudget;
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages: Message[] = convertToLlm(withoutLegacyShowMessages(sessionMessages));
	const directive = question?.trim() ? `Specific question from the executor: ${question.trim()}` : undefined;

	const minWindow = Math.min(
		synth.contextWindow,
		...memberAdvisors.map((m) => m.contextWindow),
	);

	const fit = buildConsultContext({
		sessionMessages: branchMessages,
		advisorContextWindow: minWindow,
		budget: contextBudget,
		directive,
		attachments,
	});
	const ledgerSummary = summarizeLedger(fit.ledger);

	// Fail-closed (§E.1 RULE B): if the shared context can't fit the smallest
	// member's window even after clipping the pinned evidence, don't fan out a
	// guaranteed-to-overflow payload — surface a clean error. Every member would
	// hit the same wall, so failing once here is cheaper and honest.
	if (fit.error) {
		return err(`Couldn't fit the council window: ${fit.error}`, {
			mode: "council",
			members: memberAdvisors.map((m) => ({ persona: m.persona.name, model: m.modelLabel, status: "error" })),
			synthesizer: synth.label,
			confidence: 0,
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			ledger: ledgerSummary,
			errorMessage: fit.error,
		});
	}

	const memberStatuses = [
		...preFailed.map((member) => ({ persona: member.persona, model: member.model, status: "error" })),
		...memberAdvisors.map((member) => ({ persona: member.persona.name, model: member.modelLabel, status: "pending" })),
	];
	const emitProgress = (phase: string) => onUpdate?.({
		content: [{ type: "text", text: phase }],
		details: { mode: "council", members: memberStatuses.map((member) => ({ ...member })),
			synthesizer: synth.label, confidence: 0, phase },
	});
	emitProgress(`Council: ${preFailed.length}/${memberStatuses.length} seats finished`);

	// Provider-collision warning: if two or more resolved members share a provider,
	// parallel calls can trip that provider's QPM rate limits and silently kill
	// members (caught in live testing — two google/gemini-flash members, one died).
	// Not a crash, but the user should know their roster is fragile. We warn rather
	// than force-stagger because a paid tier with headroom can handle it; the user
	// is the one who knows their provider's limits.
	warnOnProviderCollision(ctx, memberAdvisors);

	// Fan out — each member is a callAdvisor with its persona prompt + model.
	// Each member gets its OWN AbortController, linked to the parent ctx.signal,
	// so a member's own timeout/abort drops only that member — not its siblings.
	// its siblings. (rpiv-btw "Decision 8" pattern, per Claude's review.)
	// Build THUNKS (not promises) so parallel:false can genuinely await them
	// one-at-a-time. The previous .map(() => runMember()) eagerly started every
	// member, making parallel:false a no-op (runSequential awaited promises that
	// were already running concurrently). Thunks defer execution.
	const memberTimeoutMs = councilConfig?.timeoutMs ?? 120000;
	const memberThunks: Array<() => Promise<MemberResult>> = memberAdvisors.map((member, index) => async () => {
		const slot = memberStatuses[preFailed.length + index]!;
		try {
			const result = await runMember(ctx, member, fit.messages, contextBudget, signal, sessionId, memberTimeoutMs, usageTracker.record);
			slot.status = result.status;
			return result;
		} catch (error) {
			slot.status = "error";
			throw error;
		} finally {
			const finished = memberStatuses.filter((row) => row.status !== "pending").length;
			emitProgress(`Council: ${finished}/${memberStatuses.length} seats finished`);
		}
	});

	// Promise.allSettled semantics: one flaky member never crashes the council.
	// parallel:false runs thunks sequentially (genuinely one-at-a-time) so the
	// knob users reach for to dodge provider rate limits actually works.
	const settled = parallel
		? await Promise.allSettled(memberThunks.map((thunk) => thunk()))
		: await runSequential(memberThunks);
	const memberResults: MemberResult[] = [
		...preFailed,
		...settled.map((s): MemberResult =>
			s.status === "fulfilled" ? s.value : {
				persona: "(unknown)",
				stance: "neutral",
				model: "(unknown)",
				status: "error",
				text: "",
				errorMessage: s.reason instanceof Error ? s.reason.message : String(s.reason),
				alignment: 0,
			}
	),
];

	const confidence = computeConfidence(memberResults);
	const disagreement = detectDisagreement(memberResults);

	// If every member failed, don't bother the synthesizer.
	const successful = memberResults.filter((r) => r.status === "ok");
	if (successful.length === 0) {
		const errs = memberResults.map((r) => `- ${r.persona} (${r.model}): ${r.errorMessage}`).join("\n");
		return usageTracker.attach(err(
			`All council members failed:\n${errs}`,
			{
				mode: "council",
				members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
				synthesizer: synth.label,
				confidence: 0,
				fittedTokens: fit.estimatedTokens,
				omitted: fit.omittedCount,
				ledger: ledgerSummary,
				errorMessage: "all members failed",
			},
		));
	}

	// Synthesize only after every seat has settled; show partial failures plainly.
	emitProgress(`Synthesizing ${successful.length}/${memberStatuses.length} replies`);
	const memberBlock = memberResults
		.map((r) => {
			const header = `### ${r.persona} [${r.stance}] — ${r.model} — ${r.status}`;
			if (r.status !== "ok") return `${header}\n(ERROR: ${r.errorMessage ?? "no reply"})`;
			return `${header}\n${r.text}`;
		})
		.join("\n\n---\n\n");

	const successfulCount = memberResults.filter((r) => r.status === "ok").length;
	const disagreementNote = disagreement ? `\n\nNOTE: ${disagreement}` : "";
	const synthUserPrompt = `The council has reviewed the task. Below are ${successfulCount} advisor ${successfulCount === 1 ? "reply" : "replies"}, each under a ### header. READ ALL OF THEM before synthesizing.\n\n${memberBlock}${disagreementNote}\n\nConfidence in the consensus: ${confidence.confidence} (success ${confidence.successRatio}, agreement ${confidence.agreementRatio}, stance-alignment ${confidence.avgAlignment}).\n\nSynthesize ONE recommendation for the executor that weighs every reply above. Return a PLAN, a CORRECTION, or a STOP signal.`;

	// §I: fit the synthesizer input to ITS window. The grown member transcript
	// (memberBlock + disagreementNote) can exceed the synthesizer's context —
	// exactly the §P failure this extension exists to prevent. buildConsultContext
	// drops oldest-first with an [omitted] marker if needed. Mirrors debate.ts.
	const synthFit = buildConsultContext({
		sessionMessages: [{ role: "user", content: synthUserPrompt, timestamp: Date.now() }],
		advisorContextWindow: synth.contextWindow,
		budget: contextBudget,
	});
	if (synthFit.error) {
		return usageTracker.attach(err(`Council synthesizer window failed: ${synthFit.error}\n\n${memberBlock}`, {
			mode: "council", members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
			synthesizer: synth.label, confidence: confidence.confidence, errorMessage: synthFit.error,
		}));
	}

	try {
		const synthResult = await callSeatRoute({
			ctx,
			route: synth,
			systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
			messages: synthFit.messages,
			thinkingLevel: councilConfig?.synthesizer?.thinkingLevel,
			signal,
			sessionId,
			maxTokens: contextBudget.responseReserveTokens,
			onUsage: usageTracker.record,
		});

		const details: CouncilDetails = {
			mode: "council",
			members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			ledger: ledgerSummary,
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

		if (synthResult.stopReason === "error" || synthResult.stopReason === "aborted" || !synthResult.text) {
			return usageTracker.attach(err(`Council synthesizer failed: ${synthResult.errorMessage ?? synthResult.stopReason}\n\n${memberBlock}`,
				{ ...details, errorMessage: synthResult.errorMessage ?? "empty synthesis" }));
		}

		return usageTracker.attach(ok(synthResult.text, details));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return usageTracker.attach(err(`Council synthesizer call threw: ${message}`, {
			mode: "council",
			members: memberResults.map((r) => ({ persona: r.persona, model: r.model, status: r.status })),
			synthesizer: synth.label,
			confidence: confidence.confidence,
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			ledger: ledgerSummary,
			errorMessage: message,
		}));
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run ONE council member with its own AbortController.
 *
 * The controller is linked to the parent ctx.signal, so a user-initiated abort
 * (or session end) still propagates to every member. But a member-specific
 * timeout/abort can abort() this controller alone without touching its
 * siblings — that's the rpiv-btw "Decision 8" pattern. (No per-member
 * circuit-breaker/backoff in v1 — allSettled isolation is the resilience
 * mechanism. See SPEC §M for the v1.1 plan.)
 */

/**
 * Resolve each council persona to an inline or CLI member.
 *
 * Pure (no ctx) so the CLI-vs-inline decision + window fallback is unit-
 * testable without a live model registry. `resolveAdvisor` is injected so a
 * test can stub the registry. Members whose inline model can't resolve are
 * pre-failed (one bad model must not kill the council); CLI members never
 * pre-fail on resolution — a CLI binary isn't in the registry by design.
 */
export function resolveCouncilMembers(
	personas: Persona[],
	config: BpxConsultConfig,
	resolveAdvisor: (key: string | undefined) => ResolvedAdvisor | undefined,
): { resolved: ResolvedMember[]; preFailed: MemberResult[] } {
	const resolved: ResolvedMember[] = [];
	const preFailed: MemberResult[] = [];
	for (const persona of personas) {
		const modelKey = persona.defaultModel ?? config.modes?.solo?.model;
		// Persona-scoped backend (council §1): persona.backend takes precedence
		// over the legacy model-key `backends` map, so two personas on the same
		// model can route differently. Looked up from the RAW config persona
		// (the resolved Persona carries defaultModel but not backend).
		const rawPersona = config.personas?.[persona.name] ?? {};
		const route = resolveSeatRoute(config, { ...rawPersona, model: modelKey }, resolveAdvisor);
		if (route.kind === "error") {
			preFailed.push({ persona: persona.name, stance: persona.stance, model: modelKey ?? "(none)",
				status: "error", text: "", errorMessage: `${route.message} Persona: ${persona.name}.`, alignment: 0 });
			continue;
		}
		if (route.kind === "cli") {
			resolved.push({ persona, kind: "cli", backend: route.backend, contextWindow: route.contextWindow, modelLabel: route.label });
		} else {
			resolved.push({ persona, kind: "inline", advisor: route.advisor, contextWindow: route.contextWindow, modelLabel: route.label });
		}
	}
	return { resolved, preFailed };
}

async function runMember(
	ctx: ExtensionContext,
	member: ResolvedMember,
	messages: Message[],
	contextBudget: ContextBudget,
	parentSignal: AbortSignal | undefined,
	sessionId: string | undefined,
	memberTimeoutMs: number,
	onUsage: (usage: Usage) => void,
): Promise<MemberResult> {
	const { persona, modelLabel } = member;
	const systemPrompt = personaSystemPrompt(persona);
	const thinkingLevel: ThinkingLevel | undefined = persona.thinkingLevel;
	// Per-member wall-clock budget (council.timeoutMs). Insurance against a
	// provider that accepts-then-hangs — without this, allSettled never resolves
	// and the executor turn hangs. Consistent with debate's wall-clock fix.
	const outcome = await withTimeout(memberTimeoutMs, parentSignal, async (signal) => {
		// CLI member: pipe the fitted context to the external subprocess. The CLI
		// path is async/non-blocking by design (cli-backend.ts), so it runs truly
	// parallel to any inline completeSimple sibling — that's what makes a mixed
		// inline+CLI council survive one provider dying.
		if (member.kind === "cli") {
			const cliResult = await callCliAdvisor({
				systemPrompt,
				messages,
				backend: member.backend,
				signal,
				cwd: ctx.cwd,
				responseReserveTokens: contextBudget.responseReserveTokens,
			});
			// Normalize CliCallResult → ConsultCallResult shape so the status logic
			// below is identical for inline and CLI members.
			return {
				text: cliResult.text,
				usage: undefined,
				stopReason: cliResult.errorMessage ? "error" : "stop",
				errorMessage: cliResult.errorMessage,
			};
		}
		return callAdvisor({
			ctx,
			advisor: member.advisor,
			systemPrompt,
			messages,
			thinkingLevel,
			signal,
			sessionId,
			maxTokens: contextBudget.responseReserveTokens,
			onUsage,
		});
	});

	// Timeout or throw → failed member (isolation holds; siblings unaffected).
	if (outcome.timedOut) {
		return memberErr(persona, modelLabel, `timed out after ${memberTimeoutMs}ms`);
	}
	if (!outcome.ok) {
		const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return memberErr(persona, modelLabel, message);
	}

	const result = outcome.value;
	const status: "ok" | "error" =
		result.stopReason === "error" || result.stopReason === "aborted" || !result.text ? "error" : "ok";
	// Clamp observability: if the persona's requested effort exceeded the model,
	// say so at the end of the member's output so probes/transcripts show why a
	// reply reads shallower than the roster promises. Config keeps the raw value.
	const effortNote = result.effortAdjusted
		? `\n\n(note: requested thinking ${result.effortAdjusted.requested} was downgraded to ${result.effortAdjusted.effective} — model supports less)`
		: "";
	return {
		persona: persona.name,
		stance: persona.stance,
		model: modelLabel,
		status,
		text: result.text + effortNote,
		errorMessage: status === "error" ? result.errorMessage ?? result.stopReason : undefined,
		alignment: status === "ok" ? validateStance(result.text, persona.stance) : 0,
		usage: result.usage,
	};
}

/** Build a failed-member result — shared by the timeout and throw paths. */
function memberErr(persona: Persona, modelLabel: string, message: string): MemberResult {
	return {
		persona: persona.name,
		stance: persona.stance,
		model: modelLabel,
		status: "error",
		text: "",
		errorMessage: message,
		alignment: 0,
	};
}

/** Run thunks one-at-a-time. Takes FACTORIES (not promises) so each member
 * only starts after the previous one settles — that's what makes parallel:false
 * a real rate-limit dodge rather than a no-op. */
async function runSequential<T>(thunks: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = [];
	for (const thunk of thunks) {
		try {
			results.push({ status: "fulfilled", value: await thunk() });
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

/**
 * Warn (non-blocking) when two or more council members share a provider.
 * Parallel calls to the same provider can trip QPM rate limits and silently
 * kill members — seen in live testing. The warning names the colliding
 * provider and the members so the user can fix the roster.
 */
function warnOnProviderCollision(ctx: ExtensionContext, members: ResolvedMember[]): void {
	const byProvider = new Map<string, string[]>();
	for (const m of members) {
		// Inline member → its model's provider. CLI member → the CLI command (two
		// codex seats still share OpenAI's rate limit under the hood).
		const p = m.kind === "inline" ? m.advisor.model.provider : `cli:${m.backend.command}`;
		byProvider.set(p, [...(byProvider.get(p) ?? []), m.persona.name]);
	}
	const collisions = [...byProvider.entries()].filter(([, names]) => names.length > 1);
	if (collisions.length === 0) return;
	const detail = collisions.map(([p, names]) => `${p} (${names.join(", ")})`).join("; ");
	ctx.ui.notify(
		`bpx-consult: council members share a provider [${detail}]. Parallel calls may trip rate limits — consider distinct providers or tiers. See SPEC §V.`,
		"warning",
	);
}
