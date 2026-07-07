/**
 * config — persisted bpx-consult config.
 *
 * Lives at the pi-native path `~/.pi/agent/bpx-consult.json` (not rpiv's
 * `~/.config` convention) because bpx-consult is a pi extension first and
 * should sit alongside pi's own state. Reuses @juicesharp/rpiv-config for
 * the crash-resistant load/save + TypeBox-driven validate primitives rather
 * than hand-rolling JSON I/O.
 *
 * Schema mirrors SPEC §X. personas and backends are intentionally left open
 * (additionalProperties) so user-defined persona names and CLI commands
 * survive validation instead of being stripped by Value.Clean.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { loadJsonConfig, saveJsonConfig, validateConfig } from "@juicesharp/rpiv-config";
import { type Static, type TObject, Type } from "typebox";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const ThinkingLevelSchema = Type.Union(
	[
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
	],
	{ description: "Reasoning effort. Mirrors @earendil-works/pi-ai ThinkingLevel." },
);

const FeedbackModeSchema = Type.Union(
	[Type.Literal("show"), Type.Literal("pipe"), Type.Literal("steer")],
	{ description: "How the advisor's response reaches the executor." },
);

/** How injected advice (phrase/manual paths) reaches the executor. */
export type FeedbackMode = Static<typeof FeedbackModeSchema>;

const ConsultModeSchema = Type.Union(
	[Type.Literal("solo"), Type.Literal("council"), Type.Literal("debate"), Type.Literal("gut-check")],
	{ description: "Consultation mode selected when consult() is called." },
);

/** A consultation mode: solo, council, debate, or gut-check. */
export type ConsultMode = Static<typeof ConsultModeSchema>;

/** A provider/model string plus an optional effort. Shared by every mode entry. */
const ModelEntrySchema = Type.Object(
	{
		model: Type.Optional(Type.String({ description: 'provider/model key, e.g. "anthropic/claude-sonnet-4-6"' })),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		feedbackMode: Type.Optional(FeedbackModeSchema),
	},
	{ additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const SoloModeSchema = Type.Object(
	{
		model: Type.Optional(Type.String()),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		feedbackMode: Type.Optional(FeedbackModeSchema),
		// terse is honored when gut-check merges its config into solo. Caps the
		// response so gut-check returns a short read, not an essay.
		terse: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

const GutCheckModeSchema = Type.Object(
	{
		model: Type.Optional(Type.String()),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		terse: Type.Optional(Type.Boolean()),
		feedbackMode: Type.Optional(FeedbackModeSchema),
	},
	{ additionalProperties: true },
);

const CouncilModeSchema = Type.Object(
	{
		members: Type.Optional(Type.Array(Type.String())),
		synthesizer: Type.Optional(ModelEntrySchema),
		parallel: Type.Optional(Type.Boolean()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0, description: "Per-member wall-clock budget. 0 disables." })),
		feedbackMode: Type.Optional(FeedbackModeSchema),
	},
	{ additionalProperties: true },
);

const DebateModeSchema = Type.Object(
	{
		advocate: Type.Optional(Type.String()),
		critic: Type.Optional(Type.String()),
		rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0, description: "Wall-clock budget for the whole debate (all rounds + synth). 0 disables." })),
		feedbackMode: Type.Optional(FeedbackModeSchema),
	},
	{ additionalProperties: true },
);

