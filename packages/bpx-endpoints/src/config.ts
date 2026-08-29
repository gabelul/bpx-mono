/**
 * config — persisted bpx-endpoints managed config.
 *
 * Lives at the pi-native path `~/.pi/agent/bpx-endpoints.json` (not rpiv's
 * `~/.config` convention) because bpx-endpoints is a pi extension first and
 * should sit alongside pi's own state. Reuses @juicesharp/rpiv-config for the
 * crash-resistant load + TypeBox-driven validate primitives. Writes from the
 * extension go through io.ts's atomic tmp+rename writeJson (0600) rather than
 * rpiv's saveJsonConfig — the managed file is rewritten on every save, and an
 * atomic swap protects it against a crash mid-write. saveConfig below exists
 * for parity and non-atomic call sites.
 *
 * Schema mirrors the pi models.json-shaped profile model. profiles and
 * modelOverrides are intentionally left open (additionalProperties) so
 * arbitrary pi model fields survive validation instead of being stripped
 * by Value.Clean.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadJsonConfig, saveJsonConfig, validateConfig } from "@juicesharp/rpiv-config";
import { type Static, type TObject, Type } from "typebox";
import { Value } from "typebox/value";
import type { EndpointProfile, ManagedConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const DiscoverySchema = Type.Object(
	{
		mode: Type.Optional(Type.Union([Type.Literal("endpoint"), Type.Literal("manual")])),
		modelsPath: Type.Optional(Type.String()),
		modelsUrl: Type.Optional(Type.String()),
		probe: Type.Optional(Type.Boolean()),
		reasoningProbe: Type.Optional(Type.Boolean()),
		modelIds: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);

const ModelPolicySchema = Type.Object(
	{
		mode: Type.Optional(Type.Union([Type.Literal("includeAll"), Type.Literal("includeOnly")])),
		include: Type.Optional(Type.Array(Type.String())),
		exclude: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);

const EndpointProfileSchema = Type.Object(
	{
		id: Type.Optional(Type.String()),
		enabled: Type.Optional(Type.Boolean()),
		name: Type.Optional(Type.String()),
		api: Type.Optional(Type.String()),
		baseUrl: Type.Optional(Type.String()),
		apiKey: Type.Optional(Type.String()),
		headers: Type.Optional(Type.Record(Type.String(), Type.String(), { additionalProperties: true })),
		discovery: Type.Optional(DiscoverySchema),
		modelPolicy: Type.Optional(ModelPolicySchema),
		parameterSourceSelections: Type.Optional(Type.Record(Type.String(), Type.String(), { additionalProperties: true })),
		modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { additionalProperties: true })),
		reasoningEfforts: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);

const SettingsSchema = Type.Object(
	{
		staleReminder: Type.Optional(Type.Boolean()),
		staleReminderDays: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const BpxEndpointsConfigSchema = Type.Object(
	{
		version: Type.Literal(1),
		profiles: Type.Record(Type.String(), EndpointProfileSchema, { additionalProperties: true }),
		modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { additionalProperties: true })),
		settings: Type.Optional(SettingsSchema),
	},
	{ additionalProperties: true },
);

export type BpxEndpointsConfig = Static<typeof BpxEndpointsConfigSchema>;

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/**
 * Resolve the config path under pi's agent directory.
 *
 * We do NOT use rpiv-config.configPath() — that resolves under ~/.config,
 * the rpiv family convention. bpx-endpoints lives in the pi ecosystem, so its
 * state sits alongside pi's own (~/.pi/agent/). PI_CODING_AGENT_DIR is
 * honoured if set, matching pi's own resolution.
 */
export function bpxEndpointsConfigPath(): string {
	const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(base, "bpx-endpoints.json");
}

// ---------------------------------------------------------------------------
// Profile normalization (strict field validation after TypeBox cleaning)
// ---------------------------------------------------------------------------

export function createDefaultConfig(): ManagedConfig {
	return { version: 1, profiles: {} };
}

export function normalizeProfile(input: {
	id: string;
	enabled?: boolean;
	name: string;
	api: string;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	discovery?: { mode?: "endpoint" | "manual"; modelsPath?: string; modelsUrl?: string; probe?: boolean; reasoningProbe?: boolean; modelIds?: string[] };
	modelPolicy?: { mode?: "includeAll" | "includeOnly"; include?: string[]; exclude?: string[] };
	parameterSourceSelections?: Record<string, string>;
	modelOverrides?: EndpointProfile["modelOverrides"];
	reasoningEfforts?: string[];
}): EndpointProfile {
	const profile: EndpointProfile = {
		id: input.id,
		enabled: input.enabled ?? true,
		name: input.name,
		api: input.api,
		baseUrl: input.baseUrl,
		apiKey: input.apiKey,
		headers: input.headers,
		discovery: {
			mode: input.discovery?.mode ?? "endpoint",
			modelsPath: input.discovery?.modelsPath ?? "/models",
			modelsUrl: input.discovery?.modelsUrl,
			probe: input.discovery?.probe,
			reasoningProbe: input.discovery?.reasoningProbe,
			modelIds: input.discovery?.modelIds ? normalizeModelIds(input.discovery.modelIds) : undefined,
		},
		modelPolicy:
			input.modelPolicy?.mode === "includeOnly"
				? { mode: "includeOnly", include: input.modelPolicy.include ?? [] }
				: { mode: "includeAll", exclude: input.modelPolicy?.exclude ?? [] },
		parameterSourceSelections: input.parameterSourceSelections,
		modelOverrides: input.modelOverrides,
		reasoningEfforts: input.reasoningEfforts ? normalizeModelIds(input.reasoningEfforts) : undefined,
	};
	validateProfile(profile);
	return profile;
}

