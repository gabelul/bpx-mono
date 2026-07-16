/**
 * repairToolPairing + fitToWindow tool-pair integrity.
 *
 * Regression for the bug the live council call caught: the critic seat on
 * Anthropic 400'd with "unexpected tool_use_id found in tool_result blocks —
 * each tool_result must have a corresponding tool_use." The sliding window kept
 * a toolResult in the tail but dropped its toolCall in the middle, orphaning it.
 * repairToolPairing drops orphans in both directions so no provider rejects the
 * fitted context. The fitToWindow test reproduces the exact live failure shape.
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	assistantText,
	fitToWindow,
	repairToolPairing,
	userText,
	type ContextBudget,
} from "../src/context-engine.js";

const BUDGET: ContextBudget = {
	userChars: 2800,
	assistantChars: 1800,
	toolArgChars: 800,
	toolResultChars: 2000,
	keepFirst: 2,
	keepLast: 3,
	responseReserveTokens: 4096,
};

function assistantWithCall(id: string, name = "bash", text = "running it"): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id, name, arguments: {} },
		],
		timestamp: Date.now(),
	} as unknown as Message;
}
function toolResultFor(id: string, text = "done"): Message {
	return { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], timestamp: Date.now() } as unknown as Message;
}

describe("repairToolPairing", () => {
	it("drops an orphan toolResult whose call is absent from the window", () => {
		const repaired = repairToolPairing([userText("hi"), toolResultFor("call-1")]);
		expect(repaired).toHaveLength(1);
		expect(repaired[0]?.role).toBe("user");
	});

	it("drops a dangling toolCall whose result is absent (and removes the emptied assistant)", () => {
		// Assistant has ONLY a toolCall (no text) → after dropping the call, empty → removed.
		const onlyCall = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }], timestamp: 0 } as unknown as Message;
		const repaired = repairToolPairing([userText("hi"), onlyCall]);
		expect(repaired).toHaveLength(1);
		expect(repaired[0]?.role).toBe("user");
	});

	it("keeps a call's text when only the call block is dangling (assistant not emptied)", () => {
		// Assistant has text + a dangling call → text survives, call block dropped.
		const repaired = repairToolPairing([userText("hi"), assistantWithCall("call-1")]);
		expect(repaired).toHaveLength(2);
		const asst = repaired[1];
		expect(asst?.role).toBe("assistant");
		if (asst?.role === "assistant") {
			expect(asst.content.some((b) => b.type === "text")).toBe(true);
			expect(asst.content.some((b) => b.type === "toolCall")).toBe(false);
		}
	});

	it("keeps a fully-paired call + result intact", () => {
		const repaired = repairToolPairing([assistantWithCall("call-1"), toolResultFor("call-1")]);
		expect(repaired).toHaveLength(2);
		expect(repaired[0]?.role).toBe("assistant");
		expect(repaired[1]?.role).toBe("toolResult");
	});

	it("removes only the orphaned pair in a mixed batch", () => {
		// call-1 paired (kept); call-2 result kept but call dropped (orphan).
		const repaired = repairToolPairing([
			userText("start"),
			assistantWithCall("call-1"),
			toolResultFor("call-1"),
			userText("middle"),
			toolResultFor("call-2"), // orphan — call-2 is not in the window
		]);
		expect(repaired.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});

	it("is a no-op when there are no tool calls/results", () => {
		const msgs = [userText("a"), assistantText("b"), userText("c")];
		expect(repairToolPairing(msgs)).toEqual(msgs);
	});

	it("is idempotent", () => {
		const msgs = [userText("a"), assistantWithCall("call-1"), toolResultFor("call-1"), toolResultFor("orphan")];
		const once = repairToolPairing(msgs);
		expect(repairToolPairing(once)).toEqual(once);
	});
});

describe("fitToWindow — tool-pair integrity under truncation (the live bug)", () => {
	it("does not leave an orphan toolResult when the sliding window drops its call", () => {
		// Reproduce the live failure: a long session where keepFirst=2 keeps the
		// first two user messages, keepLast=3 keeps the tail — and the tail holds
		// a toolResult whose toolCall landed in the dropped middle. Before the
		// fix this returned a window with an orphan result → Anthropic 400.
		const big = "x".repeat(4000); // force truncation with a small budget
		const session: Message[] = [
			userText("task framing " + big), // 0 — head
			userText("more framing " + big), // 1 — head
			assistantWithCall("call-1"), // 2 — DROPPED (middle) — holds the call
			toolResultFor("call-1"), // 3 — tail — its result, now orphaned pre-fix
			userText("recent evidence " + big), // 4 — tail
		];

		// Tiny budget so the middle is definitely dropped.
		const fit = fitToWindow(session, BUDGET, /* maxInputTokens */ 1500);

		// No surviving toolResult may reference a call that isn't present.
		const presentCallIds = new Set<string>();
		for (const m of fit.messages) {
			if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall" && typeof b.id === "string") presentCallIds.add(b.id);
		}
		for (const m of fit.messages) {
			if (m.role === "toolResult") {
				expect(presentCallIds.has(m.toolCallId)).toBe(true);
			}
			if (m.role === "assistant") {
				for (const b of m.content) {
					if (b.type === "toolCall") {
						// And no dangling call — its result must be present.
						const hasResult = fit.messages.some((mm) => mm.role === "toolResult" && mm.toolCallId === b.id);
						expect(hasResult).toBe(true);
					}
				}
			}
		}
	});
});