const ModesSchema = Type.Object(
	{
		solo: Type.Optional(SoloModeSchema),
		gutCheck: Type.Optional(GutCheckModeSchema),
		council: Type.Optional(CouncilModeSchema),
		debate: Type.Optional(DebateModeSchema),
	},
	{ additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Personas / backends (open — user-defined names must survive cleaning)
// ---------------------------------------------------------------------------

const PersonaSchema = Type.Object(
	{
		name: Type.Optional(Type.String()),
		systemPrompt: Type.Optional(Type.String()),
		stance: Type.Optional(Type.Union([Type.Literal("for"), Type.Literal("against"), Type.Literal("neutral")])),
		defaultModel: Type.Optional(Type.String()),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
	},
	{ additionalProperties: true },
);

const BackendSchema = Type.Object(
	{
		type: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("cli")])),
		command: Type.Optional(Type.String()),
		args: Type.Optional(Type.Array(Type.String())),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Triggers / context budget / disabled-for-models
// ---------------------------------------------------------------------------

const TriggersSchema = Type.Object(
	{
		onDone: Type.Optional(Type.Boolean()),
		whenStuck: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: true },
);

const ContextBudgetSchema = Type.Object(
	{
		userChars: Type.Optional(Type.Integer({ minimum: 0 })),
		assistantChars: Type.Optional(Type.Integer({ minimum: 0 })),
		toolArgChars: Type.Optional(Type.Integer({ minimum: 0 })),
		toolResultChars: Type.Optional(Type.Integer({ minimum: 0 })),
		keepFirst: Type.Optional(Type.Integer({ minimum: 0 })),
		keepLast: Type.Optional(Type.Integer({ minimum: 0 })),
		responseReserveTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: true },
);

const DisabledEntrySchema = Type.Union([
	Type.String(),
	Type.Object({ model: Type.String(), minEffort: Type.Optional(ThinkingLevelSchema) }, { additionalProperties: true }),
]);

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const BpxConsultConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		defaultMode: Type.Optional(ConsultModeSchema),
		modes: Type.Optional(ModesSchema),
		personas: Type.Optional(Type.Record(Type.String(), PersonaSchema)),
		backends: Type.Optional(Type.Record(Type.String(), BackendSchema)),
		triggers: Type.Optional(TriggersSchema),
		feedbackMode: Type.Optional(FeedbackModeSchema),
		// Soft cap on how many times the MODEL may call consult() in a single turn.
		// 0 = unlimited. Auto-triggers and phrase-triggers are separate paths and
		// are NOT counted against this — the cap only guards the model's own
		// tool calls so a runaway agent can't burn advisor quota mid-turn.
		maxConsultsPerTurn: Type.Optional(Type.Integer({ minimum: 0 })),
		contextBudget: Type.Optional(ContextBudgetSchema),
		disabledForModels: Type.Optional(Type.Array(DisabledEntrySchema)),
	},
	{ additionalProperties: true },
);

export type BpxConsultConfig = Static<typeof BpxConsultConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Built-in defaults. validateConfig() merges Value.Create(schema) under the
 * cleaned user value, so these are only used where the schema itself doesn't
 * express a default. Anything that must be a specific value regardless of
 * schema defaults lives here and is re-asserted after validation.
 */
export const DEFAULT_CONFIG: BpxConsultConfig = {
	enabled: true,
	defaultMode: "solo",
	modes: {
		solo: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
		gutCheck: { model: "google/gemini-2.5-flash", thinkingLevel: "low", terse: true },
		council: {
			members: ["architect", "critic", "simplifier"],
			synthesizer: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
			parallel: true,
			timeoutMs: 120000,
		},
		debate: { advocate: "architect", critic: "critic", rounds: 2, timeoutMs: 180000 },
	},
	// Per-persona default models. CRITICAL: members must NOT all share one model/tier,
	// and should avoid sharing the executor's model — parallel calls to the same
	// free-tier provider trip QPM rate limits and silently kill members (caught
	// in live testing). Default roster spreads across Anthropic tiers so the
	// out-of-box council survives a parallel fan-out. Users with only one
	// provider authed should override this to that provider's distinct tiers.
	personas: {
		architect: { defaultModel: "anthropic/claude-opus-4-6", thinkingLevel: "high" },  // strong, for the design-for seat
		critic: { defaultModel: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },    // different tier, forces genuine critique
		simplifier: { defaultModel: "anthropic/claude-haiku-4-5", thinkingLevel: "medium" }, // cheap+fast, questions complexity
	},
	// whenStuck OFF out of the box (0), matching pi-advisor's posture: the model
	// decides when to consult, nudged by the tool guidelines. A user who wants the
	// safety net sets whenStuck > 0 in /consult.
	triggers: { onDone: false, whenStuck: 0 },
	feedbackMode: "steer",
	maxConsultsPerTurn: 3,
	contextBudget: {
		userChars: 2800,
		assistantChars: 1800,
		toolArgChars: 800,
		toolResultChars: 2000,
		keepFirst: 2,
		keepLast: 12,
		responseReserveTokens: 4096,
	},
	disabledForModels: [],
};

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/**
 * Resolve the config path under pi's agent directory.
 *
 * We do NOT use rpiv-config.configPath() — that resolves under ~/.config,
 * the rpiv family convention. bpx-consult lives in the pi ecosystem, so its
 * state sits alongside pi's own (~/.pi/agent/) per SPEC §X. PI_CODING_AGENT_DIR
 * is honoured if set, matching pi's own resolution (usage.md:293).
 */
