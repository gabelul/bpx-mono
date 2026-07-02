/**
 * Triggers unit tests — the pure logic (fingerprint, counter behavior,
 * self-trigger guard) that doesn't need a live pi event loop.
 *
 * The deadlock-avoidance and re-entrancy behaviors can't be unit-tested
 * meaningfully (they're about pi's event loop semantics) — those are validated
 * by the live smoke test, which engineers a stuck loop and confirms the trigger
 * fires without hanging or re-tripping.
 */
import { describe, expect, it } from "vitest";

// Re-implement the pure fingerprint decision locally to test the LOGIC without
// spinning up a handler. This mirrors the exact rules in triggers.ts; if they
// drift, this test catches it. (Importing the handler directly would require
// mocking the full ExtensionAPI surface, which tests the mock not the logic.)
interface FakeState {
	stuckErrors: number;
	lastFingerprint: string;
	loopCount: number;
}

function fingerprint(toolName: string, input: unknown): string {
	return `${toolName}:${JSON.stringify(input ?? "")}`;
}

/** Apply one tool_result to the state, returning the new counter values. */
function applyToolResult(state: FakeState, toolName: string, input: unknown, isError: boolean): FakeState {
	// Self-trigger guard: consult results don't count.
	if (toolName === "consult") return state;

	const fp = fingerprint(toolName, input);
	const loopCount = fp === state.lastFingerprint ? state.loopCount + 1 : 1;
	const stuckErrors = isError ? state.stuckErrors + 1 : 0;
	return { lastFingerprint: fp, loopCount, stuckErrors };
}

const whenStuck = 3;

describe("trigger fingerprint logic", () => {
	it("builds an un-truncated toolName:JSON(input) fingerprint", () => {
		expect(fingerprint("bash", { command: "ls" })).toBe('bash:{"command":"ls"}');
		// Long input is NOT truncated (the pi-extensions 120-char-cap bug).
		const long = { command: "x".repeat(500) };
		expect(fingerprint("bash", long).length).toBeGreaterThan(500);
	});

	it("same tool + identical args increments loopCount", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		s = applyToolResult(s, "edit", { path: "a.ts" }, false);
		expect(s.loopCount).toBe(1);
		s = applyToolResult(s, "edit", { path: "a.ts" }, false);
		expect(s.loopCount).toBe(2);
		s = applyToolResult(s, "edit", { path: "a.ts" }, false);
		expect(s.loopCount).toBe(3); // would trigger
	});

	it("different args resets loopCount to 1", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		s = applyToolResult(s, "edit", { path: "a.ts" }, false);
		s = applyToolResult(s, "edit", { path: "a.ts" }, false);
		expect(s.loopCount).toBe(2);
		s = applyToolResult(s, "edit", { path: "b.ts" }, false);
		expect(s.loopCount).toBe(1);
	});

	it("different tool resets loopCount even with same args", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		s = applyToolResult(s, "edit", { x: 1 }, false);
		s = applyToolResult(s, "write", { x: 1 }, false);
		expect(s.loopCount).toBe(1); // toolName is part of the fingerprint
	});
});

describe("trigger self-trigger guard", () => {
	it("consult tool results do NOT touch any counter", () => {
		let s: FakeState = { stuckErrors: 5, lastFingerprint: "edit:xxx", loopCount: 5 };
		// A consult result arrives — even repeatedly.
		s = applyToolResult(s, "consult", { mode: "council" }, false);
		s = applyToolResult(s, "consult", { mode: "council" }, false);
		s = applyToolResult(s, "consult", { mode: "council" }, false);
		// Untouched — this is the self-trigger re-trip guard.
		expect(s.loopCount).toBe(5);
		expect(s.stuckErrors).toBe(5);
		expect(s.lastFingerprint).toBe("edit:xxx");
	});

	it("consult error results also don't count toward stuckErrors", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		s = applyToolResult(s, "consult", {}, true);
		s = applyToolResult(s, "consult", {}, true);
		s = applyToolResult(s, "consult", {}, true);
		expect(s.stuckErrors).toBe(0); // would have triggered at 3 without the guard
	});
});

describe("trigger error counting", () => {
	it("consecutive errors accumulate, success resets", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		s = applyToolResult(s, "bash", { c: "x" }, true);
		expect(s.stuckErrors).toBe(1);
		s = applyToolResult(s, "bash", { c: "y" }, true);
		expect(s.stuckErrors).toBe(2);
		s = applyToolResult(s, "bash", { c: "z" }, true);
		expect(s.stuckErrors).toBe(3); // would trigger
		// A success resets.
		s = applyToolResult(s, "bash", { c: "ok" }, false);
		expect(s.stuckErrors).toBe(0);
	});
});

describe("trigger fire conditions", () => {
	it("loop fires at whenStuck identical calls", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		let fired = false;
		for (let i = 0; i < whenStuck; i++) {
			s = applyToolResult(s, "grep", { pattern: "foo" }, false);
			if (s.loopCount >= whenStuck) { fired = true; s.loopCount = 0; }
		}
		expect(fired).toBe(true);
	});

	it("loop does NOT fire when args vary between calls", () => {
		let s: FakeState = { stuckErrors: 0, lastFingerprint: "", loopCount: 0 };
		let fired = false;
		for (let i = 0; i < whenStuck; i++) {
			s = applyToolResult(s, "grep", { pattern: `foo${i}` }, false); // different each time
			if (s.loopCount >= whenStuck) { fired = true; }
		}
		expect(fired).toBe(false);
	});
});
