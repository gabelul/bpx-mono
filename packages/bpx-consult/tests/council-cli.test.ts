/**
 * resolveCouncilMembers — the CLI-vs-inline decision + window fallback.
 *
 * This is the new logic the mixed inline+CLI council adds: a persona whose
 * model has a CLI backend configured routes through callCliAdvisor (and never
 * pre-fails on resolution, since a CLI binary isn't in the registry); its
 * context window falls back to 32k when the key isn't registered. Pure helper,
 * resolveAdvisor injected, so we test the decision without a live registry.
 *
 * Every test is an edge case — happy paths don't catch the bugs (a CLI member
 * wrongly pre-failing, a window falling back when it shouldn't, a mixed roster
 * mis-routing).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveCouncilMembers } from "../src/council.js";
import type { BpxConsultConfig } from "../src/config.js";
import type { Persona } from "../src/personas.js";
import type { ResolvedAdvisor } from "../src/advisor.js";

const CLI_FALLBACK_WINDOW = 32_000;

function persona(name: string, defaultModel?: string): Persona {
	return { name, systemPrompt: `prompt for ${name}`, stance: name === "critic" ? "against" : "neutral", defaultModel };
}

function advisor(provider: string, id: string, contextWindow: number): ResolvedAdvisor {
	return {
		label: `${provider}/${id}`,
		model: { provider, id, contextWindow } as unknown as Model<Api>,
	};
}

/** Stub registry: knows anthropic/* and google/*, nothing else. */
function stubRegistry(key: string | undefined): ResolvedAdvisor | undefined {
	if (!key) return undefined;
	if (key === "anthropic/claude-haiku-4-5") return advisor("anthropic", "claude-haiku-4-5", 200_000);
	if (key === "google/gemini-2.5-flash") return advisor("google", "gemini-2.5-flash", 1_000_000);
	return undefined;
}

function configWith(opts: { backends?: BpxConsultConfig["backends"]; soloModel?: string }): BpxConsultConfig {
	return {
		enabled: true,
		defaultMode: "council",
		modes: { solo: { model: opts.soloModel ?? "anthropic/claude-haiku-4-5" } },
		personas: {},
		backends: opts.backends ?? {},
		triggers: {},
	} as BpxConsultConfig;
}

describe("resolveCouncilMembers — inline members", () => {
	it("resolves an inline member (no backend) with the registry window", () => {
		const { resolved, preFailed } = resolveCouncilMembers(
			[persona("architect", "anthropic/claude-haiku-4-5")],
			configWith({}),
			stubRegistry,
		);
		expect(preFailed).toHaveLength(0);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.kind).toBe("inline");
		if (resolved[0]?.kind === "inline") expect(resolved[0].contextWindow).toBe(200_000);
	});

	it("pre-fails an inline member whose model isn't in the registry (one bad model doesn't kill the council)", () => {
		const { resolved, preFailed } = resolveCouncilMembers(
			[persona("architect", "madeup/no-such-model")],
			configWith({}),
			stubRegistry,
		);
		expect(resolved).toHaveLength(0);
		expect(preFailed).toHaveLength(1);
		expect(preFailed[0]?.status).toBe("error");
		expect(preFailed[0]?.errorMessage).toMatch(/Could not resolve/);
	});
});

describe("resolveCouncilMembers — CLI members", () => {
	it("resolves a CLI member and NEVER pre-fails even when the model isn't registered", () => {
		// The whole point: a CLI binary isn't in the registry, so a CLI member
		// must not be treated as a resolution failure the way an inline one is.
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved, preFailed } = resolveCouncilMembers([persona("critic", "openai/codex")], cfg, stubRegistry);
		expect(preFailed).toHaveLength(0);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.kind).toBe("cli");
	});

	it("falls back to 32k when the CLI member's modelKey isn't registered", () => {
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved } = resolveCouncilMembers([persona("critic", "openai/codex")], cfg, stubRegistry);
		expect(resolved[0]?.contextWindow).toBe(CLI_FALLBACK_WINDOW);
	});

	it("uses the registry window when the CLI member's modelKey IS registered", () => {
		// Keying a CLI backend to a known small model lets the fit use that
		// model's real window instead of the conservative 32k floor.
		const cfg = configWith({ backends: { "google/gemini-2.5-flash": { type: "cli", command: "gemini" } } });
		const { resolved } = resolveCouncilMembers([persona("critic", "google/gemini-2.5-flash")], cfg, stubRegistry);
		expect(resolved[0]?.kind).toBe("cli");
		expect(resolved[0]?.contextWindow).toBe(1_000_000);
	});

	it("carries the modelKey as the label (CLI members have no resolved advisor.label)", () => {
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved } = resolveCouncilMembers([persona("critic", "openai/codex")], cfg, stubRegistry);
		expect(resolved[0]?.modelLabel).toBe("openai/codex");
	});
});

describe("resolveCouncilMembers — mixed rosters", () => {
	it("routes a mixed inline+CLI roster correctly (the headline feature)", () => {
		// architect inline on haiku, critic via codex CLI, simplifier inline on flash.
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved, preFailed } = resolveCouncilMembers(
			[persona("architect", "anthropic/claude-haiku-4-5"), persona("critic", "openai/codex"), persona("simplifier", "google/gemini-2.5-flash")],
			cfg,
			stubRegistry,
		);
		expect(preFailed).toHaveLength(0);
		expect(resolved.map((m) => m.kind)).toEqual(["inline", "cli", "inline"]);
		expect(resolved.map((m) => m.modelLabel)).toEqual([
			"anthropic/claude-haiku-4-5",
			"openai/codex",
			"google/gemini-2.5-flash",
		]);
	});

	it("a persona with no defaultModel falls back to solo.model", () => {
		const { resolved } = resolveCouncilMembers([persona("architect")], configWith({ soloModel: "anthropic/claude-haiku-4-5" }), stubRegistry);
		expect(resolved[0]?.kind).toBe("inline");
		expect(resolved[0]?.modelLabel).toBe("anthropic/claude-haiku-4-5");
	});

	it("pre-failed and resolved can coexist (one bad inline model alongside good ones)", () => {
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved, preFailed } = resolveCouncilMembers(
			[persona("architect", "anthropic/claude-haiku-4-5"), persona("critic", "madeup/x"), persona("simplifier", "openai/codex")],
			cfg,
			stubRegistry,
		);
		expect(resolved.map((m) => m.kind)).toEqual(["inline", "cli"]);
		expect(preFailed.map((p) => p.persona)).toEqual(["critic"]);
	});
});
