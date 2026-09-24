/**
 * solo — the default consult mode.
 *
 * One advisor model, one response. The rpiv-advisor experience, but routed
 * through the context engine so it never overflows the advisor's window.
 *
 * Flow:
 *   config → resolve solo model → build compacted session context → re-fit to
 *   the advisor's window (context-engine) → callAdvisor → return as tool result
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionContext,
	buildSessionContext,
	convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callAdvisor, resolveAdvisor, type ConsultCallResult } from "./advisor.js";
import { buildConsultContext, summarizeLedger, type ContextBudget, type LedgerSummary } from "./context-engine.js";
import type { BpxConsultConfig } from "./config.js";
import { resolveSeatRoute } from "./route.js";
import { callCliAdvisor } from "./cli-backend.js";
import { ConsultUsage } from "./usage.js";
import { withoutLegacyShowMessages } from "./deliver.js";
import type { SelectedAttachment } from "./attachments.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_API_KEY,
	ERR_NO_API_KEY_DETAIL,
	ERR_NO_MODEL,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	msgConsulting,
} from "./messages.js";

// Bug A: retry the inline call when the provider rejects the payload as too
// long, shrinking the effective window each attempt. The deriveInputBudget
// margin makes this rare; this is the safety net for residual overshoot
// (pathological dense content, a provider limit lower than the registry's
// declared window). CLIs don't emit a structured too-long error, so this is
// inline-only.
const TOO_LONG_RE = /prompt is too long|context length|maximum context|too long|exceeds the/i;
const MAX_TOO_LONG_RETRIES = 2;

/** Does this advisor error message indicate the payload exceeded the provider's
 * context limit? Pure so the matching logic is unit-testable against real
 * provider error strings without a live call. */
export function isTooLongError(errorMessage: string | undefined): boolean {
	return !!errorMessage && TOO_LONG_RE.test(errorMessage);
}

// Load the system prompt once, with a fallback so a missing/unreadable file
// never bricks the extension at import time. Bundled at prompts/advisor-system.txt.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const ADVISOR_SYSTEM_PROMPT = (() => {
	const fallback =
		"You are an advisor model consulted mid-task by a coding executor. Return a PLAN, a CORRECTION, or a STOP signal. Be concrete, cite specifics, never call tools, never manufacture agreement.";
	try {
		return readFileSync(join(__dirname, "..", "prompts", "advisor-system.txt"), "utf-8").trim() || fallback;
	} catch {
		return fallback;
	}
})();

export interface SoloDetails {
	advisorModel: string;
	thinkingLevel?: string;
	mode: "solo";
	usage?: { input: number; output: number; total: number };
	/** Estimated input tokens after the context engine re-fit. */
	fittedTokens?: number;
	/** Messages dropped by the sliding window, if any. */
	omitted?: number;
	/**
	 * Compact §E.0 evidence-ledger roll-up: how many messages the fit kept,
	 * compressed to signals, clipped to anchors, or dropped. The measurement
	 * instrument (§E gate) — read these across real sessions before building
	 * §E.2–§E.4.
	 */
	ledger?: LedgerSummary;
	stopReason?: string;
	errorMessage?: string;
}

function ok(text: string, details: SoloDetails): AgentToolResult<SoloDetails> {
	return { content: [{ type: "text", text }], details };
}

function err(text: string, details: SoloDetails): AgentToolResult<SoloDetails> {
	return { content: [{ type: "text", text }], details };
}

export interface ExecuteSoloInput {
	ctx: ExtensionContext;
	config: BpxConsultConfig;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<SoloDetails> | undefined;
	/** Optional explicit question to inject at the tail of the context. */
	question?: string;
	attachments?: readonly SelectedAttachment[];
}

