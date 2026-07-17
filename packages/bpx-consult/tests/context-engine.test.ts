import { describe, expect, it } from "vitest";
import {
	CONSULT_TOOL_NAME,
	type ContextBudget,
	applyCharCaps,
	buildConsultContext,
	clampText,
	deriveInputBudget,
	estimateMessageTokens,
	estimateTokens,
	fitToWindow,
	stripInflightConsultCall,
	assistantText,
	toolResultText,
	userText,
} from "../src/context-engine.js";

const BUDGET: ContextBudget = {
	userChars: 2800,
	assistantChars: 1800,
	toolArgChars: 800,
	toolResultChars: 2000,
	keepFirst: 2,
	keepLast: 12,
	responseReserveTokens: 4096,
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
	it("is deliberately conservative (overestimates, the safe direction)", () => {
		// 3 chars/token × 1.15 safety factor. ceil(400/3 * 1.15) = ceil(153.3) = 154
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBeGreaterThanOrEqual(1);
		expect(estimateTokens("a".repeat(400))).toBe(154);
	});
});

describe("estimateMessageTokens", () => {
	it("counts string user content", () => {
		expect(estimateMessageTokens(userText("a".repeat(400)))).toBe(154);
	});
	it("counts assistant text + toolCall args", () => {
		const msg = assistantText("a".repeat(40));
		expect(estimateMessageTokens(msg)).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Step 1 — strip in-flight consult() call
// ---------------------------------------------------------------------------

describe("stripInflightConsultCall", () => {
	it("removes a trailing consult() toolCall from the last assistant message", () => {
		const assistant: any = {
			role: "assistant",
			content: [
				{ type: "text", text: "let me consult" },
				{ type: "toolCall", id: "1", name: CONSULT_TOOL_NAME, arguments: {} },
			],
			timestamp: 1,
		};
		const out = stripInflightConsultCall([userText("hi"), assistant]);
		expect(out.length).toBe(2);
		expect((out[1] as any).content).toHaveLength(1);
		expect((out[1] as any).content[0].type).toBe("text");
	});

	it("leaves other toolCalls untouched", () => {
		const assistant: any = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "1", name: "bash", arguments: {} },
				{ type: "toolCall", id: "2", name: CONSULT_TOOL_NAME, arguments: {} },
			],
			timestamp: 1,
		};
		const out = stripInflightConsultCall([assistant]);
		expect((out[0] as any).content).toHaveLength(1);
		expect((out[0] as any).content[0].name).toBe("bash");
	});

	it("drops the whole message if consult() was the only content", () => {
		const assistant: any = {
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: CONSULT_TOOL_NAME, arguments: {} }],
			timestamp: 1,
		};
		const out = stripInflightConsultCall([userText("hi"), assistant]);
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
	});

	it("is a no-op when the tail isn't an assistant message", () => {
		const msgs = [userText("hi"), toolResultText("ok")];
		expect(stripInflightConsultCall(msgs)).toBe(msgs);
	});
});

// ---------------------------------------------------------------------------
// Step 5 — char caps
// ---------------------------------------------------------------------------

describe("clampText", () => {
	it("returns short text unchanged", () => {
		expect(clampText("hello", 100)).toBe("hello");
	});
	it("trims and marks long text", () => {
		const out = clampText("a".repeat(500), 100);
		expect(out.length).toBeLessThan(150);
		expect(out).toContain("[truncated for advisor context]");
	});
});

describe("applyCharCaps", () => {
	it("caps user message text content", () => {
		const out = applyCharCaps([userText("a".repeat(5000))], BUDGET);
		const content = (out[0] as any).content;
		const text = typeof content === "string" ? content : content[0].text;
		expect(text.length).toBeLessThanOrEqual(BUDGET.userChars + 50); // +marker slack
		expect(text).toContain("[truncated");
	});

	it("caps tool result content", () => {
		const out = applyCharCaps([toolResultText("a".repeat(5000))], BUDGET);
		const text = (out[0] as any).content[0].text;
		expect(text.length).toBeLessThanOrEqual(BUDGET.toolResultChars + 50);
	});

	it("truncates oversized toolCall args but keeps the call", () => {
		const hugeArgs = { data: "x".repeat(5000) };
		const assistant: any = {
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "bash", arguments: hugeArgs }],
			timestamp: 1,
		};
		const out = applyCharCaps([assistant], BUDGET);
		const block = (out[0] as any).content[0];
		expect(block.type).toBe("toolCall");
		expect(block.name).toBe("bash");
		// Args were ~5000 chars; after clamp they're dramatically smaller. Allow
		// slack for the 800-char cap + the [truncated] marker + the JSON wrapper.
		const argsLen = JSON.stringify(block.arguments).length;
		expect(argsLen).toBeLessThan(BUDGET.toolArgChars + 100);
		expect(argsLen).toBeLessThan(1000);
	});
});

