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

function configWith(opts: { backends?: BpxConsultConfig["backends"]; soloModel?: string; personas?: BpxConsultConfig["personas"] }): BpxConsultConfig {
	return {
		enabled: true,
		defaultMode: "council",
		modes: { solo: { model: opts.soloModel ?? "anthropic/claude-haiku-4-5" } },
		personas: opts.personas ?? {},
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
	it("resolves a preset CLI member (codex) with its preset window, never pre-failing on the missing registry model", () => {
		// A CLI binary isn't in the registry; a preset command (codex/claude/opencode)
		// resolves with its built-in window rather than guessing or failing.
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved, preFailed } = resolveCouncilMembers([persona("critic", "openai/codex")], cfg, stubRegistry);
		expect(preFailed).toHaveLength(0);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.kind).toBe("cli");
		expect(resolved[0]?.contextWindow).toBe(200_000); // codex preset
	});

	it("uses a declared contextWindow on a custom CLI command", () => {
		// Council §3: custom JSON backends must declare a window. A declared one wins.
		const cfg = configWith({ backends: { "local/my-cli": { type: "cli", command: "my-cli", contextWindow: 64_000 } } });
		const { resolved, preFailed } = resolveCouncilMembers([persona("critic", "local/my-cli")], cfg, stubRegistry);
		expect(preFailed).toHaveLength(0);
		expect(resolved[0]?.kind).toBe("cli");
		expect(resolved[0]?.contextWindow).toBe(64_000);
	});

	it("pre-fails a custom CLI with NO declared window and NO preset (the 32k fallback is gone)", () => {
		// Council §3: remove the unverified 32k fallback. An unknown command with
		// no declared window must fail clearly, not silently guess a window.
		const cfg = configWith({ backends: { "local/mystery": { type: "cli", command: "mystery-tool" } } });
		const { resolved, preFailed } = resolveCouncilMembers([persona("critic", "local/mystery")], cfg, stubRegistry);
		expect(resolved).toHaveLength(0);
		expect(preFailed).toHaveLength(1);
		expect(preFailed[0]?.errorMessage).toMatch(/no known context window/i);
	});

	it("labels a CLI member as cli:<command>", () => {
		const cfg = configWith({ backends: { "openai/codex": { type: "cli", command: "codex" } } });
		const { resolved } = resolveCouncilMembers([persona("critic", "openai/codex")], cfg, stubRegistry);
		expect(resolved[0]?.modelLabel).toBe("cli:codex");
	});
});

describe("resolveCouncilMembers — persona-scoped routing (council §1)", () => {
	it("two personas on the SAME model route differently when one has a persona.backend", () => {
		// The headline of the proper-B redesign: the legacy model-key map can't
		// express this — only persona-scoped backend can.
		const cfg = configWith({
			personas: {
				architect: { defaultModel: "anthropic/claude-haiku-4-5" }, // inline
				critic: { defaultModel: "anthropic/claude-haiku-4-5", backend: { type: "cli", command: "codex" } }, // CLI, same model key
			},
		});
		const { resolved } = resolveCouncilMembers(
			[persona("architect", "anthropic/claude-haiku-4-5"), persona("critic", "anthropic/claude-haiku-4-5")],
			cfg,
			stubRegistry,
		);
		expect(resolved.map((m) => m.kind)).toEqual(["inline", "cli"]);
		expect(resolved[1]?.modelLabel).toBe("cli:codex");
	});

	it("persona.backend takes precedence over a legacy model-key backend entry", () => {
		// Same model key has a legacy CLI backend, but the persona says inline →
		// persona wins. defaultModel is registry-known so inline actually resolves.
		const cfg = configWith({
			backends: { "anthropic/claude-haiku-4-5": { type: "cli", command: "codex" } }, // legacy says CLI
			personas: { critic: { defaultModel: "anthropic/claude-haiku-4-5", backend: { type: "inline" } } }, // persona says inline
		});
		const { resolved } = resolveCouncilMembers([persona("critic", "anthropic/claude-haiku-4-5")], cfg, stubRegistry);
		expect(resolved[0]?.kind).toBe("inline");
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
			"cli:codex",
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
