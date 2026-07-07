/**
 * triggers — automatic consult invocation.
 *
 * Two auto-triggers (SPEC §T):
 *   - onDone:    when the agent finishes a turn, review the work (off by default).
 *   - whenStuck: after N consecutive tool errors OR N identical tool calls
 *                (loop detection), review to get unstuck. Off by default (N = 0);
 *                set whenStuck > 0 in /consult to arm it.
 *
 * Plus manual (always available via the consult tool / /consult).
 *
 * Two traps both passed-and-bypassed (the things the reviewer is watching for):
 *
 *   1. DEADLOCK — never call session-control methods from an event handler.
 *      pi docs say they deadlock the event loop. The triggered consult runs the
 *      advisor call (safe — it's just completeSimple), then routes the result
 *      back via pi.sendUserMessage(text, { deliverAs: "steer" | "followUp" }),
 *      which is the documented non-deadlocking injection path.
 *
 *   2. SELF-TRIGGER — consult() is itself a tool, so it fires its own
 *      tool_result event. Without a guard, a triggered consult re-trips the
 *      loop detector (its own result looks like a repeated call). Two defenses:
 *        a. Skip the fingerprint/error tracking when toolName === "consult".
 *        b. autoRunning re-entrancy guard — while a triggered consult is in
 *           flight, every handler bails, so the consult's own events can't
 *           re-trigger anything.
 *      Counters also reset on before_agent_start (pi's per-prompt reset point).
 *
 * Trust gating: triggers never fire in untrusted projects (an untrusted repo
 * must not be able to silently invoke the advisor / spend tokens).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BpxConsultConfig, ConsultMode } from "./config.js";
import { loadConfig } from "./config.js";
import { executeSolo } from "./solo.js";
import { executeCouncil } from "./council.js";
import { executeDebate } from "./debate.js";
import { deliver } from "./deliver.js";
import { parseConsultPhrase } from "./phrase-trigger.js";
import { CONSULT_TOOL_NAME } from "./messages.js";

interface TriggerState {
	stuckErrors: number;
	lastFingerprint: string;
	loopCount: number;
	autoReviewedThisRound: boolean;
	autoRunning: boolean;
}

function freshState(): TriggerState {
	return { stuckErrors: 0, lastFingerprint: "", loopCount: 0, autoReviewedThisRound: false, autoRunning: false };
}

export function registerTriggers(pi: ExtensionAPI): void {
	// One state slot per registered extension instance. pi loads the extension
	// once per session, so this is effectively per-session. (If pi ever runs
	// extensions across multiple concurrent sessions in one process, this would
	// need to key by session id — not the case today.)
	const state = freshState();

	// Reset point: clear all counters at the start of each user prompt so a
	// previous turn's stuck-state can't bleed into the next one.
	pi.on("before_agent_start", () => {
		state.stuckErrors = 0;
		state.loopCount = 0;
		state.lastFingerprint = "";
		// NOTE: autoReviewedThisRound is reset here too, but autoRunning must NOT
		// be — if a triggered consult is still in flight when the next prompt
		// starts (rare but possible), clearing autoRunning would allow re-entry.
		if (!state.autoRunning) state.autoReviewedThisRound = false;
	});

	// Phrase-trigger: a user typing "ask the council", "second opinion", etc.
	// fires the matched mode directly. This is USER-initiated, so it is NOT
	// subject to the model's per-turn consult cap. We reuse the autoRunning guard
	// so a phrase-triggered consult's own tool_result can't re-trip the detectors,
	// and so two phrases in flight can't stampede.
	//
	// Show-mode suppression: the pi InputEventResult supports { action: "handled" },
	// which stops the agent run for this input. When feedbackMode is "show" we use
	// it — "show me, don't act" actually halts the turn and we render UI-only.
	// For steer/pipe we return { action: "continue" } and inject via deliver().
	pi.on("input", async (event, ctx) => {
		// Only genuine user typing fires phrases. Extension-sourced input (our own
		// injections) must never re-trigger.
		if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
		if (state.autoRunning) return { action: "continue" };

		const parsed = parseConsultPhrase(event.text);
		if (!parsed) return { action: "continue" };

		const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (!config.enabled) return { action: "continue" };
		if (!ctx.isProjectTrusted()) return { action: "continue" }; // trust gate

		const feedbackMode = config.feedbackMode ?? "steer";

		state.autoRunning = true;
		try {
			const result = await runMode(parsed.mode, { ctx, config, signal: ctx.signal, onUpdate: undefined, question: parsed.question ?? event.text });
			const text = extractText(result);
			if (text) deliver(pi, text, feedbackMode);
		} catch {
			// A failed phrase consult must never break the user's input.
		} finally {
			state.autoRunning = false;
		}

		// show suppresses the agent run entirely; steer/pipe let it proceed (deliver
		// already queued the message).
		return feedbackMode === "show" ? { action: "handled" } : { action: "continue" };
	});

	// whenStuck: fires on the tool_result event (after we know isError + input).
	pi.on("tool_result", async (event, ctx) => {
		// Self-trigger guard (a): our own consult tool's results don't count.
		if (event.toolName === CONSULT_TOOL_NAME) return;

		// Re-entrancy + config gates. Bail fast on every condition that disables
		// the trigger — never let an auto-trigger break the turn.
		if (state.autoRunning) return;
		const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (!config.enabled) return;
		if (!ctx.isProjectTrusted()) return; // trust gate
		const whenStuck = config.triggers?.whenStuck ?? 0;
		if (whenStuck <= 0) return;

		// Loop-detect fingerprint: toolName + full input, UN-TRUNCATED.
		// (pi-extensions CHANGELOG: an earlier 120-char cap broke detection by
		// collapsing distinct calls with shared prefixes into false matches.)
		const fingerprint = `${event.toolName}:${JSON.stringify(event.input ?? "")}`;
		if (fingerprint === state.lastFingerprint) {
			state.loopCount++;
		} else {
			state.lastFingerprint = fingerprint;
			state.loopCount = 1;
		}

		// Error tracking.
		if (event.isError) state.stuckErrors++;
		else state.stuckErrors = 0;

		// Error trigger: N consecutive errors.
		if (state.stuckErrors >= whenStuck) {
			state.stuckErrors = 0;
			state.loopCount = 0;
			state.lastFingerprint = "";
			await runTriggeredConsult(
				pi, ctx, config, state,
				(text) =>
					`The agent has hit ${whenStuck} consecutive tool errors. An advisor model was consulted:\n\n${text}\n\nUse this to get unstuck.`,
				"steer",
			);
			return;
		}

		// Loop trigger: same tool + identical arguments repeated N times.
		if (state.loopCount >= whenStuck) {
			state.loopCount = 0;
			state.lastFingerprint = "";
			await runTriggeredConsult(
				pi, ctx, config, state,
				(text) =>
					`The agent appears to be stuck in a loop (repeated tool "${event.toolName}" with identical arguments). An advisor model was consulted:\n\n${text}\n\nUse this to get unstuck.`,
				"steer",
			);
		}
	});

	// onDone: fires when the agent finishes the turn.
	pi.on("agent_end", async (_event, ctx) => {
		if (state.autoRunning) return;
		const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (!config.enabled) return;
		if (!ctx.isProjectTrusted()) return;
		const onDone = config.triggers?.onDone ?? false;
		if (!onDone) return;
		if (state.autoReviewedThisRound) return; // at most one auto-review per prompt

		state.autoReviewedThisRound = true;
		await runTriggeredConsult(
			pi, ctx, config, state,
			(text) =>
				`Before finishing, an advisor model assessed your work:\n\n${text}\n\n` +
				`If it raises valid issues, address them; otherwise briefly confirm and stop.`,
			"followUp",
		);
	});
}

/**
 * Run one triggered consult and inject the result via sendUserMessage.
 *
 * The consult itself (executeSolo/executeCouncil) is safe to call from a
 * handler — it does its own completeSimple and returns. What's NOT safe is
 * calling session-control methods (those deadlock); we avoid that by using
 * pi.sendUserMessage({ deliverAs }) which is the documented injection path.
 *
 * Re-entrancy: autoRunning is set for the duration so the consult's own
 * tool_result event can't re-trip the detectors. try/finally so a thrown
 * consult error can't leave autoRunning stuck true.
 */
