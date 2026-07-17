/**
 * isTooLongError — the Bug A retry trigger.
 *
 * Pure detector for "the provider rejected the payload as too long." Tested
 * against the REAL error strings observed in live sessions so the retry
 * actually fires on them (the whole point — without this matching, the too-long
 * error surfaces to the user instead of triggering a shrink-and-retry).
 */

import { describe, expect, it } from "vitest";
import { isTooLongError } from "../src/solo.js";

describe("isTooLongError (Bug A retry trigger)", () => {
	it("matches the real Anthropic 'prompt is too long' error", () => {
		// The exact error from the user's live session (1M-token overshoot).
		expect(isTooLongError('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1003329 tokens > 1000000 maximum"}}')).toBe(true);
	});

	it("matches 'context length exceeded' variants", () => {
		expect(isTooLongError("This model's maximum context length is 8192 tokens. However, your messages resulted in 9500 tokens.")).toBe(true);
		expect(isTooLongError("request exceeds the maximum context length")).toBe(true);
	});

	it("does NOT match unrelated errors (so the retry only fires on too-long)", () => {
		// The OTHER live error — assistant prefill — must NOT trigger the too-long
		// retry (it's Bug B, a different fix; retrying wouldn't help it).
		expect(isTooLongError('400 {"message":"This model does not support assistant message prefill. The conversation must end with a user message."}')).toBe(false);
		expect(isTooLongError("401 unauthorized")).toBe(false);
		expect(isTooLongError("rate limit exceeded")).toBe(false);
		expect(isTooLongError(undefined)).toBe(false);
		expect(isTooLongError("")).toBe(false);
	});
});
