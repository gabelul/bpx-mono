import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BpxConsultConfigSchema,
	DEFAULT_CONFIG,
	isDisabledForModel,
	loadConfig,
	saveConfig,
	bpxConfigPath,
} from "../src/config.js";

// Pin PI_CODING_AGENT_DIR at a temp dir for the duration of the suite so the
// real ~/.pi/agent is never touched. bpxConfigPath() honours this env var.
const TMP = join(tmpdir(), `bpx-consult-test-${process.pid}`);
const ORIG_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = TMP;
});

afterAll(() => {
	if (ORIG_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = ORIG_DIR;
	rmSync(TMP, { recursive: true, force: true });
});

describe("config path", () => {
	it("honours PI_CODING_AGENT_DIR", () => {
		expect(bpxConfigPath()).toBe(join(TMP, "bpx-consult.json"));
	});
});

describe("loadConfig — fail-soft", () => {
	it("returns defaults when the file is missing", () => {
		rmSync(bpxConfigPath(), { force: true });
		const cfg = loadConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.defaultMode).toBe("solo");
		expect(cfg.modes?.council?.members).toEqual(["architect", "critic", "simplifier"]);
		expect(cfg.contextBudget?.responseReserveTokens).toBe(4096);
	});

	it("returns defaults when the file is malformed JSON", () => {
		mkdirSync(TMP, { recursive: true });
		writeFileSync(bpxConfigPath(), "{ not valid json !!!");
		const cfg = loadConfig();
		expect(cfg.defaultMode).toBe("solo");
		expect(cfg.enabled).toBe(true);
	});

	it("returns defaults when the file is a non-object JSON value", () => {
		writeFileSync(bpxConfigPath(), '"a string"');
		expect(loadConfig().defaultMode).toBe("solo");
		writeFileSync(bpxConfigPath(), "[1,2,3]");
		expect(loadConfig().defaultMode).toBe("solo");
	});
});

describe("loadConfig — user overrides win, defaults fill gaps", () => {
	it("merges a partial user config over defaults at the section level", () => {
		writeFileSync(
			bpxConfigPath(),
			JSON.stringify({
				defaultMode: "council",
				modes: { solo: { model: "openai/gpt-5" } },
				triggers: { onDone: true },
				personas: { architect: { defaultModel: "anthropic/claude-opus-4-8" } },
			}),
		);
		const cfg = loadConfig();
		// user override
		expect(cfg.defaultMode).toBe("council");
		expect(cfg.modes?.solo?.model).toBe("openai/gpt-5");
		expect(cfg.triggers?.onDone).toBe(true);
		expect(cfg.personas?.architect?.defaultModel).toBe("anthropic/claude-opus-4-8");
		// default fills the gap (solo.thinkingLevel not set by user)
		expect(cfg.modes?.solo?.thinkingLevel).toBe("high");
		// untouched sections keep defaults
		expect(cfg.modes?.council?.members).toEqual(["architect", "critic", "simplifier"]);
		expect(cfg.contextBudget?.responseReserveTokens).toBe(4096);
		// whenStuck not overridden, onDone was — merge is per-field
		expect(cfg.triggers?.whenStuck).toBe(3);
	});

	it("strips unknown top-level keys via validateConfig (Value.Clean)", () => {
		writeFileSync(
			bpxConfigPath(),
			JSON.stringify({ defaultMode: "solo", totallyUnknownKey: "should vanish" }),
		);
		const cfg = loadConfig() as unknown as Record<string, unknown>;
		expect(cfg.totallyUnknownKey).toBeUndefined();
	});
});

describe("saveConfig → loadConfig round-trip", () => {
	it("persists and reloads faithfully", () => {
		const cfg = loadConfig();
		cfg.defaultMode = "gut-check";
		cfg.modes!.solo!.model = "google/gemini-2.5-pro";
		const ok = saveConfig(cfg);
		expect(ok).toBe(true);
		const reloaded = loadConfig();
		expect(reloaded.defaultMode).toBe("gut-check");
		expect(reloaded.modes?.solo?.model).toBe("google/gemini-2.5-pro");
	});
});

describe("schema sanity", () => {
	it("DEFAULT_CONFIG validates against the schema", () => {
		// We don't import Value.Clean here; just assert the default passes
		// a structural check by re-loading it through validateConfig via save/load.
		saveConfig(DEFAULT_CONFIG);
		const reloaded = loadConfig();
		expect(reloaded).toMatchObject({ enabled: true, defaultMode: "solo" });
	});
});

describe("isDisabledForModel", () => {
	it("returns false when no entries", () => {
		expect(isDisabledForModel([], "anthropic/claude-sonnet-4-6", "high")).toBe(false);
		expect(isDisabledForModel(undefined, "any", "low")).toBe(false);
	});

	it("disables unconditionally on a bare-string match", () => {
		expect(isDisabledForModel(["anthropic/claude-sonnet-4-6"], "anthropic/claude-sonnet-4-6", "high")).toBe(true);
		expect(isDisabledForModel(["anthropic/claude-sonnet-4-6"], "openai/gpt-5", "high")).toBe(false);
	});

	it("disables below minEffort but allows at/above", () => {
		const entries = [{ model: "anthropic/claude-sonnet-4-6", minEffort: "high" as const }];
		expect(isDisabledForModel(entries, "anthropic/claude-sonnet-4-6", "medium")).toBe(true);
		expect(isDisabledForModel(entries, "anthropic/claude-sonnet-4-6", "high")).toBe(false);
		expect(isDisabledForModel(entries, "anthropic/claude-sonnet-4-6", "xhigh")).toBe(false);
	});

	it("disables unconditionally on an object entry with no minEffort", () => {
		const entries = [{ model: "anthropic/claude-sonnet-4-6" }];
		expect(isDisabledForModel(entries, "anthropic/claude-sonnet-4-6", "xhigh")).toBe(true);
	});
});

// schema export smoke test — ensures the TypeBox object compiles and is usable
describe("BpxConsultConfigSchema", () => {
	it("is an object schema", () => {
		expect(BpxConsultConfigSchema.type).toBe("object");
	});
});
