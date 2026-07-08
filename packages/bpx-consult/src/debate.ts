/**
 * debate — sequential adversarial mode.
 *
 * Advocate proposes → critic attacks → advocate rebuts, for N rounds (default 2),
 * then a synthesizer issues a closing verdict. Reuses council's stance-injected
 * persona prompts and a "critically reassess, do not reflexively agree"
 * framing for the attack step, so the critic genuinely stress-tests rather
 * than rubber-stamps.
 *
 * Unlike council (parallel, stateless members), debate is STATEFUL-SEQUENTIAL:
 * each round must thread the prior round's argument so the critic can attack
 * something specific and the advocate can rebut the actual critique. Four
 * things the design therefore nails down:
 *
 *   1. ROUND-TO-ROUND THREADING — the prior position is passed as a user
 *      message in the next call, so round-2's critic references round-1's
 *      advocate by substance, not from a blank slate.
 *   2. PER-ROUND §C RE-FIT — the debate transcript GROWS each round (prior
 *      rounds accumulate), so the fitted context must be recomputed every
 *      call or the last round overflows. We re-fit on each step against the
 *      smaller of the two debaters' windows.
 *   3. GENUINE CLASH → CLOSING VERDICT — stances are for/against by design;
 *      the synthesizer is told to resolve, not paper over. A debate that
 *      converges is pointless, so the prompt asks for the strongest version
 *      of each side and a decisive call.
 *   4. SEQUENTIAL LATENCY BUDGET — total time is sum-of-rounds (advocate +
 *      critic + rebut per round × rounds + synth), so it has its own budget
 *      distinct from council's per-member one. Configurable rounds (1-4).
 */

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { callAdvisor, resolveAdvisor, type ResolvedAdvisor } from "./advisor.js";
import { buildConsultContext, summarizeLedger, type ContextBudget, type LedgerSummary } from "./context-engine.js";
import type { BpxConsultConfig } from "./config.js";
import { personaSystemPrompt, resolvePersona } from "./personas.js";
import { withTimeout } from "./timeout.js";

export interface DebateDetails {
	mode: "debate";
	rounds: number;
	advocate: string;
	critic: string;
	synthesizer: string;
	steps: Array<{ round: number; role: "advocate" | "critic"; status: string }>;
	/** Estimated tokens of the final synthesizer input (grown transcript). */
	finalTranscriptTokens?: number;
	/** §E.0 evidence-ledger roll-up for the seed session context each debater saw. */
	ledger?: LedgerSummary;
	usage?: { input: number; output: number; total: number };
	stopReason?: string;
	errorMessage?: string;
}

const SYNTHESIZER_SYSTEM_PROMPT = `You are the synthesizer closing an adversarial debate. An advocate argued FOR a position across multiple rounds; a critic attacked it. Your job is to issue a decisive verdict for the executor.

Rules:
- The debate existed to stress-test the position. If the critic landed real blows, say so and adjust the verdict. If the advocate held, say so.
- A debate that "agreed to disagree" is a failure of synthesis — make a call. PLAN, CORRECTION, or STOP, with reasoning.
- You never call tools. You issue the verdict.`;

// Forces genuine critique, not reflexive agreement.
const CRITIC_ATTACK_FRAME = (priorPosition: string) =>
	`The advocate just argued:\n\n${priorPosition}\n\nCritically reassess this position. Do NOT reflexively agree to avoid conflict — think hard about where it's wrong, what it assumed, what it overlooked. If it's sound on a point, concede that point and attack the weaker ones. But pressure-test it for real. Your job is the strongest case AGAINST, backed by reason.`;

const ADVOCATE_REBUT_FRAME = (critique: string) =>
	`The critic attacked your position:\n\n${critique}\n\nRebut. Where the critic was right, concede and adjust. Where the critic was wrong, defend with reason. Then restate your strongest case FOR, incorporating what survived the critique. Do not just repeat round 1 — respond to THIS critique.`;

export interface ExecuteDebateInput {
	ctx: ExtensionContext;
	config: BpxConsultConfig;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<DebateDetails> | undefined;
	question?: string;
}