export function bpxConfigPath(): string {
	const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(base, "bpx-consult.json");
}

/**
 * Project-local config path: `<cwd>/.pi/bpx-consult.json`.
 *
 * SPEC §X precedence is env > project (.pi, trusted) > global > defaults.
 * Project-local is only honoured when the project is trusted (pi's trust model
 * — an untrusted repo must not be able to silently reconfigure the advisor).
 * The caller passes trust state from ctx.isProjectTrusted().
 */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "bpx-consult.json");
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/** Options for loadConfig. Project-local config is only read when trusted. */
export interface LoadConfigOptions {
	/** Current working directory (for project-local config discovery). */
	cwd?: string;
	/** Whether the project is trusted (ctx.isProjectTrusted()). Defaults true. */
	projectTrusted?: boolean;
}

/**
 * Load, clean, and validate the config against the schema.
 *
 * Precedence (SPEC §X): project (.pi, trusted) > global > defaults. Project
 * config is deep-merged ON TOP of global, so a project can override e.g.
 * personas.solo.model without re-stating the whole file. Both layers pass
 * through validateConfig independently so a malformed project config can't
 * corrupt a valid global one — the bad layer just collapses to {}.
 *
 * Fail-soft: missing files, malformed JSON, or validation failures all collapse
 * to defaults rather than throwing — an unreadable config must never break the
 * extension at startup.
 */
export function loadConfig(options: LoadConfigOptions = {}): BpxConsultConfig {
	const globalRaw = loadJsonConfig<unknown>(bpxConfigPath());
	let mergedRaw = globalRaw;

	const trusted = options.projectTrusted ?? true;
	if (trusted && options.cwd) {
		const pPath = projectConfigPath(options.cwd);
		const projectRaw = loadJsonConfig<unknown>(pPath);
		mergedRaw = deepMerge(globalRaw, projectRaw);
	}

	const validated = validateConfig(BpxConsultConfigSchema as TObject, mergedRaw);
	return mergeDefaults(validated);
}

/**
 * Shallow-per-section deep merge for config objects. Project wins at the leaf;
 * arrays replace (not concat) — council.members in project replaces global's.
 * Unknown top-level keys are ignored (validateConfig strips them anyway).
 */
