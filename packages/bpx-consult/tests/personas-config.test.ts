import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { loadConfig } from "../src/config.js";

const TMP = join(tmpdir(), `bpx-personas-${process.pid}`);
const ORIG = process.env.PI_CODING_AGENT_DIR;
beforeAll(() => { process.env.PI_CODING_AGENT_DIR = TMP; });
afterAll(() => {
	if (ORIG === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = ORIG;
	rmSync(TMP, { recursive: true, force: true });
});

describe("persona overrides load through validateConfig", () => {
	it("preserves per-persona defaultModel after schema cleaning + mergeDefaults", () => {
		mkdirSync(TMP, { recursive: true });
		writeFileSync(join(TMP, "bpx-consult.json"), JSON.stringify({
			defaultMode: "council",
			modes: { solo: { model: "google/gemini-2.5-flash" } },
			personas: {
				architect: { defaultModel: "google/gemini-2.5-flash", thinkingLevel: "low" },
				critic: { defaultModel: "google/gemini-2.5-pro", thinkingLevel: "low" },
				simplifier: { defaultModel: "google/nonexistent-model-xyz", thinkingLevel: "low" },
			},
		}));
		const cfg = loadConfig();
		// These MUST survive — this is the bug the live smoke test caught.
		expect(cfg.personas?.architect?.defaultModel).toBe("google/gemini-2.5-flash");
		expect(cfg.personas?.critic?.defaultModel).toBe("google/gemini-2.5-pro");
		expect(cfg.personas?.simplifier?.defaultModel).toBe("google/nonexistent-model-xyz");
		expect(cfg.defaultMode).toBe("council");
	});
});

describe("project-local config (SPEC §X precedence)", () => {
	const PROJ = join(tmpdir(), `bpx-proj-${process.pid}`);
	afterAll(() => rmSync(PROJ, { recursive: true, force: true }));

	it("reads project-local .pi/bpx-consult.json when trusted", () => {
		mkdirSync(join(PROJ, ".pi"), { recursive: true });
		writeFileSync(join(PROJ, ".pi", "bpx-consult.json"), JSON.stringify({
			personas: { architect: { defaultModel: "project-local-model" } },
		}));
		const cfg = loadConfig({ cwd: PROJ, projectTrusted: true });
		expect(cfg.personas?.architect?.defaultModel).toBe("project-local-model");
	});

	it("IGNORES project-local config when untrusted (security: untrusted repo can't reconfigure the advisor)", () => {
		mkdirSync(join(PROJ, ".pi"), { recursive: true });
		writeFileSync(join(PROJ, ".pi", "bpx-consult.json"), JSON.stringify({
			personas: { architect: { defaultModel: "UNTRUSTED-SHOULD-NOT-LOAD" } },
		}));
		const cfg = loadConfig({ cwd: PROJ, projectTrusted: false });
		expect(cfg.personas?.architect?.defaultModel).not.toBe("UNTRUSTED-SHOULD-NOT-LOAD");
	});

	it("project-local overrides global at the leaf level (deep merge)", () => {
		// global sets architect to global-model; project overrides just that leaf
		writeFileSync(join(TMP, "bpx-consult.json"), JSON.stringify({
			personas: { architect: { defaultModel: "global-model" }, critic: { defaultModel: "global-critic" } },
		}));
		mkdirSync(join(PROJ, ".pi"), { recursive: true });
		writeFileSync(join(PROJ, ".pi", "bpx-consult.json"), JSON.stringify({
			personas: { architect: { defaultModel: "project-wins" } },
		}));
		const cfg = loadConfig({ cwd: PROJ, projectTrusted: true });
		expect(cfg.personas?.architect?.defaultModel).toBe("project-wins");
		expect(cfg.personas?.critic?.defaultModel).toBe("global-critic"); // untouched
	});
});