// ---------------------------------------------------------------------------
// Step 6 — sliding window + the §P fix
// ---------------------------------------------------------------------------

describe("fitToWindow", () => {
	it("returns the input unchanged when it already fits", () => {
		const msgs = [userText("short"), assistantText("reply")];
		const fit = fitToWindow(msgs, BUDGET, 10_000);
		expect(fit.messages).toBe(msgs);
		expect(fit.omittedCount).toBe(0);
	});

	it("omits middle messages to fit a small budget, keeping head + tail", () => {
		// 20 user messages, each ~100 tokens
		const msgs = Array.from({ length: 20 }, (_, i) => userText(`msg ${i} ` + "a".repeat(396)));
		const totalTokens = msgs.reduce((s, m) => s + estimateMessageTokens(m), 0);
		expect(totalTokens).toBeGreaterThan(1900);

		// Budget only fits ~5 messages worth
		const fit = fitToWindow(msgs, BUDGET, 600);
		expect(fit.estimatedTokens).toBeLessThanOrEqual(600);
		expect(fit.omittedCount).toBeGreaterThan(0);
		// Head retained
		expect((fit.messages[0] as any).content).toContain("msg 0");
		// Tail retained
		const last = fit.messages[fit.messages.length - 1];
		const lastText = typeof last.content === "string" ? last.content : (last.content[0] as any).text;
		expect(lastText).toContain("msg 19");
		// Omission marker present
		const hasMarker = fit.messages.some((m) => {
			const t = typeof m.content === "string" ? m.content : "";
			return t.includes("earlier transcript messages omitted");
		});
		expect(hasMarker).toBe(true);
	});

	it("never exceeds the input budget, even under extreme pressure", () => {
		const msgs = Array.from({ length: 50 }, () => userText("a".repeat(2000)));
		const fit = fitToWindow(msgs, BUDGET, 800);
		expect(fit.estimatedTokens).toBeLessThanOrEqual(800);
		expect(fit.messages.length).toBeGreaterThanOrEqual(1);
	});

	it("honours keepFirst by retaining the first message when there's room", () => {
		const msgs = Array.from({ length: 15 }, (_, i) => userText(`head-${i} ` + "b".repeat(396)));
		// Budget 700: head (2 msgs ≈ 310) + marker (~58) + 1 tail (≈155) = ~523 fits,
		// so head-0 survives. At 500 it can't, and head is correctly dropped.
		const fit = fitToWindow(msgs, BUDGET, 700);
		const first = fit.messages[0];
		const firstText = typeof first.content === "string" ? first.content : "";
		expect(firstText).toContain("head-0");
	});
});

// ---------------------------------------------------------------------------
// Step 7 — deriveInputBudget (the §P fix in one line)
// ---------------------------------------------------------------------------

describe("deriveInputBudget", () => {
	it("subtracts the response reserve from the advisor window", () => {
		expect(deriveInputBudget(128_000, BUDGET)).toBe(128_000 - 4096 - 12_800);
	});
	it("uses 32k fallback when the window is unknown", () => {
		expect(deriveInputBudget(undefined, BUDGET)).toBe(32_000 - 4096 - 3_200);
	});
	it("never lets the reserve eat more than half the window", () => {
		const tiny: ContextBudget = { ...BUDGET, responseReserveTokens: 100_000 };
		// window 32k, reserve capped to 16k → input budget 16k
		expect(deriveInputBudget(32_000, tiny)).toBe(12_800);
	});
	it("floors the input budget at 1024 tokens", () => {
		const huge: ContextBudget = { ...BUDGET, responseReserveTokens: 100_000 };
		expect(deriveInputBudget(1000, huge)).toBeGreaterThanOrEqual(1024);
	});
});

// ---------------------------------------------------------------------------
// Step 8 — full pipeline (the real §P proof)
// ---------------------------------------------------------------------------