function deepMerge(global: unknown, project: unknown): unknown {
	if (!isObject(global)) return isObject(project) ? project : {};
	if (!isObject(project)) return global;
	const out: Record<string, unknown> = { ...global };
	for (const [k, pv] of Object.entries(project as Record<string, unknown>)) {
		const gv = (global as Record<string, unknown>)[k];
		if (isObject(gv) && isObject(pv)) {
			out[k] = deepMerge(gv, pv);
		} else {
			out[k] = pv;
		}
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Persist config. Returns true on successful write (see saveJsonConfig contract). */
export function saveConfig(config: BpxConsultConfig): boolean {
	return saveJsonConfig(bpxConfigPath(), config);
}

/**
 * Deep-merge user config over built-in defaults, section by section.
 *
 * User values win at the leaf level; missing leaves fall back to DEFAULT_CONFIG.
 * This is deliberately not a generic deep-merge — the shape is fixed and small,
 * so an explicit per-section spread is easier to reason about than a recursive
 * helper that has to special-case arrays (council.members must replace, not
 * concat) and open records (personas/backends).
 */
function mergeDefaults(user: BpxConsultConfig): BpxConsultConfig {
	return {
		enabled: user.enabled ?? DEFAULT_CONFIG.enabled,
		defaultMode: user.defaultMode ?? DEFAULT_CONFIG.defaultMode,
		modes: {
			solo: { ...DEFAULT_CONFIG.modes?.solo, ...user.modes?.solo },
			gutCheck: { ...DEFAULT_CONFIG.modes?.gutCheck, ...user.modes?.gutCheck },
			council: { ...DEFAULT_CONFIG.modes?.council, ...user.modes?.council },
			debate: { ...DEFAULT_CONFIG.modes?.debate, ...user.modes?.debate },
		},
		personas: user.personas ?? {},
		backends: user.backends ?? {},
		triggers: { ...DEFAULT_CONFIG.triggers, ...user.triggers },
		feedbackMode: user.feedbackMode ?? DEFAULT_CONFIG.feedbackMode,
		maxConsultsPerTurn: user.maxConsultsPerTurn ?? DEFAULT_CONFIG.maxConsultsPerTurn,
		contextBudget: { ...DEFAULT_CONFIG.contextBudget, ...user.contextBudget },
		disabledForModels: user.disabledForModels ?? DEFAULT_CONFIG.disabledForModels,
	};
}

// ---------------------------------------------------------------------------
// Disabled-for-models — policy helper (mirrors rpiv-advisor's shape)
// ---------------------------------------------------------------------------

export type DisabledForModelsEntry = string | { model: string; minEffort?: ThinkingLevel };

const EFFORT_ORDINAL: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * Should consult be suppressed for this executor model?
 *
 * - A bare string entry disables unconditionally.
 * - An object entry disables only below its minEffort (so a user can say
 *   "don't bother consulting when I'm already on opus at high").
 */
/**
 * Resolve a backend for a model key. Looks up `config.backends[modelKey]`;
 * returns undefined (→ inline default) when no CLI override is configured.
 *
 * The backend map is keyed by the same provider/model string used everywhere
 * else, so a user can say "route codex/codex to the codex CLI" without touching
 * the rest of the config. A backend entry with no `type` defaults to inline.
 */
export function resolveBackend(config: BpxConsultConfig, modelKey: string | undefined): { type: "cli"; command: string; args?: string[]; timeoutMs?: number } | { type: "inline" } | undefined {
	if (!modelKey) return undefined;
	const entry = config.backends?.[modelKey];
	if (!entry) return undefined;
	if (entry.type === "cli") {
		return {
			type: "cli",
			command: typeof entry.command === "string" ? entry.command : "codex",
			args: Array.isArray(entry.args) ? entry.args : undefined,
			timeoutMs: typeof entry.timeoutMs === "number" ? entry.timeoutMs : undefined,
		};
	}
	return { type: "inline" };
}

export function isDisabledForModel(
	entries: DisabledForModelsEntry[] | undefined,
	executorModelLabel: string,
	thinkingLevel: ThinkingLevel | undefined,
): boolean {
	if (!entries || entries.length === 0) return false;
	const executorOrdinal = thinkingLevel ? EFFORT_ORDINAL.indexOf(thinkingLevel) : -1;
	for (const entry of entries) {
		if (typeof entry === "string") {
			if (entry === executorModelLabel) return true;
			continue;
		}
		if (entry.model !== executorModelLabel) continue;
		if (entry.minEffort === undefined) return true;
		const threshold = EFFORT_ORDINAL.indexOf(entry.minEffort);
		if (threshold === -1) return true; // unknown effort → treat as unconditional
		if (executorOrdinal !== -1 && executorOrdinal < threshold) return true;
	}
	return false;
}
