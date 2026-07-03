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
import { callAdvisor, resolveAdvisor } from "./advisor.js";
import { buildConsultContext, type ContextBudget } from "./context-engine.js";
import type { BpxConsultConfig } from "./config.js";
import { resolveBackend } from "./config.js";
import { callCliAdvisor } from "./cli-backend.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_API_KEY,
	ERR_NO_API_KEY_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_DETAIL,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	msgConsulting,
} from "./messages.js";

// Load the system prompt once, with a fallback so a missing/unreadable file
// never bricks the extension at import time. Bundled at prompts/advisor-system.txt.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ADVISOR_SYSTEM_PROMPT = (() => {
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
}

export async function executeSolo(input: ExecuteSoloInput): Promise<AgentToolResult<SoloDetails>> {
	const { ctx, config, signal, onUpdate, question } = input;

	const soloConfig = config.modes?.solo;
	const advisor = resolveAdvisor(ctx, soloConfig?.model);
	const thinkingLevel = soloConfig?.thinkingLevel;

	if (!advisor) {
		return err(ERR_NO_MODEL, { advisorModel: "(none)", mode: "solo", thinkingLevel, errorMessage: ERR_NO_MODEL_DETAIL });
	}

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisor.label) }],
		details: { advisorModel: advisor.label, thinkingLevel, mode: "solo" },
	});

	// 1. Pull Pi's already-compacted session context for the active branch.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages: Message[] = convertToLlm(sessionMessages);

	// 2. Re-fit to THIS advisor's window. This is the §P fix.
	const contextBudget = config.contextBudget as ContextBudget;
	// terse: cap the response hard so gut-check gets a short read, not an essay.
	// Honored when gut-check merges its config into solo (modes.gutCheck.terse).
	const maxTokens = soloConfig?.terse ? Math.min(1024, contextBudget.responseReserveTokens) : contextBudget.responseReserveTokens;
	const advisorWindow = advisor.model.contextWindow;
	const directive = question?.trim()
		? `Specific question from the executor: ${question.trim()}`
		: undefined;

	const fit = buildConsultContext({
		sessionMessages: branchMessages,
		advisorContextWindow: advisorWindow,
		budget: contextBudget,
		directive,
	});

	try {
		// Backend dispatch: if the solo model has a CLI backend configured, route
		// to the async subprocess path (spawn the CLI, pipe the fitted context to
		// stdin, parse the reply). Otherwise inline completeSimple. The fitted
		// context is reused either way — §C ran once, both backends get the same
		// window-safe payload. CLI uses spawn (non-blocking) so a CLI-backed council
		// member can run parallel to an inline one (the whole point of async).
		const backend = resolveBackend(config, soloConfig?.model);
		let text: string;
		let usage: { input: number; output: number; total: number } | undefined;
		let stopReason: string;
		let errorMessage: string | undefined;

		if (backend?.type === "cli") {
			const cliResult = await callCliAdvisor({
				systemPrompt: ADVISOR_SYSTEM_PROMPT,
				messages: fit.messages,
				backend: { type: "cli", command: backend.command, args: backend.args, timeoutMs: backend.timeoutMs },
				signal,
				cwd: ctx.cwd,
			});
			text = cliResult.text;
			usage = undefined; // CLIs don't report token usage
			stopReason = cliResult.text ? "stop" : cliResult.timedOut ? "aborted" : "error";
			errorMessage = cliResult.errorMessage;
		} else {
			const result = await callAdvisor({
				ctx,
				advisor,
				systemPrompt: ADVISOR_SYSTEM_PROMPT,
				messages: fit.messages,
				thinkingLevel,
				signal,
				sessionId: ctx.sessionManager.getSessionId(),
				maxTokens,
			});
			text = result.text;
			usage = result.usage;
			stopReason = result.stopReason;
			errorMessage = result.errorMessage;
		}

		const baseDetails: SoloDetails = {
			advisorModel: advisor.label,
			thinkingLevel,
			mode: "solo",
			usage,
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			stopReason,
			errorMessage,
		};

		if (stopReason === "aborted") {
			return err(ERR_CALL_ABORTED, { ...baseDetails, errorMessage: errorMessage ?? ERR_ABORTED_DETAIL });
		}
		if (stopReason === "error") {
			return err(errCallFailed(errorMessage), baseDetails);
		}
		if (!text) {
			return err(ERR_EMPTY_RESPONSE, { ...baseDetails, errorMessage: ERR_EMPTY_RESPONSE_DETAIL });
		}

		return ok(text, baseDetails);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err(errCallThrew(message), {
			advisorModel: advisor.label,
			thinkingLevel,
			mode: "solo",
			fittedTokens: fit.estimatedTokens,
			omitted: fit.omittedCount,
			errorMessage: message,
		});
	}
}

// Re-export the auth-error helpers so index.ts can use them without importing
// from two places. (kept for the registration layer's error paths.)
export { ERR_NO_API_KEY, ERR_NO_API_KEY_DETAIL, errMisconfigured };