export async function executeSolo(input: ExecuteSoloInput): Promise<AgentToolResult<SoloDetails>> {
	const { ctx, config, signal, onUpdate, question, attachments } = input;

	const soloConfig = config.modes?.solo;
	const thinkingLevel = soloConfig?.thinkingLevel;
	const route = resolveSeatRoute(config, { ...soloConfig, model: soloConfig?.model }, (key) => resolveAdvisor(ctx, key));
	if (route.kind === "error") {
		return err(ERR_NO_MODEL, { advisorModel: "(none)", mode: "solo", thinkingLevel, errorMessage: route.message });
	}

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(route.label) }],
		details: { advisorModel: route.label, thinkingLevel, mode: "solo" },
	});

	// 1. Pull Pi's already-compacted session context for the active branch.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages: Message[] = convertToLlm(withoutLegacyShowMessages(sessionMessages));

	// 2. Re-fit to THIS advisor's window. This is the §P fix.
	const contextBudget = config.contextBudget as ContextBudget;
	// terse: cap the response hard so gut-check gets a short read, not an essay.
	// Honored when gut-check merges its config into solo (modes.gutCheck.terse).
	const maxTokens = soloConfig?.terse ? Math.min(1024, contextBudget.responseReserveTokens) : contextBudget.responseReserveTokens;
	const advisorWindow = route.contextWindow;
	const directive = [question?.trim() ? `Specific question from the executor: ${question.trim()}` : undefined,
		soloConfig?.terse ? "Give a short, direct answer." : undefined].filter(Boolean).join("\n\n") || undefined;

	let fit = buildConsultContext({
		sessionMessages: branchMessages,
		advisorContextWindow: advisorWindow,
		budget: contextBudget,
		directive,
		attachments,
	});
	const ledgerSummary = summarizeLedger(fit.ledger);

	// Fail-closed (§E.1 RULE B): the context engine couldn't fit even the minimal
	// pinned evidence into this advisor's window. Surface a clean error rather than
	// forwarding an oversized payload — forwarding would reopen the exact §P
	// overflow this extension exists to prevent.
	if (fit.error) {
		return err(`Couldn't fit the advisor window: ${fit.error}`, {
			advisorModel: route.label,
			thinkingLevel,
			mode: "solo",
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			ledger: ledgerSummary,
			errorMessage: fit.error,
		});
	}

	const usageTracker = new ConsultUsage();
	try {
		// Backend dispatch: if the solo model has a CLI backend configured, route
		// to the async subprocess path (spawn the CLI, pipe the fitted context to
		// stdin, parse the reply). Otherwise inline completeSimple. The fitted
		// context is reused either way — §C ran once, both backends get the same
		// window-safe payload. CLI uses spawn (non-blocking) so a CLI-backed council
		// member can run parallel to an inline one (the whole point of async).
		let text: string;
		let usage: { input: number; output: number; total: number } | undefined;
		let stopReason: string;
		let errorMessage: string | undefined;

		if (route.kind === "cli") {
			const cliResult = await callCliAdvisor({
				systemPrompt: ADVISOR_SYSTEM_PROMPT,
				messages: fit.messages,
				backend: route.backend,
				signal,
				cwd: ctx.cwd,
				responseReserveTokens: contextBudget.responseReserveTokens,
			});
			text = cliResult.text;
			usage = undefined; // CLIs don't report token usage
			stopReason = cliResult.text ? "stop" : cliResult.timedOut ? "aborted" : "error";
			errorMessage = cliResult.errorMessage;
		} else {
			const advisor = route.advisor;
			// Inline path with too-long retry (Bug A). deriveInputBudget already
			// subtracts a 10% uncertainty margin so overshoot is rare; a residual
			// too-long shrinks the window and retries up to MAX_TOO_LONG_RETRIES times.
			let effectiveWindow = advisorWindow;
			let result: ConsultCallResult;
			for (let attempt = 0; ; attempt++) {
				const attemptFit = attempt === 0
					? fit
					: buildConsultContext({ sessionMessages: branchMessages, advisorContextWindow: effectiveWindow, budget: contextBudget, directive, attachments });
				if (attemptFit.error) {
					return usageTracker.attach(err(`Couldn't fit the advisor window: ${attemptFit.error}`, {
						advisorModel: advisor.label, thinkingLevel, mode: "solo",
						fittedTokens: attemptFit.estimatedTokens, omitted: attemptFit.omittedCount,
						ledger: summarizeLedger(attemptFit.ledger), errorMessage: attemptFit.error,
					}));
				}
				result = await callAdvisor({
					ctx, advisor, systemPrompt: ADVISOR_SYSTEM_PROMPT, messages: attemptFit.messages,
					thinkingLevel, signal, sessionId: ctx.sessionManager.getSessionId(), maxTokens, onUsage: usageTracker.record,
				});
				const tooLong = isTooLongError(result.errorMessage);
				if (!tooLong || attempt >= MAX_TOO_LONG_RETRIES) {
					fit = attemptFit; // reflect the final (possibly shrunk) fit in details
					break;
				}
				effectiveWindow = Math.floor(effectiveWindow * 0.8);
			}
			text = result.text;
			usage = result.usage;
			stopReason = result.stopReason;
			errorMessage = result.errorMessage;
		}

		const baseDetails: SoloDetails = {
			advisorModel: route.label,
			thinkingLevel,
			mode: "solo",
			usage,
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			ledger: summarizeLedger(fit.ledger),
			stopReason,
			errorMessage,
		};

		if (stopReason === "aborted") {
			return usageTracker.attach(err(ERR_CALL_ABORTED, { ...baseDetails, errorMessage: errorMessage ?? ERR_ABORTED_DETAIL }));
		}
		if (stopReason === "error") {
			return usageTracker.attach(err(errCallFailed(errorMessage), baseDetails));
		}
		if (!text) {
			return usageTracker.attach(err(ERR_EMPTY_RESPONSE, { ...baseDetails, errorMessage: ERR_EMPTY_RESPONSE_DETAIL }));
		}

		return usageTracker.attach(ok(text, baseDetails));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return usageTracker.attach(err(errCallThrew(message), {
			advisorModel: route.label,
			thinkingLevel,
			mode: "solo",
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			ledger: ledgerSummary,
			errorMessage: message,
		}));
	}
}

// Re-export the auth-error helpers so index.ts can use them without importing
// from two places. (kept for the registration layer's error paths.)
export { ERR_NO_API_KEY, ERR_NO_API_KEY_DETAIL, errMisconfigured };
