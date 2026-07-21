/**
 * Flow tests for debate partial-failure preservation.
 *
 * debate-partial.test.ts guards formatDebatePartial (the pure formatter). These
 * tests guard the WIRING: that executeDebate actually populates roundLog and
 * routes failures through bail(). If someone removed the bail() calls, these go
 * red — the pure-function tests alone would not.
 *
 * executeDebate is heavy (needs ExtensionContext, sessionManager, model
 * resolution), so we mock the boundaries: buildSessionContext/convertToLlm
 * (session reading) and resolveAdvisor/callAdvisor (model calls). Everything
 * else — buildConsultContext, resolvePersona, personaSystemPrompt, withTimeout
 * — runs for real.
 *
 * The callAdvisor mock is signal-aware: entries with `delayMs` race the delay
 * against the abort signal. If the signal fires first (timeout), the mock
 * rejects — mirroring real provider behavior where an aborted fetch throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// --- Mocks must be set up before importing executeDebate ---

const fakeAdvisor = { model: { contextWindow: 200_000 } as never, label: "test/model" };

interface MockEntry {
	text: string;
	stopReason: string;
	errorMessage?: string;
	/** If set, the mock waits this many ms before resolving. A timeout abort
	 * during the wait causes a rejection, mirroring real provider behavior. */
	delayMs?: number;
}

let callSequence: MockEntry[] = [];

/** Records the input of each callAdvisor call, for asserting what the
 * synthesizer received. */
let mockCalls: Array<{ messages?: unknown[] }> = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
	buildSessionContext: () => ({ messages: [] }),
	convertToLlm: () => [],
}));

vi.mock("../src/advisor.js", () => ({
	resolveAdvisor: () => fakeAdvisor,
	callAdvisor: async (input: { signal?: AbortSignal; messages?: unknown[] }) => {
		mockCalls.push(input);
		const next = callSequence.shift();
		if (!next) {
			return { text: "", usage: undefined, stopReason: "error", errorMessage: "no more mock responses" };
		}
		if (next.delayMs) {
			// Race the delay against the abort signal. If the signal fires first
			// (e.g. withTimeout's timer), reject — exactly what a real fetch does
			// when its AbortController fires.
			const signal = input.signal;
			if (signal?.aborted) throw new Error("aborted");
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, next.delayMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				}, { once: true });
			});
		}
		return {
			text: next.text,
			usage: { input: 10, output: 20, total: 30 },
			stopReason: next.stopReason,
			errorMessage: next.errorMessage,
		};
	},
}));

const { executeDebate } = await import("../src/debate.js");
const { DEFAULT_CONFIG } = await import("../src/config.js");
import type { BpxConsultConfig } from "../src/config.js";

function makeCtx(): never {
	return {
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => "leaf-1",
			getSessionId: () => "session-1",
		},
	} as never;
}

function configWith(rounds: number, timeoutMs = 180000): BpxConsultConfig {
	return {
		...DEFAULT_CONFIG,
		modes: {
			...DEFAULT_CONFIG.modes,
			debate: { advocate: "architect", critic: "critic", rounds, timeoutMs },
		},
	} as BpxConsultConfig;
}