describe("buildConsultContext — the §P fix", () => {
	it("guarantees the output fits the advisor's window, no matter the session length", () => {
		// Simulate a long, already-compacted session (the executor's view).
		// 200 messages × ~500 tokens each ≈ 100k tokens of compacted context.
		const sessionMessages = Array.from({ length: 200 }, (_, i) => {
			if (i % 3 === 0) return userText(`user turn ${i} ` + "x".repeat(1960));
			if (i % 3 === 1) return assistantText(`assistant turn ${i} ` + "y".repeat(1960));
			return toolResultText(`result ${i} ` + "z".repeat(1960));
		});

		// A small advisor: 32k window. Pre-fix, this would overflow and fail.
		const result = buildConsultContext({
			sessionMessages,
			advisorContextWindow: 32_000,
			budget: BUDGET,
			directive: "Stage: stuck. Recent failures: build error.",
		});

		// THE invariant: output fits the input budget.
		expect(result.estimatedTokens).toBeLessThanOrEqual(result.maxInputTokens);
		// The budget was derived from the advisor's 32k window, not a global constant.
		expect(result.maxInputTokens).toBe(32_000 - 4096 - 3_200);
		// We dropped messages to get there.
		expect(result.omittedCount).toBeGreaterThan(0);
		// The directive was appended at the tail.
		const last = result.messages[result.messages.length - 1];
		const lastText = typeof last.content === "string" ? last.content : "";
		expect(lastText).toContain("Stage: stuck");
	});

	it("forwards a short session essentially unchanged", () => {
		const sessionMessages = [userText("how do I fix the bug?"), assistantText("try checking the null case")];
		const result = buildConsultContext({
			sessionMessages,
			advisorContextWindow: 128_000,
			budget: BUDGET,
		});
		expect(result.omittedCount).toBe(0);
		expect(result.messages.length).toBeGreaterThanOrEqual(2);
		expect(result.estimatedTokens).toBeLessThanOrEqual(result.maxInputTokens);
	});

	it("strips an in-flight consult() call before fitting", () => {
		const inFlightAssistant: any = {
			role: "assistant",
			content: [
				{ type: "text", text: "let me get a read" },
				{ type: "toolCall", id: "1", name: CONSULT_TOOL_NAME, arguments: {} },
			],
			timestamp: 1,
		};
		const result = buildConsultContext({
			sessionMessages: [userText("hi"), inFlightAssistant],
			advisorContextWindow: 32_000,
			budget: BUDGET,
		});
		const hasConsultCall = result.messages.some((m) => {
			if (m.role !== "assistant") return false;
			return m.content.some((c: any) => c.type === "toolCall" && c.name === CONSULT_TOOL_NAME);
		});
		expect(hasConsultCall).toBe(false);
	});

	it("fits even when the advisor window is tiny (8k CLI advisor)", () => {
		const sessionMessages = Array.from({ length: 50 }, (_, i) => userText(`turn ${i} ` + "q".repeat(1960)));
		const result = buildConsultContext({
			sessionMessages,
			advisorContextWindow: 8_000,
			budget: BUDGET,
		});
		// Reserve is capped at half the window (4096 > 4000 = half of 8k), so the
		// input budget is 8k - 4k, not 8k - 4096. This is the reserve invariant
		// doing its job on a tiny-window advisor.
		expect(result.maxInputTokens).toBe(3_200);
		expect(result.estimatedTokens).toBeLessThanOrEqual(result.maxInputTokens);
	});
});

describe("Bug B — fitted context always ends with a user message (no prefill error)", () => {
	it("appends a default trailing user message when no directive/question is given", () => {
		// The prefill bug: a consult with no question forwarded a context ending
		// on the executor's assistant message, which non-prefill providers reject
		// ("must end with a user message"). buildConsultContext now guarantees a
		// trailing user turn unconditionally.
		const result = buildConsultContext({
			sessionMessages: [userText("do the thing"), assistantText("on it")],
			advisorContextWindow: 32_000,
			budget: BUDGET,
			directive: undefined, // no question → would have ended on the assistant msg
		});
		const last = result.messages[result.messages.length - 1];
		expect(last?.role).toBe("user");
	});

	it("ends with a user message even when the session ends on an assistant turn", () => {
		const result = buildConsultContext({
			sessionMessages: [userText("hi"), assistantText("hello"), assistantText("working")],
			advisorContextWindow: 32_000,
			budget: BUDGET,
		});
		const last = result.messages[result.messages.length - 1];
		expect(last?.role).toBe("user");
	});
});

describe("Bug A — context-fitting has an uncertainty margin", () => {
	it("deriveInputBudget subtracts a 10% margin on top of the response reserve", () => {
		// The estimate can undercount real tokenization; a proportional margin so
		// the fit targets well under the hard ceiling instead of grazing it.
		expect(deriveInputBudget(100_000, BUDGET)).toBe(100_000 - 4096 - 10_000);
		expect(deriveInputBudget(1_000_000, BUDGET)).toBe(1_000_000 - 4096 - 100_000);
	});
});
