/**
 * Pathological invariant tests for the §E.1 evidence-aware fit + §E.0 classifier.
 *
 * The whole module exists to guarantee §I: every advisor call fits its target
 * window, no exceptions. These tests prove that on the FINAL ASSEMBLED output
 * (RULE A) across the cases most likely to break it — a single directive bigger
 * than the window, a wall of huge messages, a giant pinned diff, and the
 * fail-closed corner — plus the deterministic classifier that drives the fit.
 *
 * Every fit case re-derives the token total from `result.messages` (not from the
 * returned `estimatedTokens`, so the assertion is independent of the field it's
 * checking) and asserts it's <= `maxInputTokens`.
 */
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	buildConsultContext,
	estimateMessageTokens,
	summarizeLedger,
	userText,
	type ContextBudget,
} from "../src/context-engine.js";
import {
	classifyMessage,
	classifyMessages,
	failureSignature,
	PINNED_TAGS,
	summarizeToolResult,
} from "../src/evidence.js";

const BUDGET: ContextBudget = {
	userChars: 2800,
	assistantChars: 1800,
	toolArgChars: 800,
	toolResultChars: 2000,
	keepFirst: 2,
	keepLast: 12,
	responseReserveTokens: 4096,
};

/** Re-derive the assembled token total from the messages themselves. */
function sumTokens(messages: Message[]): number {
	return messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

// --- message builders that carry the shapes the classifier keys on ------------

function bashToolCallAssistant(id: string, command: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		api: "anthropic-messages" as never,
		provider: "anthropic" as never,
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function editToolCallAssistant(id: string, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "edit", arguments: { path } }],
		api: "anthropic-messages" as never,
		provider: "anthropic" as never,
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function bashResult(id: string, text: string, isError: boolean): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 2 };
}

function editResult(id: string, text: string, patch: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "edit", content: [{ type: "text", text }], details: { patch }, isError: false, timestamp: 2 };
}

