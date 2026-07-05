/**
 * timeout — shared wall-clock budget for consult paths.
 *
 * Two consult paths need a wall-clock cap that the call itself can't provide:
 *   - debate: sequential rounds, total latency = sum-of-rounds, can hang
 *     mid-round with no human to interrupt (consult() is executor-callable →
 *     autonomous). The last unprotected path after council (per-member abort)
 *     and CLI (resolveShellTimeoutMs).
 *   - cli: subprocess timeout via pi.exec's own `timeout` option, but we wrap
 *     it here so the budget lives in one place.
 *
 * The helper races the operation against a timer that fires an AbortController
 * — the same controller whose signal propagates into callAdvisor / pi.exec, so
 * a timeout aborts the in-flight work cleanly rather than leaving it dangling.
 */

/**
 * Run `fn` with a wall-clock timeout. Returns the fn's result, or an error
 * result if the timeout fired first.
 *
 * `parentSignal` (e.g. ctx.signal — user abort) is linked to the controller so
 * a user-initiated abort still propagates; the timeout is an independent second
 * way to fire the same controller.
 *
 * `timeoutMs <= 0` disables the timeout (fn runs with just the parent signal).
 */
export async function withTimeout<T>(
	timeoutMs: number,
	parentSignal: AbortSignal | undefined,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T; timedOut: false } | { ok: false; timedOut: true; signal: AbortSignal } | { ok: false; timedOut: false; error: unknown }> {
	// No timeout: just link the parent and run.
	if (!timeoutMs || timeoutMs <= 0) {
		const { ctrl, cleanup } = linkController(parentSignal);
		try {
			return { ok: true, timedOut: false, value: await fn(ctrl.signal) };
		} catch (error) {
			return { ok: false, timedOut: false, error };
		} finally {
			cleanup();
		}
	}

	const { ctrl, cleanup } = linkController(parentSignal);
	const timer = setTimeout(() => ctrl.abort(new TimeoutError(timeoutMs)), timeoutMs);
	try {
		const value = await fn(ctrl.signal);
		return { ok: true, timedOut: false, value };
	} catch (error) {
		// Distinguish timeout-abort from any other error. The controller's abort
		// reason carries our TimeoutError; anything else is a real failure.
		if (ctrl.signal.aborted && ctrl.signal.reason instanceof TimeoutError) {
			return { ok: false, timedOut: true, signal: ctrl.signal };
		}
		return { ok: false, timedOut: false, error };
	} finally {
		clearTimeout(timer);
		cleanup();
	}
}

/** Custom error so we can identify our own timeout vs a provider/network error. */
export class TimeoutError extends Error {
	constructor(public readonly ms: number) {
		super(`timed out after ${ms}ms`);
		this.name = "TimeoutError";
	}
}

/**
 * Build an AbortController linked to a parent signal: if the parent aborts,
 * this one aborts too (with the same reason). If the parent is already aborted,
 * returns an already-aborted controller. Used by withTimeout and by council's
 * per-member abort isolation (linkSignal re-exported from here for continuity).
 *
 * Returns the controller AND a cleanup function. The cleanup MUST be called
 * when the operation completes (in a finally) — otherwise, if the parent never
 * aborts (the common case), the listener we attached to it leaks forever. Over
 * a long session, every consult call would accumulate one orphan listener on
 * ctx.signal. (Reviewer finding #5 — real leak, fixed.)
 */
function linkController(parent: AbortSignal | undefined): { ctrl: AbortController; cleanup: () => void } {
	const ctrl = new AbortController();
	if (!parent) return { ctrl, cleanup: () => {} };
	if (parent.aborted) {
		ctrl.abort(parent.reason);
		return { ctrl, cleanup: () => {} };
	}
	const onAbort = () => ctrl.abort(parent.reason);
	parent.addEventListener("abort", onAbort, { once: true });
	return {
		ctrl,
		// removeEventListener is a no-op if the listener was already removed (or
		// fired via {once:true}), so calling cleanup after a parent-abort is safe.
		cleanup: () => parent.removeEventListener("abort", onAbort),
	};
}
