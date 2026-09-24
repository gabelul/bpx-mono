/**
 * deliver — route a consult result to the executor per feedbackMode.
 *
 * This ONLY covers the paths where bpx-consult injects on the user's behalf:
 * the phrase-trigger and any manual standalone run. The model's own consult()
 * tool call does NOT go through here — it asked for the advice, so it always
 * gets a normal tool result back (see index.ts). Auto-triggers (whenStuck/onDone)
 * also don't use this; they have their own steer/followUp wiring in triggers.ts.
 *
 * The three modes (verified against the pi types in
 * `@earendil-works/pi-coding-agent` — sendUserMessage.deliverAs is
 * "steer" | "followUp" only, NOT "nextTurn"):
 *   - steer → sendUserMessage(text, { deliverAs: "steer" })  — nudge mid-run
 *   - pipe  → sendUserMessage(text, { deliverAs: "followUp" }) — queue as if the
 *             user typed it; "followUp" is pi's value for a plain queued user
 *             message ("steer" cuts in mid-stream, "followUp" waits its turn).
 *   - show  → a non-context session entry and UI notification. Legacy custom
 *             messages need filtering because Pi forwards them on later turns.
 */

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import type { FeedbackMode } from "./config.js";

/** Historical show-message key; Pi may forward these messages as user context. */
export const CONSULT_MESSAGE_TYPE = "bpx-consult";
export const CONSULT_LOCAL_RESULT_TYPE = "bpx-consult-local-result";

/** Remove only historical show messages before Pi or an advisor sees context. */
export function withoutLegacyShowMessages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
	return messages.filter((message) => !(message.role === "custom" && message.customType === CONSULT_MESSAGE_TYPE));
}

/**
 * Keep historical show messages readable after a session reload. New show
 * results use non-context entries instead; Pi 0.80.2 cannot render those inline.
 *
 * @param pi - the extension API to register the renderer on
 */
export function registerConsultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(CONSULT_MESSAGE_TYPE, (message, _opts, theme) => {
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(
			new Markdown(
				`**Earlier consult feedback**\n\n${String(message.content ?? "")}`,
				0,
				0,
				getMarkdownTheme(),
			),
		);
		return box;
	});
}

/**
 * Store advice outside model context and display it only in the originating UI.
 * The active branch retains it for /consult result; it is not an executor message.
 */
export function showConsultation(pi: ExtensionAPI, ctx: ExtensionContext, id: string, mode: string, text: string): void {
	if (!ctx.hasUI) throw new Error("Show feedback requires an interactive or RPC UI.");
	pi.appendEntry(CONSULT_LOCAL_RESULT_TYPE, { id, mode, text });
	ctx.ui.notify(`${mode} · ${id} · for you only\n\n${text}`, "info");
}

/** Inject steer/pipe advice into the executor; show has no model-facing route. */
export function deliver(pi: ExtensionAPI, text: string, mode: Exclude<FeedbackMode, "show">): void {
	const deliverAs = mode === "steer" ? "steer" : "followUp";
	pi.sendUserMessage(text, { deliverAs });
}
