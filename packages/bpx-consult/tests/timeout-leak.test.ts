/**
 * Regression test for the AbortSignal listener leak (reviewer finding #5).
 *
 * Before the fix, linkController attached an "abort" listener to the parent
 * signal on every call, and withTimeout never removed it. Over a long session,
 * every consult call leaked one orphan listener on ctx.signal.
 *
 * The fix: linkController returns a cleanup() that removes the listener;
 * withTimeout calls it in a finally.
 *
 * Listener-counting: AbortSignal is a Web EventTarget, not a Node EventEmitter,
 * so .eventNames() doesn't exist. We instrument addEventListener /
 * removeEventListener on the parent signal directly to count net attachments.
 */
import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/timeout.js";

/** Wrap a parent signal so we can count net retained listeners. */
function instrumentedSignal(): { signal: AbortSignal; retained: () => number } {
	const parent = new AbortController();
	const signal = parent.signal;
	let added = 0;
	let removed = 0;
	const origAdd = signal.addEventListener.bind(signal);
	const origRemove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((type: string, listener: any, opts?: any) => {
		added++;
		return origAdd(type, listener, opts);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, listener: any, opts?: any) => {
		removed++;
		return origRemove(type, listener, opts);
	}) as typeof signal.removeEventListener;
	return { signal, retained: () => added - removed };
}

describe("AbortSignal listener cleanup (no leak)", () => {
	it("does not accumulate listeners on the parent signal across calls", async () => {
		const { signal, retained } = instrumentedSignal();
		// Run many timeouts to completion (normal path — parent never aborts).
		// Pre-fix: retained would be ~50 (one listener per call, never removed).
		// Post-fix: retained is 0 (cleanup runs in finally every time).
		for (let i = 0; i < 50; i++) {
			await withTimeout(1000, signal, async () => "ok");
		}
		expect(retained()).toBe(0);
	});

	it("still cleans up when the operation throws", async () => {
		const { signal, retained } = instrumentedSignal();
		for (let i = 0; i < 10; i++) {
			await withTimeout(1000, signal, async () => {
				throw new Error("boom");
			});
		}
		expect(retained()).toBe(0);
	});

	it("still works correctly after the cleanup (timeout still aborts)", async () => {
		const { signal } = instrumentedSignal();
		const r = await withTimeout(10, signal, async (innerSignal) => {
			return new Promise((_, reject) => {
				innerSignal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.timedOut).toBe(true);
	});
});

	describe("withTimeout — fn that ignores the abort signal", () => {
	it("returns promptly even when fn never resolves and ignores the signal", async () => {
		// The old code awaited fn() directly — if fn ignored the abort signal,
		// withTimeout hung forever despite the timer firing. The Promise.race
		// fix ensures we return when the abort fires, regardless of fn.
		const r = await withTimeout(50, undefined, async () => {
			// Deliberately ignore the signal — never resolve, never reject.
			return new Promise<string>(() => {});
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.timedOut).toBe(true);
	});

	it("returns the value when fn resolves before the timeout", async () => {
		const r = await withTimeout(1000, undefined, async () => "result");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe("result");
	});

	it("returns promptly when fn ignores the signal but resolves late", async () => {
		// fn resolves after 500ms, but the timeout is 50ms. We must return
		// at ~50ms, not 500ms. The abandoned fn's eventual resolution is
		// swallowed by the .catch() in finally.
		const start = Date.now();
		const r = await withTimeout(50, undefined, async () => {
			await new Promise((resolve) => setTimeout(resolve, 500));
			return "late result";
		});
		const elapsed = Date.now() - start;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.timedOut).toBe(true);
		// Should return well before the 500ms fn would have resolved.
		expect(elapsed).toBeLessThan(300);
	});
});

describe("withTimeout — synchronous throw in fn", () => {
	it("catches a sync throw without leaking the timer or parent listener", async () => {
		// Before the Promise.resolve().then() fix, a fn that threw synchronously
		// would skip the try/catch, leaking clearTimeout + cleanup.
		const { signal, retained } = instrumentedSignal();
		const result = await withTimeout(1000, signal, () => {
			throw new Error("sync boom");
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.timedOut).toBe(false);
		expect(retained()).toBe(0);
	});
});

describe("withTimeout — internal abort listener cleanup", () => {
	it("removes the ctrl.signal abort listener when fn wins normally", async () => {
		// The abortPromise attaches a listener to ctrl.signal. If fn resolves
		// before the timeout, that listener must be removed — otherwise, if the
		// callback retains the signal, it leaks. Instrument removeEventListener
		// on the inner signal to verify the cleanup actually fires.
		let abortRemovals = 0;
		const result = await withTimeout(1000, undefined, async (innerSignal) => {
			const origRemove = innerSignal.removeEventListener.bind(innerSignal);
			innerSignal.removeEventListener = ((
				type: string,
				listener?: any,
				opts?: any,
			) => {
				if (type === "abort") abortRemovals++;
				return origRemove(type, listener, opts);
			}) as typeof innerSignal.removeEventListener;
			return "ok";
		});
		expect(result.ok).toBe(true);
		// removeAbortListener() in finally must have removed the abort listener.
		// If this is 0, the cleanup was deleted or broken.
		expect(abortRemovals).toBe(1);
	});
});
