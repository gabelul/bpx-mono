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
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

// Stub getSupportedThinkingLevels: return whatever the test programs.
const supportedMock = vi.fn<(m: Model<Api> | undefined) => ThinkingLevel[]>();
vi.mock("@earendil-works/pi-ai", () => ({
	getSupportedThinkingLevels: (m: Model<Api> | undefined) => supportedMock(m),
}));

// Import AFTER the mock is registered.
const {
	buildModelItems,
	buildCodexModelItems,
	buildEffortItems,
	buildModeItems,
	buildToggleItems,
	buildWhenStuckItems,
	buildRoundsItems,
	buildPersonaItems,
	debateRoleProse,
	buildStanceItems,
	buildMainMenu,
	buildCouncilMenu,
	buildBackendItems,
	describePersonaBackend,
	probeInlineModel,
	parseCliArgs,
	parseContextWindow,
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

describe("buildCodexModelItems", () => {
	it("offers CLI default and CLI models, never pi provider keys", () => {
		const items = buildCodexModelItems([{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }], undefined);
		expect(items.map((item) => item.value)).toEqual(["__codex_default__", "gpt-5.6-sol", "__codex_manual__", "__codex_refresh__"]);
		expect(items[0]?.label).toContain("✓");
	});

	it("retains an unlisted saved model when discovery returns nothing", () => {
		const items = buildCodexModelItems([], "gpt-6-sol");
		expect(items.find((item) => item.value === "gpt-6-sol")?.label).toContain("saved, not listed");
		expect(items.find((item) => item.value === "gpt-6-sol")?.label).toContain("✓");
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

describe("buildRoundsItems / buildPersonaItems", () => {
	it("offers rounds 1–4 and marks the current", () => {
		const items = buildRoundsItems(2);
		expect(items.map((i) => i.value)).toEqual(["1", "2", "3", "4"]);
		expect(items.find((i) => i.value === "2")?.label).toContain("✓");
		expect(items.find((i) => i.value === "3")?.label).toBe("3");
	});

	it("lists persona names and marks the current role holder", () => {
		const items = buildPersonaItems(["architect", "critic", "simplifier"], "critic");
		expect(items.map((i) => i.value)).toEqual(["architect", "critic", "simplifier"]);
		expect(items.find((i) => i.value === "critic")?.label).toContain("✓");
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
		// Progressive disclosure: solo collapsed to ONE summary line.
		expect(items.some((i) => i.value === "solo.detail" && i.label.startsWith("Solo —"))).toBe(true);
	});

	it("has ONE council entry and no per-member rows (collapsed)", () => {
		// After the tidy-up: council editing lives behind a single submenu entry.
		// No persona.* rows, no council.synth on the main menu — those moved to the
		// submenu (buildCouncilMenu) so there's no dead-end "basic" path.
		const items = buildMainMenu(DEFAULT_CONFIG);
		expect(items.some((i) => i.value === "council.manage")).toBe(true);
		expect(items.filter((i) => i.value.startsWith("persona.")).length).toBe(0);
		expect(items.some((i) => i.value === "council.synth")).toBe(false);
	});

	it("is short — mode summary lines, one council entry, triggers, enabled, done", () => {
		// Progressive disclosure (2026-09): one summary line per mode opening a
		// detail submenu — 9 rows instead of the old 13.
		const items = buildMainMenu(DEFAULT_CONFIG);
		expect(items.map((i) => i.value)).toEqual([
			"defaultMode",
			"solo.detail",
			"gutCheck.detail",
			"debate.detail",
			"council.manage",
			"triggers.onDone",
			"triggers.whenStuck",
			"enabled",
			"__done__",
		]);
	});

	it("summarizes each mode in its line: model, thinking, roles, rounds", () => {
		const items = buildMainMenu({
			...DEFAULT_CONFIG,
			modes: {
				...DEFAULT_CONFIG.modes!,
				solo: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
				debate: { advocate: "architect", critic: "critic", rounds: 3 },
			},
			triggers: { onDone: false, whenStuck: 3 },
		});
		expect(items.find((i) => i.value === "solo.detail")?.label).toBe("Solo — inline/gpt-5.6-sol, thinking high");
		expect(items.find((i) => i.value === "debate.detail")?.label).toBe("Debate — architect vs critic, 3 rounds");
		// Unassigned roles render as (unassigned); singular rounds reads correctly.
		const bare = buildMainMenu({ ...DEFAULT_CONFIG, modes: { ...DEFAULT_CONFIG.modes!, debate: {} } });
		expect(bare.find((i) => i.value === "debate.detail")?.label).toBe("Debate — (unassigned) vs (unassigned), 2 rounds");
		expect(items.find((i) => i.value === "triggers.whenStuck")?.label).toBe("Trigger — whenStuck: 3 attempts");
		const off = buildMainMenu(DEFAULT_CONFIG);
		expect(off.find((i) => i.value === "triggers.whenStuck")?.label).toBe("Trigger — whenStuck: off");
	});

	it("describes a dead model key without crashing (falls back to the raw key)", () => {
		// A model key whose provider/modelId can't be parsed should still render.
		const items = buildMainMenu({ ...DEFAULT_CONFIG, modes: { ...DEFAULT_CONFIG.modes!, solo: { model: "garbage-no-slash" } } });
		const soloRow = items.find((i) => i.value === "solo.detail");
		expect(soloRow?.label).toContain("garbage-no-slash");
	});

	describe("debateRoleProse", () => {
		it("names the persona's own model so a role pick is never a silent surprise", () => {
			const config = {
				...DEFAULT_CONFIG,
				personas: { simplifier: { defaultModel: "google/gemini-2.5-flash" } },
				modes: { ...DEFAULT_CONFIG.modes!, debate: { advocate: "simplifier", critic: "critic", rounds: 2 } },
			};
			const prose = debateRoleProse(config as never, "advocate").join(" ");
			expect(prose).toContain("simplifier");
			expect(prose).toContain("gemini-2.5-flash");
			expect(prose).toContain("Council members");
		});

		it("tells the user when no persona is assigned", () => {
			const config = { ...DEFAULT_CONFIG, modes: { ...DEFAULT_CONFIG.modes!, debate: {} } };
			const prose = debateRoleProse(config as never, "critic");
			expect(prose.some((line) => line.includes("No persona assigned"))).toBe(true);
		});
	});
});

describe("buildStanceItems", () => {
	it("lists for/against/neutral and marks the current", () => {
		const items = buildStanceItems("against");
		expect(items.map((i) => i.value)).toEqual(["for", "against", "neutral"]);
		expect(items.find((i) => i.value === "against")?.label).toContain("✓");
	});
});

describe("buildCouncilMenu", () => {
	it("lists one entry per seated member with its model", () => {
		const items = buildCouncilMenu(DEFAULT_CONFIG);
		expect(items.some((i) => i.value === "member.architect")).toBe(true);
		expect(items.some((i) => i.value === "member.critic")).toBe(true);
		expect(items.some((i) => i.value === "member.simplifier")).toBe(true);
		// architect's default model shows in its row
		expect(items.find((i) => i.value === "member.architect")?.label).toMatch(/opus/i);
	});

	it("shows the active Codex model, not the saved inline model", () => {
		const cfg = {
			...DEFAULT_CONFIG,
			personas: { critic: { defaultModel: "anthropic/claude-sonnet-4-6", codexModel: "gpt-5.6-sol", backend: { type: "cli", command: "codex" } } },
		};
		expect(buildCouncilMenu(cfg as never).find((i) => i.value === "member.critic")?.label).toContain("gpt-5.6-sol");
		expect(buildCouncilMenu(cfg as never).find((i) => i.value === "member.critic")?.label).not.toContain("sonnet");
	});

	it("always offers seats/add/synthesizer/back — no separate disable/enable rows", () => {
		const items = buildCouncilMenu(DEFAULT_CONFIG);
		expect(items.some((i) => i.value === "seats")).toBe(true);
		expect(items.some((i) => i.value === "add")).toBe(true);
		expect(items.some((i) => i.value === "council.synth")).toBe(true);
		expect(items.some((i) => i.value === "disable")).toBe(false);
		expect(items.some((i) => i.value === "enable")).toBe(false);
		expect(items.some((i) => i.value === "add.ai")).toBe(false);
		expect(items[items.length - 1]?.value).toBe("__back__");
	});

	it("offers the single seats toggle regardless of roster state", () => {
		// The old enable/disable pair collapsed into one toggle over all personas;
		// no more per-state label math.
		const config = {
			...DEFAULT_CONFIG,
			modes: { ...DEFAULT_CONFIG.modes, council: { ...DEFAULT_CONFIG.modes!.council!, members: ["architect"] } },
			personas: {
				architect: { defaultModel: "anthropic/claude-opus-4-6" },
				critic: { defaultModel: "anthropic/claude-sonnet-4-6" },
			},
		};
		const seatsRow = buildCouncilMenu(config).find((i) => i.value === "seats");
		expect(seatsRow?.label).toBe("Seat or unseat personas…");
	});

	it("collapses synthesizer model + thinking into one detail row", () => {
		const row = buildCouncilMenu(DEFAULT_CONFIG).find((i) => i.value === "council.synth");
		expect(row?.label).toMatch(/^Synthesizer — .+, thinking /);
		expect(buildCouncilMenu(DEFAULT_CONFIG).some((i) => i.value === "council.synthEffort")).toBe(false);
	});

	it("renders an empty-roster council without crashing", () => {
		const config = {
			...DEFAULT_CONFIG,
			modes: { ...DEFAULT_CONFIG.modes, council: { ...DEFAULT_CONFIG.modes!.council!, members: [] } },
			personas: {},
		};
		const items = buildCouncilMenu(config);
		expect(items.some((i) => i.value === "seats")).toBe(true);
		expect(items.some((i) => i.value === "add")).toBe(true);
		expect(items.filter((i) => i.value.startsWith("member.")).length).toBe(0);
	});
});

	describe("regression: default personas surface through loadConfig", () => {
	it("an empty config yields the 3 default tier-distinct personas", () => {
		// The bug: mergeDefaults did `personas: user.personas ?? {}`, dropping the
		// bundled roster → council members fell back to the solo model → same
		// provider → parallel rate-limit abort. Fixed by merging defaults per-key.
		const orig = process.env.PI_CODING_AGENT_DIR;
		const tmp = `/tmp/bpx-persona-reg-${process.pid}`;
		const { rmSync, mkdirSync } = require("node:fs");
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = tmp;
		try {
			const c = loadConfig({});
			expect(Object.keys(c.personas ?? {}).sort()).toEqual(["architect", "critic", "simplifier"]);
			expect(c.personas!.architect!.defaultModel).toMatch(/opus/i);
			expect(c.personas!.critic!.defaultModel).toMatch(/sonnet/i);
			expect(c.personas!.simplifier!.defaultModel).toMatch(/haiku/i);
		} finally {
			process.env.PI_CODING_AGENT_DIR = orig;
		}
	});
});

describe("describePersonaBackend + buildBackendItems", () => {
	it("reports inline when no backend is configured", () => {
		expect(describePersonaBackend({ personas: {}, backends: {} } as never, { defaultModel: "anthropic/x" })).toBe("inline");
	});

	it("reports cli:<command> for a persona-scoped CLI backend", () => {
		const cfg = { personas: {}, backends: {} } as never;
		expect(describePersonaBackend(cfg, { backend: { type: "cli", command: "codex" } })).toBe("cli:codex");
	});

	it("falls back to a legacy model-key backend when persona has none", () => {
		const cfg = { personas: {}, backends: { "openai/codex": { type: "cli", command: "codex" } } } as never;
		expect(describePersonaBackend(cfg, { defaultModel: "openai/codex" })).toBe("cli:codex");
	});

	it("buildBackendItems lists inline + 3 presets + custom + remove, marking the current", () => {
		const cfg = { personas: {}, backends: {} } as never;
		const items = buildBackendItems(cfg, { backend: { type: "cli", command: "claude" } });
		expect(items.map((i) => i.value)).toEqual(["inline", "cli:codex", "cli:claude", "cli:opencode", "__custom__", "__remove__"]);
		expect(items.find((i) => i.value === "cli:claude")?.label).toContain("✓");
		expect(items.find((i) => i.value === "cli:codex")?.label).not.toContain("✓");
	});
});

describe("probeInlineModel (pre-assign candidate test)", () => {
	it("fails fast with a clear detail when the candidate model isn't in the registry — no network call", async () => {
		// The test-before-assign path must not even try a network call for a model
		// that can't resolve; it should fail with a registry-miss detail so the
		// user knows to pick a real model, not wait on a timeout.
		const stubCtx = { modelRegistry: { find: () => undefined } } as never;
		const persona = { name: "critic", stance: "against", systemPrompt: "x" } as never;
		const r = await probeInlineModel(stubCtx, "madeup/no-such-model", persona);
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/isn't in the registry/);
	});
});

describe("parseCliArgs (structured argv, never shell)", () => {
	it("splits comma-separated args, trims, drops blanks", () => {
		expect(parseCliArgs("exec, --read-only ,  -v")).toEqual(["exec", "--read-only", "-v"]);
	});
	it("returns undefined for empty / blank-only input (no empty argv)", () => {
		expect(parseCliArgs("")).toBeUndefined();
		expect(parseCliArgs("   ")).toBeUndefined();
		expect(parseCliArgs(undefined)).toBeUndefined();
	});
	it("drops trailing commas and empty segments", () => {
		expect(parseCliArgs("exec,,")).toEqual(["exec"]);
	});
	it("never joins into a shell string — output is always an array", () => {
		// Injection-safety: a value like `; rm -rf /` becomes one argv element,
		// not a shell metacharacter, because spawn uses argv not a shell.
		const r = parseCliArgs("; rm -rf /");
		expect(Array.isArray(r)).toBe(true);
		expect(r).toEqual(["; rm -rf /"]);
	});
});

describe("parseContextWindow (required, no fallback)", () => {
	it("accepts a positive integer", () => {
		expect(parseContextWindow("200000")).toBe(200_000);
		expect(parseContextWindow("  32768 ")).toBe(32_768);
	});
	it("rejects empty / blank (required — no silent fallback)", () => {
		expect(parseContextWindow("")).toBeNull();
		expect(parseContextWindow(undefined)).toBeNull();
	});
	it("rejects zero and negatives", () => {
		expect(parseContextWindow("0")).toBeNull();
		expect(parseContextWindow("-100")).toBeNull();
	});
	it("rejects non-integers", () => {
		expect(parseContextWindow("200k")).toBeNull();
		expect(parseContextWindow("1.5")).toBeNull();
		expect(parseContextWindow("abc")).toBeNull();
	});
});
