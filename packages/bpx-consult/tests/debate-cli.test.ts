/**
 * debate-cli — persona-scoped CLI routing for debate mode.
 *
 * Mirrors council-cli.test.ts. Debate was previously inline-only via
 * resolveAdvisor (debate.ts:executeDebate), which silently broke for any
 * persona whose defaultModel was undefined — the bundled architect/critic
 * fall back to solo.model, and if the intended route was a CLI backend the
 * resolveAdvisor lookup returned undefined and the debate bailed with
 * "no api key resolved" from getAuth (advisor.ts:50).
 *
 * These tests guard the fix: resolveSide (src/resolve-side.ts) is the shared
 * persona→backend resolver; executeDebate now calls it for advocate + critic
 * the same way executeCouncil calls it per-member. Edge cases mirror the
 * council suite so any divergence between modes is caught in CI.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveSide } from "../src/resolve-side.js";
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
		defaultMode: "debate",
		modes: { solo: { model: opts.soloModel ?? "anthropic/claude-haiku-4-5" } },
		personas: opts.personas ?? {},
		backends: opts.backends ?? {},
		triggers: {},
	} as BpxConsultConfig;
}

describe("resolveSide — inline members (debate parity)", () => {
	it("resolves an inline advocate with the registry window", () => {
		const r = resolveSide(persona("architect", "anthropic/claude-haiku-4-5"), undefined, configWith({}), stubRegistry);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.side.kind).toBe("inline");
			expect(r.side.contextWindow).toBe(200_000);
			expect(r.side.modelLabel).toBe("anthropic/claude-haiku-4-5");
		}
	});

	it("falls back to solo.model for a bundled persona without defaultModel", () => {
		// The bundled architect + critic have no defaultModel. Debate previously
		// broke here when solo.model wasn't registered inline — now resolveSide
		// honours the same fallback as council, so debate and council agree on
		// the inline resolution path.
		const r = resolveSide(persona("architect"), undefined, configWith({ soloModel: "anthropic/claude-haiku-4-5" }), stubRegistry);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.side.modelLabel).toBe("anthropic/claude-haiku-4-5");
	});

	it("fails when neither defaultModel nor solo.model is registered", () => {
		const r = resolveSide(persona("critic"), undefined, configWith({ soloModel: "madeup/no-such-model" }), stubRegistry);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.persona).toBe("critic");
			expect(r.model).toBe("madeup/no-such-model");
			expect(r.errorMessage).toMatch(/Could not resolve/);
		}
	});
});

describe("resolveSide — CLI members (debate parity)", () => {
	it("resolves a preset CLI advocate (claude) without pre-failing on the missing registry model", () => {
		// The headline regression: the architect's intended route is the claude
		// CLI; before the fix, this fell through to resolveAdvisor("claude")
		// (the command name, not a model key) and bailed. resolveSide picks
		// the CLI backend first when configured.
		const cfg = configWith({
			backends: { "anthropic/claude-haiku-4-5": { type: "cli", command: "claude" } },
		});
		const r = resolveSide(persona("architect", "anthropic/claude-haiku-4-5"), undefined, cfg, stubRegistry);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.side.kind).toBe("cli");
			expect(r.side.contextWindow).toBeGreaterThan(0);
			expect(r.side.modelLabel).toBe("cli:claude");
		}
	});

	it("uses a declared contextWindow on a custom CLI command", () => {
		const cfg = configWith({ backends: { "local/my-cli": { type: "cli", command: "my-cli", contextWindow: 64_000 } } });
		const r = resolveSide(persona("critic", "local/my-cli"), undefined, cfg, stubRegistry);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.side.contextWindow).toBe(64_000);
	});

	it("pre-fails a custom CLI with NO declared window and NO preset", () => {
		// Council §3 parity: no silent 32k fallback for unknown commands.
		const cfg = configWith({ backends: { "local/mystery": { type: "cli", command: "mystery-tool" } } });
		const r = resolveSide(persona("critic", "local/mystery"), undefined, cfg, stubRegistry);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errorMessage).toMatch(/no known context window/i);
	});
});

describe("resolveSide — persona-scoped routing (council §1 parity)", () => {
	it("persona.backend wins over the legacy backends[modelKey] map", () => {
		// Both backends are configured for the same model; persona.backend should
		// take precedence. Without this, the architect on claude CLI would still
		// resolve as inline (matching the wrong backends entry) instead of CLI.
		const cfg = configWith({
			backends: {
				"anthropic/claude-haiku-4-5": { type: "inline" },
			},
			personas: {
				architect: { backend: { type: "cli", command: "claude" } },
			},
		});
		const r = resolveSide(persona("architect", "anthropic/claude-haiku-4-5"), cfg.personas?.architect, cfg, stubRegistry);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.side.kind).toBe("cli");
			expect(r.side.modelLabel).toBe("cli:claude");
		}
	});

	it("legacy backends[modelKey] still resolves when persona.backend is absent", () => {
		const cfg = configWith({
			backends: { "anthropic/claude-haiku-4-5": { type: "cli", command: "claude" } },
		});
		const r = resolveSide(persona("architect", "anthropic/claude-haiku-4-5"), undefined, cfg, stubRegistry);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.side.kind).toBe("cli");
	});

	it("two personas on the SAME model route differently", () => {
		// The advocate is inline; the critic is CLI. Both reference the same
		// defaultModel; persona-scoped backend decides routing.
		const cfg = configWith({
			personas: {
				critic: { backend: { type: "cli", command: "claude" } },
			},
		});
		const advocate = resolveSide(persona("architect", "anthropic/claude-haiku-4-5"), undefined, cfg, stubRegistry);
		const critic = resolveSide(persona("critic", "anthropic/claude-haiku-4-5"), cfg.personas?.critic, cfg, stubRegistry);
		expect(advocate.ok && advocate.side.kind).toBe("inline");
		expect(critic.ok && critic.side.kind).toBe("cli");
	});
});
