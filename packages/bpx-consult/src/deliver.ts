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
 *   - show  → UI-only via a registered message renderer; nothing reaches the model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import type { FeedbackMode } from "./config.js";

/** customType key for the show-mode UI-only renderer. */
export const CONSULT_MESSAGE_TYPE = "bpx-consult";

/**
 * Register the show-mode renderer. Ported from pi-advisor's "advisor" renderer,
 * relabelled for bpx-consult. Renders the advice as markdown in a boxed message
 * clearly marked "not sent to the model" so there's no confusion about whether
 * the executor saw it. Call once at extension load.
 *
 * @param pi - the extension API to register the renderer on
 */
export function registerConsultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(CONSULT_MESSAGE_TYPE, (message, _opts, theme) => {
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(
			new Markdown(
				`**Consult feedback (not sent to the model)**\n\n${String(message.content ?? "")}`,
				0,
				0,
				getMarkdownTheme(),
			),
		);
		return box;
	});
}

/**
 * Deliver consult advice to the executor honoring feedbackMode.
 *
 * For steer/pipe this injects a user message; for show it renders UI-only and
 * returns without sending anything to the model.
 *
 * @param pi - the extension API (for sendUserMessage / sendMessage)
 * @param text - the advice text to deliver (already assembled)
 * @param mode - the resolved feedback mode
 */
export function deliver(pi: ExtensionAPI, text: string, mode: FeedbackMode): void {
	if (mode === "show") {
		// UI-only: display it, never send to the model.
		pi.sendMessage({ customType: CONSULT_MESSAGE_TYPE, content: text, display: true });
		return;
	}

	// steer cuts in mid-run; pipe (→ followUp) queues as a plain user message.
	const deliverAs = mode === "steer" ? "steer" : "followUp";
	pi.sendUserMessage(text, { deliverAs });
}