async function runTriggeredConsult(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: BpxConsultConfig,
	state: TriggerState,
	buildMessage: (text: string) => string,
	deliverAs: "steer" | "followUp",
): Promise<void> {
	state.autoRunning = true;
	try {
		// Auto-triggers ALWAYS run solo, regardless of defaultMode (§T). Rationale:
		// an auto-fire is not a deliberate consultation — it's a safety net firing
		// mid-turn. A council would burn 3+ model calls + synthesis per trigger,
		// which is a surprise-quota footgun on a loop or repeated errors. Council
		// is reserved for explicit invocation (mode:council tool arg, /consult).
		const result = await executeSolo({ ctx, config, signal: ctx.signal, onUpdate: undefined });

		// Extract text from the tool result content blocks.
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (text) {
			await pi.sendUserMessage(buildMessage(text), { deliverAs });
		}
	} catch {
		// never let an auto-trigger break the turn
	} finally {
		state.autoRunning = false;
	}
}

/** Shared shape for dispatching any consult mode (matches the execute* inputs). */
interface RunModeInput {
	ctx: ExtensionContext;
	config: BpxConsultConfig;
	signal: AbortSignal | undefined;
	onUpdate: undefined;
	question?: string;
}

/**
 * Dispatch a consult mode through the existing execute* functions.
 *
 * Every path routes through executeSolo/executeCouncil/executeDebate so the §I
 * context re-fit invariant holds — no mode gets a raw advisor call. gut-check
 * reuses the same solo-model-override trick index.ts uses so it hits the cheap
 * gutCheck model.
 *
 * @param mode - the resolved consult mode
 * @param input - ctx/config/signal/question passed straight to the executor
 * @returns the mode's tool result (details type varies per mode)
 */
async function runMode(mode: ConsultMode, input: RunModeInput): Promise<AgentToolResult<unknown>> {
	if (mode === "council") return executeCouncil(input);
	if (mode === "debate") return executeDebate(input);
	if (mode === "gut-check") {
		const gutCheck = input.config.modes?.gutCheck;
		if (gutCheck?.model) {
			const gutConfig = {
				...input.config,
				modes: { ...input.config.modes, solo: { ...input.config.modes?.solo, ...gutCheck } },
			};
			return executeSolo({ ...input, config: gutConfig });
		}
		return executeSolo(input);
	}
	return executeSolo(input);
}

/** Pull the plain-text content out of a tool result's content blocks. */
function extractText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}
