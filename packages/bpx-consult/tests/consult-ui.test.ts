/**
 * consult-ui builder + dispatch-logic tests.
 *
 * The pure item-builders are the edge-case-prone surface: empty model lists,
 * xhigh gating per model, missing personas, dead model keys, checkmark logic.
 * These tests trip those branches directly rather than happy-pathing through
 * the menu. The interactive loop itself (runConsultConfigurator) needs a live
 * TUI and isn't unit-tested here — its inputs/outputs are the builders.
 *
 * getSupportedThinkingLevels is mocked so the xhigh-gating test is
 * deterministic and doesn't depend on the real registry's per-model answer.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

// Stub getSupportedThinkingLevels: return whatever the test programs.
const supportedMock = vi.fn<(m: Model<Api> | undefined) => ThinkingLevel[]>();
vi.mock("@earendil-works/pi-ai", () => ({
	getSupportedThinkingLevels: (m: Model<Api> | undefined) => supportedMock(m),
}));

// Import AFTER the mock is registered.
const {
	buildModelItems,
	buildEffortItems,
	buildModeItems,
	buildToggleItems,
	buildWhenStuckItems,
	buildMainMenu,
} = await import("../src/consult-ui.js");

/** Minimal Model stub — modelKey reads {provider, id}; pickers read .name/.provider. */
function model(provider: string, id: string, name = id): Model<Api> {
	return { provider, id, name } as unknown as Model<Api>;
}

beforeEach(() => supportedMock.mockReset());

describe("buildModelItems", () => {
	it("returns a single 'no models' sentinel when nothing is available", () => {
		const items = buildModelItems([], undefined);
		expect(items).toHaveLength(1);
		expect(items[0]?.value).toBe("__none__");
		expect(items[0]?.label).toMatch(/no models/i);
	});

	it("marks the current model with a checkmark", () => {
		const available = [model("anthropic", "claude-opus-4-6", "Claude Opus"), model("openai", "gpt-5", "GPT-5")];
		const items = buildModelItems(available, "openai/gpt-5");
		const gpt = items.find((i) => i.value === "openai/gpt-5");
		const opus = items.find((i) => i.value === "anthropic/claude-opus-4-6");
		expect(gpt?.label).toContain("✓");
		expect(opus?.label).not.toContain("✓");
	});

	it("emits provider/model values, not label text, as the persisted key", () => {
		const available = [model("anthropic", "claude-opus-4-6", "Claude Opus")];
		const items = buildModelItems(available, undefined);
		expect(items[0]?.value).toBe("anthropic/claude-opus-4-6");
	});

	it("leaves nothing checked when currentKey is undefined", () => {
		const available = [model("anthropic", "claude-opus-4-6", "Claude Opus")];
		const items = buildModelItems(available, undefined);
		expect(items.every((i) => !i.label.includes("✓"))).toBe(true);
	});
});

describe("buildEffortItems", () => {
	it("returns the base four levels when the model has no xhigh", () => {
		supportedMock.mockReturnValue(["minimal", "low", "medium", "high"]);
		const items = buildEffortItems(model("anthropic", "x"), "high");
		expect(items.map((i) => i.value)).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("adds xhigh when the model supports it", () => {
		supportedMock.mockReturnValue(["minimal", "low", "medium", "high", "xhigh"]);
		const items = buildEffortItems(model("anthropic", "x"), undefined);
		expect(items.map((i) => i.value)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("falls back to base four when no model is set (undefined)", () => {
		// The effort picker must still work before a model is chosen — base four
		// is the safe default, never xhigh-on-an-unsupported-model.
		const items = buildEffortItems(undefined, undefined);
		expect(items.map((i) => i.value)).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("marks the current effort with a checkmark", () => {
		supportedMock.mockReturnValue(["minimal", "low", "medium", "high"]);
		const items = buildEffortItems(model("anthropic", "x"), "low");
		const low = items.find((i) => i.value === "low");
		expect(low?.label).toContain("✓");
	});
});

describe("buildModeItems", () => {
	it("lists all four modes and marks the current", () => {
		const items = buildModeItems("council");
		expect(items.map((i) => i.value)).toEqual(["solo", "council", "debate", "gut-check"]);
		expect(items.find((i) => i.value === "council")?.label).toContain("✓");
	});
});

describe("buildToggleItems", () => {
	it("marks the current boolean", () => {
		expect(buildToggleItems(true).find((i) => i.value === "true")?.label).toContain("✓");
		expect(buildToggleItems(false).find((i) => i.value === "false")?.label).toContain("✓");
		expect(buildToggleItems(true).find((i) => i.value === "false")?.label).not.toContain("✓");
	});
});

describe("buildWhenStuckItems", () => {
	it("labels 0 as off and marks the current count", () => {
		const items = buildWhenStuckItems(3);
		expect(items.find((i) => i.value === "0")?.label).toBe("off");
		expect(items.find((i) => i.value === "3")?.label).toContain("✓");
		expect(items.find((i) => i.value === "0")?.label).not.toContain("✓");
	});
});

describe("buildMainMenu", () => {
	it("always ends with a Done entry", () => {
		const items = buildMainMenu(DEFAULT_CONFIG);
		expect(items[items.length - 1]?.value).toBe("__done__");
	});

	it("surfaces the current default mode and solo model in labels", () => {
		const items = buildMainMenu(DEFAULT_CONFIG);
		expect(items.some((i) => i.label.startsWith("Default mode:"))).toBe(true);
		expect(items.some((i) => i.label.startsWith("Solo model:"))).toBe(true);
	});

	it("adds one row per persona, including user-defined ones", () => {
		const config = {
			...DEFAULT_CONFIG,
			personas: {
				architect: { defaultModel: "anthropic/claude-opus-4-6" },
				security: { defaultModel: "anthropic/claude-sonnet-4-6" }, // user-defined seat
			},
		};
		const items = buildMainMenu(config);
		expect(items.some((i) => i.value === "persona.architect")).toBe(true);
		expect(items.some((i) => i.value === "persona.security")).toBe(true);
		expect(items.filter((i) => i.value.startsWith("persona.")).length).toBe(2);
	});

	it("omits persona rows entirely when personas is empty", () => {
		const items = buildMainMenu({ ...DEFAULT_CONFIG, personas: {} });
		expect(items.filter((i) => i.value.startsWith("persona.")).length).toBe(0);
	});

	it("shows the synthesizer row only when a synthesizer is configured", () => {
		const withSynth = buildMainMenu(DEFAULT_CONFIG);
		expect(withSynth.some((i) => i.value === "council.synth")).toBe(true);

		const noSynth = buildMainMenu({
			...DEFAULT_CONFIG,
			modes: { ...DEFAULT_CONFIG.modes, council: { ...DEFAULT_CONFIG.modes!.council!, synthesizer: undefined } },
		});
		expect(noSynth.some((i) => i.value === "council.synth")).toBe(false);
	});

	it("describes a dead model key without crashing (falls back to the raw key)", () => {
		// A model key whose provider/modelId can't be parsed should still render.
		const items = buildMainMenu({ ...DEFAULT_CONFIG, modes: { ...DEFAULT_CONFIG.modes!, solo: { model: "garbage-no-slash" } } });
		const soloRow = items.find((i) => i.value === "solo.model");
		expect(soloRow?.label).toContain("garbage-no-slash");
	});
});
