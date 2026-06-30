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

const ConsultModeSchema = Type.Union(
	[Type.Literal("solo"), Type.Literal("council"), Type.Literal("debate"), Type.Literal("gut-check")],
	{ description: "Consultation mode selected when consult() is called." },
);

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
		feedbackMode: Type.Optional(FeedbackModeSchema),
	},
	{ additionalProperties: true },
);

const DebateModeSchema = Type.Object(
	{
		advocate: Type.Optional(Type.String()),
		critic: Type.Optional(Type.String()),
		rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
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
		},
		debate: { advocate: "architect", critic: "critic", rounds: 2 },
	},
	triggers: { onDone: false, whenStuck: 3 },
	feedbackMode: "steer",
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

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load, clean, and validate the config against the schema.
 *
 * Fail-soft: missing file, malformed JSON, or validation failure all collapse
 * to the built-in defaults rather than throwing — an unreadable config must
 * never break the extension at startup. Mirrors rpiv-config's own contract.
 *
 * Defaults are re-asserted after validation because TypeBox's Value.Create
 * only emits schema-declared defaults (we declare none inline); every field
 * that must exist comes from DEFAULT_CONFIG via a shallow-per-section merge.
 */
export function loadConfig(): BpxConsultConfig {
	const raw = loadJsonConfig<unknown>(bpxConfigPath());
	const validated = validateConfig(BpxConsultConfigSchema as TObject, raw);
	return mergeDefaults(validated);
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