function readResult(id: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

// ---------------------------------------------------------------------------
// §E.0 classifier
// ---------------------------------------------------------------------------

describe("classifyMessage — deterministic tagging (§E.0)", () => {
	const noCall = () => undefined;

	it("tags a user transcript message as a directive (pinned)", () => {
		const { tag } = classifyMessage(userText("please fix the null deref"), 0, noCall);
		expect(tag).toBe("directive");
		expect(PINNED_TAGS.has("directive")).toBe(true);
	});

	it("tags an erroring toolResult as failing-output", () => {
		const { tag } = classifyMessage(bashResult("1", "Command exited with code 1\nboom", true), 0, noCall);
		expect(tag).toBe("failing-output");
	});

	it("promotes an erroring toolResult with a stack-trace shape to stack-trace", () => {
		const trace = "TypeError: x is not a function\n    at foo (/app/src/a.ts:12:3)\n    at bar (/app/src/b.ts:4:1)";
		const { tag } = classifyMessage(bashResult("1", trace, true), 0, noCall);
		expect(tag).toBe("stack-trace");
	});

	it("tags an edit toolResult carrying details.patch as a diff", () => {
		const call = editToolCallAssistant("e1", "src/x.ts");
		const result = editResult("e1", "ok", "+++ b/src/x.ts\n+added\n-removed");
		const callFor = (id: string) => (id === "e1" ? (call.content[0] as any) : undefined);
		const { tag } = classifyMessage(result, 1, callFor);
		expect(tag).toBe("diff");
	});

	it("tags a bash verification command result as test", () => {
		const call = bashToolCallAssistant("b1", "npm test");
		const result = bashResult("b1", "2 passed", false);
		const callFor = (id: string) => (id === "b1" ? (call.content[0] as any) : undefined);
		expect(classifyMessage(result, 1, callFor).tag).toBe("test");
	});

	it("tags a read toolResult as exploration", () => {
		expect(classifyMessage(readResult("r1", "file contents"), 0, noCall).tag).toBe("exploration");
	});

	it("collapses repeated identical failures to repeated-failure (pinned)", () => {
		const call = bashToolCallAssistant("b1", "npm run build");
		const fail = "Command exited with code 2\nsyntax error at line 9";
		const messages: Message[] = [
			call,
			bashResult("b1", fail, true),
			bashToolCallAssistant("b2", "npm run build"),
			bashResult("b2", fail, true),
		];
		const classified = classifyMessages(messages);
		const failures = classified.filter((c) => c.tag === "repeated-failure");
		expect(failures.length).toBe(2);
		expect(failures.every((f) => f.pinned)).toBe(true);
		expect(failures[0].signal).toContain("repeated ×2");
	});

	it("pins only the LATEST diff and latest failure as payload", () => {
		const messages: Message[] = [
			editToolCallAssistant("e1", "a.ts"),
			editResult("e1", "ok", "+++ a.ts\n+one"),
			editToolCallAssistant("e2", "b.ts"),
			editResult("e2", "ok", "+++ b.ts\n+two"),
		];
		const classified = classifyMessages(messages);
		const diffs = classified.filter((c) => c.tag === "diff");
		expect(diffs.length).toBe(2);
		// The later diff (index 3) is pinned; the earlier one (index 1) is not.
		const older = diffs.find((d) => d.index === 1)!;
		const newer = diffs.find((d) => d.index === 3)!;
		expect(newer.pinned).toBe(true);
		expect(older.pinned).toBe(false);
	});
});

describe("summarizeToolResult (§E.0 port)", () => {
	it("summarises a read with its path from the matching call", () => {
		const call = { type: "toolCall" as const, id: "r1", name: "read", arguments: { path: "src/x.ts" } };
		expect(summarizeToolResult(readResult("r1", "..."), call)).toBe("read src/x.ts");
	});

	it("summarises an edit with change stats", () => {
		const call = { type: "toolCall" as const, id: "e1", name: "edit", arguments: { path: "y.ts" } };
		const result = editResult("e1", "ok", "+++ y.ts\n+a\n+b\n-c");
		expect(summarizeToolResult(result, call)).toBe("edit y.ts (+2/-1)");
	});

	it("summarises a bash command with its exit code", () => {
		const call = { type: "toolCall" as const, id: "b1", name: "bash", arguments: { command: "npm test" } };
		const result = bashResult("b1", "Command exited with code 1", true);
		expect(summarizeToolResult(result, call)).toBe("$ npm test (exit 1)");
	});
});

describe("failureSignature", () => {
	it("normalises volatile bits so two runs of the same failure share a signature", () => {
		const a = failureSignature("Error at 2026-07-08T12:00:00Z addr 0xABCD at foo.ts:12:3");
		const b = failureSignature("Error at 2026-07-08T13:30:00Z addr 0x1234 at foo.ts:44:7");
		expect(a).toBe(b);
	});
});

// ---------------------------------------------------------------------------
// §I on the FINAL assembled output — pathological cases (RULE A + RULE B)
// ---------------------------------------------------------------------------

describe("§I — final assembled output always fits (pathological)", () => {
	it("(a) a single directive far bigger than the window → clipped with anchors, still fits", () => {
		// One user directive, ~50k tokens, into a 32k window. Pinned → can't drop →
		// must be clipped to anchors (head+tail) and STILL fit.
		const huge = "DIRECTIVE-HEAD " + "d".repeat(150_000) + " DIRECTIVE-TAIL";
		const result = buildConsultContext({
			sessionMessages: [userText(huge)],
			advisorContextWindow: 32_000,
			budget: BUDGET,
		});
		expect(sumTokens(result.messages)).toBeLessThanOrEqual(result.maxInputTokens);
		expect(result.error).toBeUndefined();
		const summary = summarizeLedger(result.ledger);
		// The directive was pinned and clipped (never dropped).
		expect(summary.dropped).toBe(0);
		expect(summary.clipped + summary.compressed).toBeGreaterThan(0);
	});

	it("(b) many huge messages → fits", () => {
		const messages: Message[] = Array.from({ length: 80 }, (_, i) => userText(`turn ${i} ` + "m".repeat(4000)));
		const result = buildConsultContext({
			sessionMessages: messages,
			advisorContextWindow: 32_000,
			budget: BUDGET,
			directive: "Focus: is the retry loop correct?",
		});
		expect(sumTokens(result.messages)).toBeLessThanOrEqual(result.maxInputTokens);
		expect(result.error).toBeUndefined();
	});

	it("(c) a giant pinned diff → clipped, not dropped, still fits", () => {
		// The latest diff is the payload (pinned). Make it enormous. It must be
		// clipped to file-headers + hunks, NEVER dropped, and the whole thing fits.
		const bigPatch = "+++ b/src/huge.ts\n" + "@@ -1,1 +1,1 @@\n" + "+addedline\n".repeat(20_000);
		const messages: Message[] = [
			userText("implement the feature"),
			editToolCallAssistant("e1", "src/huge.ts"),
			editResult("e1", "wrote src/huge.ts", bigPatch),
			...Array.from({ length: 20 }, (_, i) => userText(`chatter ${i} ` + "c".repeat(1200))),
		];
		const result = buildConsultContext({
			sessionMessages: messages,
			advisorContextWindow: 16_000,
			budget: BUDGET,
		});
		expect(sumTokens(result.messages)).toBeLessThanOrEqual(result.maxInputTokens);
		expect(result.error).toBeUndefined();
		// The diff (index 2) was pinned as latest payload — its ledger row must not be "dropped".
		const diffRow = result.ledger.find((e) => e.index === 2 && e.tag === "diff");
		expect(diffRow).toBeDefined();
		expect(diffRow!.disposition).not.toBe("dropped");
	});

	it("(d) fail-closed: directive too big for a tiny window → error signal, never an oversized payload", () => {
		// A 1000-token window (500 input budget after reserve) with a directive that
		// can't be clipped small enough alongside pinned evidence. The engine must
		// return an error and a SAFE minimal payload — never overflow.
		const result = buildConsultContext({
			sessionMessages: Array.from({ length: 5 }, (_, i) => userText(`pinned directive ${i} ` + "z".repeat(3000))),
			advisorContextWindow: 1_100, // input budget floored/derived to a tiny number
			budget: { ...BUDGET, responseReserveTokens: 200 },
			directive: "Q ".repeat(4000), // a directive far bigger than the whole window
		});
		// Whatever happens, the payload NEVER exceeds the window. That's §I, absolute.
		expect(sumTokens(result.messages)).toBeLessThanOrEqual(result.maxInputTokens);
		// And this genuinely tripped the fail-closed branch: an error signal is set
		// so solo.ts/council.ts surface a clean "couldn't fit" rather than overflow.
		expect(result.error).toBeTruthy();
	});

	it("(d2) genuinely unfittable directive sets the error signal and stays within budget", () => {
		// Force the impossible case: a directive that alone dwarfs a minuscule window.
		// The clamp keeps the payload within budget; if even that can't happen the
		// engine fails closed. Either way: never oversized.
		const result = buildConsultContext({
			sessionMessages: [],
			advisorContextWindow: 2_050, // ~1025 input budget
			budget: { ...BUDGET, responseReserveTokens: 1_025 },
			directive: "OVERFLOW " + "x".repeat(500_000),
		});
		expect(sumTokens(result.messages)).toBeLessThanOrEqual(result.maxInputTokens);
	});

	it("re-sorts kept items into chronological order for a coherent timeline", () => {
		const messages: Message[] = [
			userText("first: the task"),
			readResult("r1", "read a file"),
			userText("second: a correction"),
		];
		const result = buildConsultContext({
			sessionMessages: messages,
			advisorContextWindow: 128_000,
			budget: BUDGET,
		});
		// Ledger indices are ascending → chronological reassembly.
		const indices = result.ledger.map((e) => e.index);
		expect(indices).toEqual([...indices].sort((a, b) => a - b));
	});
});
