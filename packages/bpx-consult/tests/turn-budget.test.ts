/**
 * turn-budget unit tests — the per-turn consult counter and cap logic.
 *
 * Pure state, no pi event loop needed. Mirrors how index.ts uses it: increment
 * on each model consult(), check isCapReached before running, reset per turn.
 */
import { describe, expect, it } from "vitest";
import {
	createTurnBudget,
	incrementTurnBudget,
	isCapReached,
	resetTurnBudget,
} from "../src/turn-budget.js";

describe("turn-budget counter", () => {
	it("starts at zero", () => {
		expect(createTurnBudget().used).toBe(0);
	});

	it("increments by one per call", () => {
		const b = createTurnBudget();
		incrementTurnBudget(b);
		incrementTurnBudget(b);
		expect(b.used).toBe(2);
	});

	it("resets back to zero", () => {
		const b = createTurnBudget();
		incrementTurnBudget(b);
		incrementTurnBudget(b);
		resetTurnBudget(b);
		expect(b.used).toBe(0);
	});
});

describe("turn-budget cap", () => {
	it("0 means unlimited — never caps", () => {
		const b = createTurnBudget();
		for (let i = 0; i < 100; i++) incrementTurnBudget(b);
		expect(isCapReached(b, 0)).toBe(false);
	});

	it("negative max is treated as unlimited", () => {
		const b = createTurnBudget();
		incrementTurnBudget(b);
		expect(isCapReached(b, -1)).toBe(false);
	});

	it("caps once used meets the limit", () => {
		const b = createTurnBudget();
		expect(isCapReached(b, 3)).toBe(false); // 0/3
		incrementTurnBudget(b);
		expect(isCapReached(b, 3)).toBe(false); // 1/3
		incrementTurnBudget(b);
		expect(isCapReached(b, 3)).toBe(false); // 2/3
		incrementTurnBudget(b);
		expect(isCapReached(b, 3)).toBe(true); // 3/3 — capped
	});

	it("stays capped past the limit, and a reset re-opens it", () => {
		const b = createTurnBudget();
		incrementTurnBudget(b);
		incrementTurnBudget(b);
		expect(isCapReached(b, 2)).toBe(true);
		resetTurnBudget(b);
		expect(isCapReached(b, 2)).toBe(false);
	});

	it("models the index.ts loop: N calls run, the N+1th is refused", () => {
		const b = createTurnBudget();
		const cap = 3;
		let ran = 0;
		let refused = 0;
		for (let i = 0; i < 5; i++) {
			if (isCapReached(b, cap)) {
				refused++;
				continue;
			}
			incrementTurnBudget(b);
			ran++;
		}
		expect(ran).toBe(3);
		expect(refused).toBe(2);
	});
});
