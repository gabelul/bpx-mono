import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildConsultContext, estimateMessageTokens, userText, type ContextBudget } from "../src/context-engine.js";

const budget: ContextBudget = {
	userChars: 1600, assistantChars: 800, toolArgChars: 500, toolResultChars: 1200,
	keepFirst: 1, keepLast: 3, responseReserveTokens: 200,
};

/** Build real Pi transcript shapes: one assistant turn may invoke multiple tools. */
function calls(...entries: Array<[string, string, string]>): AssistantMessage {
	return {
		role: "assistant", content: entries.map(([id, name, command]) => ({ type: "toolCall", id, name, arguments: { command } })),
		api: "anthropic-messages" as never, provider: "anthropic" as never, model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 1,
	};
}

function result(id: string, text: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 2 };
}

/** Strict providers reject an orphan call or result even if the payload fits. */
function expectCompletePairs(messages: Message[]): void {
	const ids = messages.flatMap((m) => m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : []);
	const results = messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => m.toolCallId);
	expect(ids.sort()).toEqual(results.sort());
}

function fit(messages: Message[], window = 3000) {
	const outcome = buildConsultContext({ sessionMessages: messages, advisorContextWindow: window, budget });
	expect(outcome.messages.reduce((tokens, m) => tokens + estimateMessageTokens(m), 0)).toBe(outcome.estimatedTokens);
	expect(outcome.estimatedTokens).toBeLessThanOrEqual(outcome.maxInputTokens);
	expectCompletePairs(outcome.messages);
	return outcome;
}

