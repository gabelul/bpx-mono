/**
 * turn-budget — a per-session counter for the MODEL's own consult() calls.
 *
 * The cost problem: nothing stops a runaway agent from calling consult() ten
 * times in one turn, and each call is a real (sometimes multi-model) advisor
 * spend. maxConsultsPerTurn puts a soft cap on that.
 *
 * Scope is deliberately narrow. This counts ONLY the model's own consult() tool
 * calls (incremented from the tool handler in index.ts). Auto-triggers
 * (whenStuck/onDone) and phrase-triggers are separate paths with their own
 * guards — they must NOT be blocked by this cap, so they never touch the counter.
 *
 * The counter resets on the same points triggers.ts already uses: at the start
 * of each turn (before_agent_start) and on a genuine user input (interactive/rpc
 * source). index.ts owns one instance and wires both reset hooks.
 */

/** Mutable per-turn consult counter. One instance per registered extension (≈ per session). */
export interface TurnBudget {
	/** How many times the model has called consult() in the current turn. */
	used: number;
}

/** Fresh counter, zeroed. */
export function createTurnBudget(): TurnBudget {
	return { used: 0 };
}

/** Reset the counter to zero. Called on before_agent_start and on genuine user input. */
export function resetTurnBudget(budget: TurnBudget): void {
	budget.used = 0;
}

/**
 * Is the cap already reached? True only when `max` is a positive limit that
 * `used` has met or exceeded. `max <= 0` means unlimited, so this is always false.
 */
export function isCapReached(budget: TurnBudget, max: number): boolean {
	return max > 0 && budget.used >= max;
}

/** Count one consult() call against the budget. */
export function incrementTurnBudget(budget: TurnBudget): void {
	budget.used += 1;
}
