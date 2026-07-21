/**
 * Flow tests for debate partial-failure preservation.
 *
 * debate-partial.test.ts guards formatDebatePartial (the pure formatter). These
 * tests guard the WIRING: that executeDebate actually populates roundLog and
 * routes failures through bail(). If someone removed the bail() calls or moved
 * roundLog back inside withTimeout, these go red — the pure-function tests
 * alone would not.
 *
 * executeDebate is heavy (needs ExtensionContext, sessionManager, model
 * resolution), so we mock the boundaries: buildSessionContext/convertToLlm
 * (session reading) and resolveAdvisor/callAdvisor (model calls). Everything
 * else — buildConsultContext, resolvePersona, personaSystemPrompt, withTimeout
 * — runs for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// --- Mocks must be set up before importing executeDebate ---

const fakeAdvisor = { model: { contextWindow: 200_000 } as never, label: "test/model" };

// Sequence of callAdvisor returns, consumed in call order.
let callSequence: Array<{ text: string; stopReason: string; errorMessage?: string }> = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
	buildSessionContext: () => ({ messages: [] }),
	convertToLlm: () => [],
}));

vi.mock("../src/advisor.js", () => ({
	resolveAdvisor: () => fakeAdvisor,
	callAdvisor: async () => {
		const next = callSequence.shift();
		return next
			? { text: next.text, usage: { input: 10, output: 20, total: 30 }, stopReason: next.stopReason, errorMessage: next.errorMessage }
			: { text: "", usage: undefined, stopReason: "error", errorMessage: "no more mock responses" };
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

function configWithRounds(rounds: number): BpxConsultConfig {
	return {
		...DEFAULT_CONFIG,
		modes: {
			...DEFAULT_CONFIG.modes,
			debate: { advocate: "architect", critic: "critic", rounds, timeoutMs: 180000 },
		},
	} as BpxConsultConfig;
}

function resultText(r: AgentToolResult<unknown>): string {
	return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

beforeEach(() => {
	callSequence = [];
});

describe("executeDebate — partial-failure preserves completed rounds", () => {
	it("returns the advocate turn when the round-1 critic fails", async () => {
		// Advocate succeeds, critic dies.
		callSequence = [
			{ text: "Ship it. The tests cover the critical path.", stopReason: "end_turn" },
			{ text: "", stopReason: "error", errorMessage: "connection reset" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWithRounds(1),
			signal: undefined,
			onUpdate: undefined,
			question: "Should I ship?",
		});

		const text = resultText(result);
		// The completed advocate turn survived.
		expect(text).toContain("Ship it. The tests cover the critical path.");
		// The error is visible — this is not a clean verdict.
		expect(text).toContain("connection reset");
		expect(text).toContain("Debate incomplete");
	});

	it("returns completed rounds when round-2 advocate fails", async () => {
		// Round 1 completes fully; round 2 advocate rebuttal dies.
		callSequence = [
			{ text: "Round 1 advocate: the case FOR.", stopReason: "end_turn" },
			{ text: "Round 1 critic: the case AGAINST.", stopReason: "end_turn" },
			{ text: "", stopReason: "error", errorMessage: "timeout" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWithRounds(2),
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
		// Both rounds complete, synthesizer dies — the worst case.
		callSequence = [
			{ text: "Advocate opening.", stopReason: "end_turn" },
			{ text: "Critic attack.", stopReason: "end_turn" },
			{ text: "Advocate rebuttal.", stopReason: "end_turn" },
			{ text: "Critic final attack.", stopReason: "end_turn" },
			{ text: "", stopReason: "error", errorMessage: "synth provider 503" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWithRounds(2),
			signal: undefined,
			onUpdate: undefined,
			question: "Settle this.",
		});

		const text = resultText(result);
		// Every round survived.
		expect(text).toContain("Advocate opening.");
		expect(text).toContain("Critic attack.");
		expect(text).toContain("Advocate rebuttal.");
		expect(text).toContain("Critic final attack.");
		// And the error.
		expect(text).toContain("synth provider 503");
	});

	it("returns a bare error when round-1 advocate fails (nothing completed)", async () => {
		callSequence = [
			{ text: "", stopReason: "error", errorMessage: "provider down" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: configWithRounds(1),
			signal: undefined,
			onUpdate: undefined,
			question: "Anything?",
		});

		const text = resultText(result);
		expect(text).toContain("provider down");
		// No "Debate incomplete" header — nothing was incomplete, nothing ran.
		expect(text).not.toContain("The rounds that completed");
	});
});