function resultText(r: AgentToolResult<unknown>): string {
	return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

beforeEach(() => {
	callSequence = [];
	mockCalls = [];
});

describe("executeDebate — partial-failure preserves completed rounds", () => {
	it("returns the advocate turn when the round-1 critic fails", async () => {
		callSequence = [
			{ text: "Ship it. The tests cover the critical path.", stopReason: "end_turn" },
			{ text: "", stopReason: "error", errorMessage: "connection reset" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(1),
			signal: undefined,
			onUpdate: undefined,
			question: "Should I ship?",
		});

		const text = resultText(result);
		expect(text).toContain("Ship it. The tests cover the critical path.");
		expect(text).toContain("connection reset");
		expect(text).toContain("Debate incomplete");
	});

	it("returns completed rounds when round-2 advocate fails", async () => {
		callSequence = [
			{ text: "Round 1 advocate: the case FOR.", stopReason: "end_turn" },
			{ text: "Round 1 critic: the case AGAINST.", stopReason: "end_turn" },
			{ text: "", stopReason: "error", errorMessage: "timeout" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(2),
			signal: undefined,
			onUpdate: undefined,
			question: "What about X?",
		});

		const text = resultText(result);
		expect(text).toContain("Round 1 advocate: the case FOR.");
		expect(text).toContain("Round 1 critic: the case AGAINST.");
		expect(text).toContain("timeout");
	});

	it("returns the full debate when synthesizer fails after all rounds", async () => {
		callSequence = [
			{ text: "Advocate opening.", stopReason: "end_turn" },
			{ text: "Critic attack.", stopReason: "end_turn" },
			{ text: "Advocate rebuttal.", stopReason: "end_turn" },
			{ text: "Critic final attack.", stopReason: "end_turn" },
			{ text: "", stopReason: "error", errorMessage: "synth provider 503" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(2),
			signal: undefined,
			onUpdate: undefined,
			question: "Settle this.",
		});

		const text = resultText(result);
		expect(text).toContain("Advocate opening.");
		expect(text).toContain("Critic attack.");
		expect(text).toContain("Advocate rebuttal.");
		expect(text).toContain("Critic final attack.");
		expect(text).toContain("synth provider 503");
	});

	it("returns a bare error when round-1 advocate fails (nothing completed)", async () => {
		callSequence = [
			{ text: "", stopReason: "error", errorMessage: "provider down" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(1),
			signal: undefined,
			onUpdate: undefined,
			question: "Anything?",
		});

		const text = resultText(result);
		expect(text).toContain("provider down");
		expect(text).not.toContain("The rounds that completed");
	});
});

describe("executeDebate — timeout and synthesizer stopReason paths", () => {
	it("preserves completed rounds when a later call stalls into the timeout", async () => {
		// Round 1 advocate succeeds instantly; round 1 critic stalls past the
		// 50ms timeout budget. The abort causes the mock to reject, callStep
		// catches it, bail() fires with the advocate turn already in roundLog.
		callSequence = [
			{ text: "The advocate's strongest case.", stopReason: "end_turn" },
			{ text: "should never arrive", stopReason: "end_turn", delayMs: 500 },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(1, 50),
			signal: undefined,
			onUpdate: undefined,
			question: "Quick question.",
		});

		const text = resultText(result);
		// The completed advocate turn survived the timeout.
		expect(text).toContain("The advocate's strongest case.");
		// The stall result did NOT make it through.
		expect(text).not.toContain("should never arrive");
		// It's marked incomplete.
		expect(text).toContain("Debate incomplete");
	});

	it("treats synthesizer partial text with error stopReason as failure, not success", async () => {
		// All rounds complete. Synthesizer returns PARTIAL text with an error
		// stopReason — the exact case the stopReason check was added for.
		// Without the check, "truncated verdict" would be returned as ok().
		callSequence = [
			{ text: "Advocate: ship it.", stopReason: "end_turn" },
			{ text: "Critic: don't ship it.", stopReason: "end_turn" },
			{ text: "truncated verdict", stopReason: "error", errorMessage: "synth failed" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(1),
			signal: undefined,
			onUpdate: undefined,
			question: "Ship it?",
		});

		const text = resultText(result);
		// The completed debate is returned, not the truncated verdict.
		expect(text).toContain("Advocate: ship it.");
		expect(text).toContain("Critic: don't ship it.");
		expect(text).toContain("synth failed");
		// The truncated text is NOT presented as the verdict.
		expect(text).not.toContain("### Verdict\ntruncated verdict");
	});
});

describe("executeDebate — synthesizer receives the full transcript", () => {
	it("feeds every round to the synthesizer, not just round 1 + last critic", async () => {
		// Before the fix, the synth only saw round-1 advocate + the last critic.
		// For a 2-round debate, that dropped the round-1 critic and the round-2
		// advocate rebuttal — half the argument. Now roundLog feeds the synth.
		callSequence = [
			{ text: "R1 advocate opening.", stopReason: "end_turn" },
			{ text: "R1 critic attacks.", stopReason: "end_turn" },
			{ text: "R2 advocate rebuts.", stopReason: "end_turn" },
			{ text: "R2 critic final attack.", stopReason: "end_turn" },
			{ text: "The verdict.", stopReason: "end_turn" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWith(2),
			signal: undefined,
			onUpdate: undefined,
			question: "Full debate.",
		});

		expect(resultText(result)).toContain("The verdict.");

		// The 5th call was the synthesizer. Its messages must contain every turn.
		expect(mockCalls.length).toBeGreaterThanOrEqual(5);
		const synthInput = JSON.stringify(mockCalls[4].messages);
		expect(synthInput).toContain("R1 advocate opening.");
		expect(synthInput).toContain("R1 critic attacks.");
		expect(synthInput).toContain("R2 advocate rebuts.");
		expect(synthInput).toContain("R2 critic final attack.");
	});
});
