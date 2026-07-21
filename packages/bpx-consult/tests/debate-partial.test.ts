/**
 * formatDebatePartial — the partial-failure preservation contract.
 *
 * Debate is sequential: advocate → critic → rebut, for N rounds, then a
 * synthesizer. Any call can time out. Before the fix, every failure path was
 * an early `return err(error)` that discarded the rounds already in
 * lastAdvocateText / lastCriticText — minutes of completed argument gone,
 * replaced by a one-line error.
 *
 * Now `bail()` calls formatDebatePartial, which returns the completed rounds
 * alongside the error so nothing is lost. This test pins that contract without
 * mocking the full ExtensionContext — same pattern as isTooLongError in solo.ts.
 */

import { describe, expect, it } from "vitest";
import { formatDebatePartial } from "../src/debate.js";

describe("formatDebatePartial — mid-debate failure preserves completed rounds", () => {
	it("returns the bare error when nothing completed yet", () => {
		// Round 1 advocate died immediately — no turns to hand back.
		const result = formatDebatePartial("Round 1 advocate failed: timeout", []);
		expect(result).toBe("Round 1 advocate failed: timeout");
		expect(result).not.toContain("Debate incomplete");
	});

	it("includes completed rounds when some succeeded before the failure", () => {
		const roundLog = [
			"### Round 1 — Advocate (FOR)\nShip it. The tests are green.",
			"### Round 1 — Critic (AGAINST)\nNo. The tests don't cover the edge case.",
		];

		const result = formatDebatePartial("Round 2 critic failed: timeout", roundLog);

		// The error is visible so nobody mistakes this for a clean verdict.
		expect(result).toContain("Debate incomplete");
		expect(result).toContain("Round 2 critic failed: timeout");
		// Both completed turns survived.
		expect(result).toContain("Ship it. The tests are green.");
		expect(result).toContain("The tests don't cover the edge case.");
	});

	it("includes a single completed round when the second dies", () => {
		const roundLog = ["### Round 1 — Advocate (FOR)\nThe strongest case."];

		const result = formatDebatePartial("Round 1 critic failed: 503", roundLog);

		expect(result).toContain("The strongest case.");
		expect(result).toContain("503");
	});

	it("preserves synthesizer failure too (all rounds done, synth died)", () => {
		// The most painful case: every round completed, then the synthesizer
		// — the last call — fails. Without bail(), six minutes of debate vanish.
		const roundLog = [
			"### Round 1 — Advocate (FOR)\nFor.",
			"### Round 1 — Critic (AGAINST)\nAgainst.",
			"### Round 2 — Advocate Rebuttal (FOR)\nStill for.",
			"### Round 2 — Critic (AGAINST)\nStill against.",
		];

		const result = formatDebatePartial("synthesizer returned no usable text", roundLog);

		expect(result).toContain("Still for.");
		expect(result).toContain("Still against.");
		expect(result).toContain("synthesizer returned no usable text");
	});
});
