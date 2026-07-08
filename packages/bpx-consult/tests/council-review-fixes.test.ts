/**
 * Targeted tests for the review-driven council fixes:
 * - §I synthesizer window fit (council.ts now fits the synth input)
 * - parallel:false is now a real sequential dodge (thunks, not eager promises)
 *
 * The synth-fit fix is unit-testable via buildConsultContext directly (the
 * mechanism council now calls). The parallel:false fix is a structural property
 * — verified by inspecting that runSequential receives thunks and the smoke
 * tests stay green.
 */
import { describe, expect, it } from "vitest";
import { buildConsultContext, summarizeLedger, type ContextBudget } from "../src/context-engine.js";
import { userText } from "../src/context-engine.js";

const BUDGET: ContextBudget = {
	userChars: 2800,
	assistantChars: 1800,
	toolArgChars: 800,
	toolResultChars: 2000,
	keepFirst: 2,
	keepLast: 12,
	responseReserveTokens: 4096,
};

describe("§I fix — synthesizer input is window-fitted", () => {
	it("fits a verbose member-transcript synthesis to the synth window", () => {
		// Simulate the grown synth input: many verbose member replies concatenated.
		// 60 messages × ~1500 tokens = ~90k tokens, well past the 27904 budget.
		const verboseMembers = Array.from({ length: 60 }, (_, i) =>
			userText(`### architect [for]\nMember ${i} reply: ` + "x".repeat(5960)),
		);
		// Synthesizer window = 32k (typical small synth). Pre-fix, this would
		// overflow; post-fix, buildConsultContext drops oldest-first.
		const fit = buildConsultContext({
			sessionMessages: verboseMembers,
			advisorContextWindow: 32_000,
			budget: BUDGET,
		});
		expect(fit.estimatedTokens).toBeLessThanOrEqual(fit.maxInputTokens);
		// Real reduction happened (not a trivial fit). Under §E.1 these verbose
		// "member replies" classify as directives (pinned), so the reduction shows up
		// as compression/clipping rather than dropping — pinned retains a
		// representation (RULE B). The old assertion pinned `omittedCount > 0`.
		const summary = summarizeLedger(fit.ledger);
		expect(summary.compressed + summary.clipped + summary.dropped).toBeGreaterThan(0);
		expect(fit.maxInputTokens).toBe(32_000 - 4096);
	});

	it("fits even a tiny 8k synthesizer window under verbose member replies", () => {
		const verboseMembers = Array.from({ length: 10 }, () => userText("y".repeat(1960)));
		const fit = buildConsultContext({
			sessionMessages: verboseMembers,
			advisorContextWindow: 8_000,
			budget: BUDGET,
		});
		expect(fit.maxInputTokens).toBe(4_000); // reserve capped at half
		expect(fit.estimatedTokens).toBeLessThanOrEqual(fit.maxInputTokens);
	});
});
