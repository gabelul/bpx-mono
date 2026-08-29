/**
 * resolve-side — shared persona → model/CLI resolution.
 *
 * Extracted from council.ts:resolveCouncilMembers so debate mode can apply the
 * same persona-scoped CLI routing (council §1). Debate previously routed every
 * persona through resolveAdvisor, which silently broke for any persona whose
 * `defaultModel` is undefined (the bundled architect + critic fall back to
 * solo.model) when the intended route was a CLI backend — the registry lookup
 * returned undefined, and the debate bailed with "no api key resolved".
 *
 * Persona-scoped backend precedence is unchanged from council: a persona's own
 * `personas.<name>.backend` wins over the legacy `backends[modelKey]` map, so
 * two personas on the same model can route differently (one inline, one CLI).
 *
 * The result is a discriminated union (`kind: "inline" | "cli"`) so the
 * caller's dispatch is a single `if (side.kind === "cli")` branch. Council's
 * fan-out and debate's sequential rounds share that branch without duplication.
 */

import type { CliBackendConfig } from "./cli-backend.js";
import { cliContextWindow } from "./cli-backend.js";
import type { BpxConsultConfig } from "./config.js";
import { resolvePersonaBackend } from "./config.js";
import type { ResolvedAdvisor } from "./advisor.js";
import type { Persona } from "./personas.js";

export type ResolvedSide =
	| { persona: Persona; kind: "inline"; advisor: ResolvedAdvisor; contextWindow: number; modelLabel: string }
	| { persona: Persona; kind: "cli"; backend: CliBackendConfig; contextWindow: number; modelLabel: string };

export type SideResolution =
	| { ok: true; side: ResolvedSide }
	| { ok: false; persona: string; model: string; errorMessage: string };

/**
 * Resolve a single persona to an inline advisor or a CLI backend.
 *
 * `resolveAdvisor` is injected so tests can stub the registry without a live
 * model-registry. The function never throws — a missing-model or
 * no-known-window outcome returns `{ ok: false, ... }` and lets the caller
 * decide between "skip this seat" (council) and "bail" (debate).
 */
export function resolveSide(
	persona: Persona,
	rawPersona: { backend?: unknown } | undefined,
	config: BpxConsultConfig,
	resolveAdvisorFn: (key: string | undefined) => ResolvedAdvisor | undefined,
): SideResolution {
	const modelKey = persona.defaultModel ?? config.modes?.solo?.model;
	const backend = resolvePersonaBackend(config, {
		backend: rawPersona?.backend,
		defaultModel: modelKey,
	});

	if (backend?.type === "cli") {
		const window = cliContextWindow(backend);
		if (window === undefined) {
			return {
				ok: false,
				persona: persona.name,
				model: `cli:${backend.command}`,
				errorMessage: `CLI backend "${backend.command}" for ${persona.name} has no known context window. Set "contextWindow" on the backend in config, or use a preset command (codex/claude/opencode).`,
			};
		}
		return {
			ok: true,
			side: {
				persona,
				kind: "cli",
				backend,
				contextWindow: window,
				modelLabel: `cli:${backend.command}`,
			},
		};
	}

	const advisor = resolveAdvisorFn(modelKey);
	if (!advisor) {
		return {
			ok: false,
			persona: persona.name,
			model: modelKey ?? "(none)",
			errorMessage: `Could not resolve model "${modelKey ?? "(none)"}" for persona ${persona.name}.`,
		};
	}
	return {
		ok: true,
		side: {
			persona,
			kind: "inline",
			advisor,
			contextWindow: advisor.model.contextWindow,
			modelLabel: advisor.label,
		},
	};
}
