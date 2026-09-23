/**
 * clampThinkingLevel — the shared effort-normalization guard every inline
 * advisor call goes through. Config values can exceed a model's support
 * (JSON edits, AI-generated personas, model reassignment), so the clamp must:
 * pass through supported levels, pick the highest supported level below an
 * unsupported request, fall back to the lowest supported level when nothing
 * sits below, and leave "model default" (undefined) untouched.
 */

import type { Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
	getSupportedThinkingLevels: (m: { supported?: ModelThinkingLevel[] } | undefined) => m?.supported ?? ["minimal", "low", "medium", "high"],
}));

const { clampThinkingLevel } = await import("../src/advisor.js");

function modelWith(supported: ModelThinkingLevel[]): Model<never> {
	return { supported } as never;
}

describe("clampThinkingLevel", () => {
	it("passes through a supported level untouched", () => {
		const m = modelWith(["minimal", "low", "medium", "high", "xhigh"]);
		expect(clampThinkingLevel(m, "high")).toBe("high");
		expect(clampThinkingLevel(m, "xhigh")).toBe("xhigh");
	});

	it("picks the highest supported level below an unsupported request", () => {
		const m = modelWith(["minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(m, "xhigh")).toBe("high");
		const lower = modelWith(["minimal", "low"]);
		expect(clampThinkingLevel(lower, "high")).toBe("low");
	});

	it("falls back to the LOWEST supported level when nothing sits below", () => {
		const m = modelWith(["medium", "high"]);
		expect(clampThinkingLevel(m, "low")).toBe("medium");
	});

	it("omits reasoning for a model that supports only off", () => {
		const m = modelWith(["off"]);
		expect(clampThinkingLevel(m, "high")).toBeUndefined();
	});

	it("undefined (model default) passes through", () => {
		const m = modelWith(["minimal", "low"]);
		expect(clampThinkingLevel(m, undefined)).toBeUndefined();
	});
});