/**
 * Validate and clean a raw config value against the schema, then post-normalize
 * every profile so the strict profile invariants (required name/api/baseUrl,
 * discovery shape, map-key/id consistency) hold after cleaning.
 *
 * Structural problems throw with precise messages (so /endpoints doctor can
 * surface them); field-level invalid values are cleaned by TypeBox rather than
 * nuking the whole file — consult-style fail-soft.
 */
export function parseManagedConfig(value: unknown): ManagedConfig {
	if (!isRecord(value)) throw new Error("Managed config must be an object");
	if (value.version !== 1) throw new Error("Managed config version must be 1");
	if (!isRecord(value.profiles)) throw new Error("Managed config profiles must be an object");
	for (const [id, raw] of Object.entries(value.profiles)) {
		if (!isRecord(raw)) throw new Error(`Profile ${id} must be an object`);
		// Enforce map-key/id consistency — the code assumes profiles[id].id === id
		// throughout (unregister, removal, refresh by id). A drifted id field
		// silently orphans the profile, so reject it loudly.
		if (raw.id !== undefined && raw.id !== id) {
			throw new Error(`Profile ${id}: id field (${raw.id}) does not match its config key`);
		}
	}

	const cleaned = Value.Clean(BpxEndpointsConfigSchema as TObject, Value.Clone(value)) as BpxEndpointsConfig;

	const profiles: Record<string, EndpointProfile> = {};
	for (const [id, raw] of Object.entries(cleaned.profiles)) {
		profiles[id] = normalizeProfile({
			id,
			enabled: raw.enabled,
			name: raw.name ?? "",
			api: raw.api ?? "",
			baseUrl: raw.baseUrl ?? "",
			apiKey: raw.apiKey,
			headers: raw.headers,
			discovery: raw.discovery,
			modelPolicy: raw.modelPolicy,
			parameterSourceSelections: raw.parameterSourceSelections,
			modelOverrides: raw.modelOverrides as EndpointProfile["modelOverrides"],
			reasoningEfforts: raw.reasoningEfforts,
		});
	}

	const config: ManagedConfig = { version: 1, profiles };
	if (cleaned.modelOverrides !== undefined) config.modelOverrides = cleaned.modelOverrides as ManagedConfig["modelOverrides"];
	if (cleaned.settings !== undefined) config.settings = cleaned.settings as ManagedConfig["settings"];
	return config;
}

function validateProfile(profile: EndpointProfile): void {
	if (!profile.id.trim()) throw new Error("Profile id is required");
	if (!profile.name.trim()) throw new Error(`Profile ${profile.id}: name is required`);
	if (!profile.baseUrl.trim()) throw new Error(`Profile ${profile.id}: baseUrl is required`);
	if (!profile.api.trim()) throw new Error(`Profile ${profile.id}: api is required`);
	if (profile.discovery.mode === "endpoint" && !profile.discovery.modelsPath.startsWith("/")) {
		throw new Error(`Profile ${profile.id}: discovery.modelsPath must start with /`);
	}
	if (profile.discovery.modelsUrl && !/^https?:\/\//i.test(profile.discovery.modelsUrl)) {
		throw new Error(`Profile ${profile.id}: discovery.modelsUrl must be a full http(s) URL`);
	}
	if (
		profile.discovery.mode === "manual" &&
		(!profile.discovery.modelIds || profile.discovery.modelIds.length === 0 || profile.discovery.modelIds.some((modelId) => !modelId.trim()))
	) {
		throw new Error(`profiles.${profile.id}.discovery.modelIds must be a non-empty array of non-empty strings`);
	}
}

function normalizeModelIds(modelIds: string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const modelId of modelIds) {
		const trimmed = modelId.trim();
		if (!seen.has(trimmed)) {
			result.push(trimmed);
			seen.add(trimmed);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load, clean, and validate the managed config from the flat file.
 *
 * Fail-soft: missing files, malformed JSON, or validation failures all collapse
 * to a default config rather than throwing — an unreadable config must never
 * break the extension at startup.
 */
export function loadConfig(): ManagedConfig {
	const raw = loadJsonConfig<unknown>(bpxEndpointsConfigPath());
	try {
		return parseManagedConfig(raw);
	} catch {
		return createDefaultConfig();
	}
}

/** Persist config. Returns true on successful write (see saveJsonConfig contract). */
export function saveConfig(config: ManagedConfig): boolean {
	return saveJsonConfig(bpxEndpointsConfigPath(), config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