describe("atomic tool exchanges in advisor context", () => {
	it("keeps two sibling calls with results returned in reverse order", () => {
		const outcome = fit([userText("Check build"), calls(["a", "bash", "npm test"], ["b", "bash", "npm run build"]), result("b", "build passed"), result("a", "tests passed")]);
		expect(outcome.ledger.slice(1, 4).map((row) => row.disposition)).toEqual(["kept", "kept", "kept"]);
	});

	it("keeps each sibling result and its assistant call in one representation under pressure", () => {
		const outcome = fit([
			userText("Investigate flaky test " + "context ".repeat(250)),
			calls(["a", "bash", "npm test -- foo"], ["b", "bash", "cat logs"]),
			result("b", "log ".repeat(500)),
			result("a", "Command exited with code 1: FAIL_MARKER " + "failure ".repeat(500), true),
		], 1350);
		expect(outcome.error).toBeUndefined();
		const exchange = outcome.ledger.slice(1, 4);
		expect(exchange.map((row) => row.disposition)).toEqual([exchange[0].disposition, exchange[0].disposition, exchange[0].disposition]);
		expect(exchange.every((row) => row.disposition !== "dropped")).toBe(true);
		expect(JSON.stringify(outcome.messages)).toContain("npm test -- foo");
	});

	it("retains a reviewer finding attached to a compressed tool batch", () => {
		const assistant = calls(["review", "bash", "npm test"]);
		assistant.content.unshift({ type: "text", text: `${"noise ".repeat(25)}P1 security issue: token leaked into logs` });
		const outcome = fit([userText("Verify auth " + "requirements ".repeat(170)), assistant, result("review", "test output ".repeat(200))], 1250);
		expect(outcome.error).toBeUndefined();
		expect(JSON.stringify(outcome.messages)).toContain("token leaked into logs");
	});

	it("summarizes an incomplete batch without forwarding a dangling sibling call", () => {
		const outcome = fit([userText("Check both"), calls(["missing", "bash", "npm test"], ["good", "bash", "npm run build"]), result("good", "build passed")]);
		expect(outcome.ledger.slice(1).map((row) => row.disposition)).toEqual(["compressed", "compressed"]);
		expect(JSON.stringify(outcome.messages)).toContain("npm run build");
		expect(outcome.messages.some((m) => m.role === "assistant" && m.content.some((part) => part.type === "toolCall"))).toBe(false);
	});

	it("keeps distinct failures with duplicate result IDs as labeled text", () => {
		const outcome = fit([userText("Check build"), calls(["same", "bash", "npm run build"]),
			result("same", "TypeError: first failure", true), result("same", "TypeError: second failure", true)]);
		expect(outcome.ledger.slice(1).map((row) => row.disposition)).toEqual(["compressed", "compressed", "compressed"]);
		expect(outcome.omittedCount).toBe(0);
		expect(JSON.stringify(outcome.messages)).toContain("TypeError: first failure");
		expect(JSON.stringify(outcome.messages)).toContain("TypeError: second failure");
	});

	it("never claims two errors survived when a tiny window cannot hold their anchors", () => {
		const outcome = fit([userText("Check errors"), calls(["same", "bash", "npm test"]),
			result("same", "TypeError: FIRST_FAILURE", true),
			result("same", `TypeError: SECOND_FAILURE ${"details ".repeat(350)}`, true)], 350);
		if (outcome.error) {
			expect(outcome.ledger.every((row) => row.disposition === "dropped")).toBe(true);
		} else {
			const payload = JSON.stringify(outcome.messages);
			expect(payload).toContain("FIRST_FAILURE");
			expect(payload).toContain("SECOND_FAILURE");
		}
	});

	it("leaves source transcript unchanged while dropping low-priority batches", () => {
		const messages: Message[] = [userText("Find root cause"), ...Array.from({ length: 12 }, (_, i) => [calls([`b${i}`, "bash", `echo ${i}`]), result(`b${i}`, "noise ".repeat(80))]).flat()];
		const original = JSON.stringify(messages);
		const outcome = fit(messages, 1500);
		expect(JSON.stringify(messages)).toBe(original);
		expect(outcome.omittedCount).toBe(outcome.ledger.filter((row) => row.disposition === "dropped").length);
		expect(outcome.omittedCount).toBeGreaterThan(0);
	});

	it("keeps pairing, ledger, and token count consistent across tight windows", () => {
		const messages: Message[] = [
			userText("Check failing tests " + "task ".repeat(150)),
			calls(["first", "bash", "npm test --alpha"], ["second", "bash", "npm test --beta"]),
			result("second", "beta passed " + "log ".repeat(180)),
			result("first", "Command exited with code 1: alpha failed " + "trace ".repeat(170), true),
			calls(["third", "bash", "echo follow-up"]), result("third", "follow-up " + "log ".repeat(180)),
		];
		for (const window of [950, 1200, 1500, 2100, 4000]) {
			const outcome = fit(messages, window);
			if (outcome.error) {
				expect(outcome.ledger.every((row) => row.disposition === "dropped")).toBe(true);
				continue;
			}
			expect(outcome.omittedCount).toBe(outcome.ledger.filter((row) => row.disposition === "dropped").length);
			expect(new Set(outcome.ledger.slice(1, 4).map((row) => row.disposition)).size).toBe(1);
		}
	});

	it("keeps an orphan failure as text without forwarding an invalid tool result", () => {
		const outcome = fit([userText("Why did the build fail?"), result("lost-call", "TypeError: MODULE_NOT_FOUND", true)]);
		expect(outcome.error).toBeUndefined();
		expect(outcome.ledger[1]?.disposition).not.toBe("dropped");
		expect(outcome.messages.some((m) => m.role === "toolResult")).toBe(false);
		expect(JSON.stringify(outcome.messages)).toContain("MODULE_NOT_FOUND");
	});

	it("marks malformed orphan results dropped without discarding a valid sibling exchange", () => {
		const outcome = fit([userText("Run tests"), calls(["good", "bash", "npm test"]), result("missing", "orphan"), result("good", "passed")]);
		expect(outcome.ledger.find((row) => row.index === 2)?.disposition).toBe("dropped");
		expect(outcome.messages.some((m) => m.role === "toolResult" && m.toolCallId === "good")).toBe(true);
		expect(outcome.messages.some((m) => m.role === "toolResult" && m.toolCallId === "missing")).toBe(false);
	});
});