export async function executeDebate(input: ExecuteDebateInput): Promise<AgentToolResult<DebateDetails>> {
	const { ctx, config, signal: parentSignal, onUpdate, question } = input;
	const debateConfig = config.modes?.debate;
	const rounds = clampRounds(debateConfig?.rounds);

	const advocatePersona = resolvePersona(debateConfig?.advocate ?? "architect", config.personas as never);
	const criticPersona = resolvePersona(debateConfig?.critic ?? "critic", config.personas as never);
	if (!advocatePersona || !criticPersona) {
		const missing = !advocatePersona ? debateConfig?.advocate : debateConfig?.critic;
		return err(`Unknown persona "${missing}". Check modes.debate in config.`, emptyDetails(config));
	}

	const advocate = resolveAdvisor(ctx, advocatePersona.defaultModel ?? config.modes?.solo?.model);
	const critic = resolveAdvisor(ctx, criticPersona.defaultModel ?? config.modes?.solo?.model);
	const synthKey = config.modes?.council?.synthesizer?.model ?? config.modes?.solo?.model;
	const synth = resolveAdvisor(ctx, synthKey);
	if (!advocate || !critic || !synth) {
		const unresolved = [
			!advocate && `advocate (${advocatePersona.defaultModel ?? config.modes?.solo?.model})`,
			!critic && `critic (${criticPersona.defaultModel ?? config.modes?.solo?.model})`,
			!synth && `synthesizer (${synthKey})`,
		].filter(Boolean).join("; ");
		return err(`Could not resolve debate models: ${unresolved}.`, emptyDetails(config));
	}

	const details: DebateDetails = {
		mode: "debate",
		rounds,
		advocate: advocate.label,
		critic: critic.label,
		synthesizer: synth.label,
		steps: [],
	};
	const pushStep = (round: number, role: "advocate" | "critic", status: string) => {
		details.steps.push({ round, role, status });
		onUpdate?.({ content: [{ type: "text", text: `Debate round ${round}/${rounds}, ${role}: ${status}` }], details });
	};

	// --- Build the seed context once (the executor's compacted session) ---
	const contextBudget = config.contextBudget as ContextBudget;
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages: Message[] = convertToLlm(sessionMessages);
	const directive = question?.trim() ? `Specific question from the executor: ${question.trim()}` : undefined;
	const sessionId = ctx.sessionManager.getSessionId();

	// The debate transcript grows each round — re-fit per call to the smaller of
	// the two debaters' windows so the last round can't overflow (§C invariant).
	const fitWindow = Math.min(advocate.model.contextWindow, critic.model.contextWindow);

	function fitWithContext(extra: string): Message[] {
		const fit = buildConsultContext({
			sessionMessages: branchMessages,
			advisorContextWindow: fitWindow,
			budget: contextBudget,
			directive: [directive, extra].filter(Boolean).join("\n\n") || undefined,
		});
		// Record the ledger from the seed fit (the transcript is the same each round;
		// only the framing `extra` grows, so the roll-up is representative). Telemetry
		// for the §E gate — surfaced in details.ledger.
		details.ledger = summarizeLedger(fit.ledger);
		return fit.messages;
	}

	// Wall-clock budget across all rounds + synth. consult() is executor-callable,
	// so an autonomous debate can hang mid-round with no human to interrupt —
	// this is the last unprotected path after council (per-member abort) and CLI
	// (resolveShellTimeoutMs). withTimeout fires an AbortController whose signal
	// propagates into every callStep, so the in-flight round aborts cleanly.
	const debateTimeoutMs = debateConfig?.timeoutMs ?? 180000;

	const outcome = await withTimeout(debateTimeoutMs, parentSignal, async (debateSignal) => {
	try {
		// Round 1: advocate opens with the strongest FOR case.
		pushStep(1, "advocate", "running");
		const r1Advocate = await callStep(ctx, advocate, advocatePersona.systemPrompt, fitWithContext(
			"OPENING: make the strongest case FOR the position under debate.",
		), advocatePersona.thinkingLevel, debateSignal, sessionId);
		if (!r1Advocate.ok) { pushStep(1, "advocate", "error"); return err(`Round 1 advocate failed: ${r1Advocate.error}`, details); }
		pushStep(1, "advocate", "ok");

		// Walk the rounds. Round 1's critic attacks the round-1 advocate; for
		// rounds > 1, the advocate rebuts the prior critique then the critic
		// attacks the rebuttal. We thread the immediately-prior argument each step.
		let lastAdvocateText = r1Advocate.text;
		let lastCriticText: string | undefined;

		for (let round = 1; round <= rounds; round++) {
			if (round > 1) {
				// Advocate rebuts the prior round's critique.
				pushStep(round, "advocate", "running");
				const rebut = await callStep(ctx, advocate, personaSystemPrompt(advocatePersona), fitWithContext(
					ADVOCATE_REBUT_FRAME(lastCriticText ?? ""),
				), advocatePersona.thinkingLevel, debateSignal, sessionId);
				if (!rebut.ok) { pushStep(round, "advocate", "error"); return err(`Round ${round} advocate rebuttal failed: ${rebut.error}`, details); }
				pushStep(round, "advocate", "ok");
				lastAdvocateText = rebut.text;
			}

			// Critic attacks the current advocate position.
			pushStep(round, "critic", "running");
			const attack = await callStep(ctx, critic, personaSystemPrompt(criticPersona), fitWithContext(
				CRITIC_ATTACK_FRAME(lastAdvocateText),
			), criticPersona.thinkingLevel, debateSignal, sessionId);
			if (!attack.ok) { pushStep(round, "critic", "error"); return err(`Round ${round} critic attack failed: ${attack.error}`, details); }
			pushStep(round, "critic", "ok");
			lastCriticText = attack.text;
		}

		// Synthesize the verdict from the full grown transcript.
		const transcript = [
			`### Round 1 — Advocate (FOR)\n${r1Advocate.text}`,
			lastCriticText ? `### Final Critique (AGAINST)\n${lastCriticText}` : "",
		].filter(Boolean).join("\n\n---\n\n");
		const synthInput = `The debate is complete. Here is the exchange:\n\n${transcript}\n\nIssue a decisive verdict for the executor.`;

		// Re-fit the synthesizer input to its own window (it may be larger than
		// the debaters', but the grown transcript can still be substantial).
		const synthFitWindow = Math.min(synth.model.contextWindow, fitWindow * 2);
		const synthFit = buildConsultContext({
			sessionMessages: [{ role: "user", content: synthInput, timestamp: Date.now() }],
			advisorContextWindow: synthFitWindow,
			budget: contextBudget,
		});
		details.finalTranscriptTokens = synthFit.estimatedTokens;

		const synthResult = await callAdvisor({
			ctx,
			advisor: synth,
			systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
			messages: synthFit.messages,
			thinkingLevel: config.modes?.council?.synthesizer?.thinkingLevel,
			signal: debateSignal,
			sessionId,
			maxTokens: contextBudget.responseReserveTokens,
		});

		details.usage = synthResult.usage;
		details.stopReason = synthResult.stopReason;
		details.errorMessage = synthResult.errorMessage;

		if (!synthResult.text) {
			return err("Debate synthesizer returned no usable text.", { ...details, errorMessage: synthResult.errorMessage ?? "empty synthesis" });
		}
		return ok(synthResult.text, details);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err(`Debate threw: ${message}`, { ...details, errorMessage: message });
	}
	}); // end withTimeout body

	// Unwrap the timeout outcome.
	if (outcome.timedOut) {
		return err(`Debate timed out after ${debateTimeoutMs}ms (all rounds + synth budget).`, { ...details, errorMessage: `timeout after ${debateTimeoutMs}ms` });
	}
	if (!outcome.ok) {
		// A non-timeout error inside the body — the catch already converted it to
		// an err() result, but withTimeout re-throws on the error path. Surface it.
		const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return err(`Debate failed: ${message}`, { ...details, errorMessage: message });
	}
	return outcome.value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callStep(
	ctx: ExtensionContext,
	advisor: ResolvedAdvisor,
	systemPrompt: string,
	messages: Message[],
	thinkingLevel: import("@earendil-works/pi-ai").ThinkingLevel | undefined,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	try {
		const result = await callAdvisor({
			ctx,
			advisor,
			systemPrompt,
			messages,
			thinkingLevel,
			signal,
			sessionId,
		});
		if (result.stopReason === "error" || result.stopReason === "aborted" || !result.text) {
			return { ok: false, error: result.errorMessage ?? result.stopReason };
		}
		return { ok: true, text: result.text };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

function clampRounds(n: number | undefined): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return 2;
	return Math.max(1, Math.min(4, Math.floor(n)));
}

function emptyDetails(config: BpxConsultConfig): DebateDetails {
	const debateConfig = config.modes?.debate;
	return {
		mode: "debate",
		rounds: clampRounds(debateConfig?.rounds),
		advocate: "(unresolved)",
		critic: "(unresolved)",
		synthesizer: "(unresolved)",
		steps: [],
	};
}

function ok(text: string, details: DebateDetails): AgentToolResult<DebateDetails> {
	return { content: [{ type: "text", text }], details };
}
function err(text: string, details: DebateDetails): AgentToolResult<DebateDetails> {
	return { content: [{ type: "text", text }], details };
}
