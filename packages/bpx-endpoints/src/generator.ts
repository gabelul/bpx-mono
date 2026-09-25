import { generatedDefaultModel } from "./candidates.js";
import { buildReasoningModel, CANONICAL_THINKING_LEVEL_MAP, isCompleteThinkingLevelMap, migrateLegacyReasoningCache, nearestEffortMap, REASONING_EVIDENCE_TTL_MS, supportedEffortsFromResult, PI_THINKING_LEVELS } from "./reasoning.js";
import type { CachedModel, DoctorIssue, ManagedConfig, ModelConfig, ModelsConfig, EndpointProfile, ReasoningProbeResult, RuntimeCapabilities } from "./types.js";

export function generateModelsConfig(
  managed: ManagedConfig,
  cache: { profiles: Record<string, { models: Record<string, CachedModel>; reasoning?: Record<string, ReasoningProbeResult> }> },
  runtime: RuntimeCapabilities,
): { config: ModelsConfig; issues: DoctorIssue[] } {
  const output: ModelsConfig = { providers: {} };
  const issues: DoctorIssue[] = [];

  for (const profile of Object.values(managed.profiles)) {
    if (!profile.enabled) continue;
    if (!runtime.adapters.includes(profile.api)) {
      issues.push({ level: "error", code: "api_unresolved", profileId: profile.id, message: `Endpoint ${profile.id} api ${profile.api} cannot be resolved by this Pi runtime.` });
      continue;
    }
    const profileCache = cache.profiles[profile.id];
    // Load-boundary normalization: on-disk caches may still hold the v0.2.x
    // single-result shape - migrate before any per-model lookup.
    const reasoning = migrateLegacyReasoningCache(profileCache?.reasoning);
    const built = buildModelsForProfile(profile, profileCache?.models ?? {}, profile.api, managed.modelOverrides ?? {}, reasoning);
    const models = built.models;
    if (models.length === 0) {
      issues.push({ level: "warning", code: "no_models_generated", profileId: profile.id, message: `Endpoint ${profile.id} has no models to generate.` });
      continue;
    }
    if (built.unsourcedCount > 0) {
      issues.push({ level: "warning", code: "models_unsourced", profileId: profile.id, message: `Endpoint ${profile.id}: ${built.unsourcedCount} model(s) using built-in default parameters (128k ctx, cost 0) — verify with /endpoints.` });
    }
    if (built.fuzzyCount > 0) {
      issues.push({ level: "warning", code: "fuzzy_parameter_source", profileId: profile.id, message: `Endpoint ${profile.id}: ${built.fuzzyCount} model(s) matched only fuzzily — verify parameter sources with /endpoints.` });
    }
    for (const note of built.notes) {
      issues.push({ level: "warning", code: "reasoning_policy", profileId: profile.id, message: `Endpoint ${profile.id} model ${note.modelId}: ${note.note}` });
    }
    output.providers[profile.id] = {
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey ?? "unused",
      ...(profile.apiKey === undefined ? { authHeader: false } : {}),
      ...(profile.headers ? { headers: profile.headers } : {}),
      api: profile.api,
      models,
    };
  }

  return { config: output, issues };
}

function buildModelsForProfile(
  profile: EndpointProfile,
  cachedModels: Record<string, CachedModel>,
  api: string,
  globalOverrides: Record<string, Partial<ModelConfig>>,
  profileReasoning: Record<string, ReasoningProbeResult> | undefined,
): { models: ModelConfig[]; unsourcedCount: number; fuzzyCount: number; notes: Array<{ modelId: string; note: string }> } {
  const result: ModelConfig[] = [];
  const notes: Array<{ modelId: string; note: string }> = [];
  let unsourcedCount = 0;
  let fuzzyCount = 0;
  for (const cachedModel of Object.values(cachedModels).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!cachedModel.available || !isIncluded(profile, cachedModel.id)) continue;
    const configuredSource = profile.parameterSourceSelections?.[cachedModel.id];
    const candidate = configuredSource
      ? cachedModel.candidates.find((item) => item.sourceId === configuredSource)
      : cachedModel.candidates[0];
    if (!candidate || candidate.sourceType === "generated-default") unsourcedCount += 1;
    if (candidate?.match === "fuzzy") fuzzyCount += 1;
    const base = candidate?.model ?? generatedDefaultModel(cachedModel.id, cachedModel.name);
    const overrides = [globalOverrides[cachedModel.id], profile.modelOverrides?.[cachedModel.id]];
    // An override that carries thinkingLevelMap is user-authored intent — its
    // entries (including nulls, which pi renders as unsupported levels) must
    // survive every policy below.
    const overrideAuthoredMap = overrides.some((override) => override && typeof override === "object" && "thinkingLevelMap" in override);
    let model = applyModelOverride({ ...base, id: cachedModel.id, api }, ...overrides);
    const reasoning = applyReasoningPolicy(model, profile, overrideAuthoredMap, profileReasoning?.[cachedModel.id]);
    model = reasoning.model;
    if (reasoning.note) notes.push({ modelId: cachedModel.id, note: reasoning.note });
    result.push(stripTransportFields(model));
  }
  return { models: result, unsourcedCount, fuzzyCount, notes };
}

/**
 * The reasoning_effort fix. For openai-completions AND openai-responses
 * reasoning models, guarantee the registered thinkingLevelMap is complete so no
 * pi level can leak a raw wire value. Precedence, explicit:
 *
 * 1. A user-authored map (models.custom.json override) always wins. Complete
 *    maps pass through untouched; partial maps keep their authored entries
 *    (strings AND nulls) and only missing keys are filled — from live evidence
 *    when available, otherwise the canonical set.
 * 2. Manual profile reasoningEfforts (user config, wins over probe by design).
 * 3. Per-model probe/mined evidence. Evidence is model-scoped: a sibling's
 *    accepted set is never reused.
 * 4. Canonical low/medium/high when nothing is known.
 */
function applyReasoningPolicy(
  model: ModelConfig,
  profile: EndpointProfile,
  overrideAuthoredMap: boolean,
  evidence: ReasoningProbeResult | undefined,
): { model: ModelConfig; note?: string } {
  // Effective API: a per-model override may route this model differently from
  // the profile default — policy and probe payloads must follow it.
  const effectiveApi = model.api ?? profile.api;
  if (effectiveApi !== "openai-completions" && effectiveApi !== "openai-responses") return { model };
  if (!model.reasoning) return { model };

  // Evidence captured from a different endpoint identity (profile repointed,
  // front URL switched backends) is stale even when fresh in time.
  const baseUrlComparable = !/[$!]/.test(profile.baseUrl);
  const parsedAt = evidence !== undefined ? Date.parse(evidence.probedAt) : Number.NaN;
  const nowMs = Date.now();
  const usableEvidence =
    evidence !== undefined &&
    evidence.error === undefined &&
    !evidence.degraded &&
    evidence.endpointIdentity !== undefined &&
    evidence.endpointIdentity.api === effectiveApi &&
    (!baseUrlComparable || evidence.endpointIdentity.baseUrl === profile.baseUrl) &&
    // Freshness is enforced at GENERATE time too, not only when refreshing:
    // a cache written days ago must not silently drive today's maps.
    !Number.isNaN(parsedAt) &&
    parsedAt <= nowMs &&
    nowMs - parsedAt <= REASONING_EVIDENCE_TTL_MS;

  if (overrideAuthoredMap && model.thinkingLevelMap !== undefined) {
    const authored = model.thinkingLevelMap;
    const missing = PI_THINKING_LEVELS.filter((level) => authored[level] === undefined);
    if (missing.length === 0) return { model };
    const fill = effortMapForFill(profile, usableEvidence ? evidence : undefined, effectiveApi);
    const filled = { ...authored } as Record<string, string | null>;
    for (const level of missing) filled[level] = fill[level];
    return { model: { ...model, thinkingLevelMap: filled } };
  }

  if (profile.reasoningEfforts !== undefined) {
    const built = buildReasoningModel({ reasoning: true, supportedEfforts: profile.reasoningEfforts });
    return { model: { ...model, reasoning: built.reasoning, thinkingLevelMap: built.map }, note: built.note };
  }

  if (usableEvidence && evidence !== undefined) {
    const derived = supportedEffortsFromResult(evidence);
    const built = buildReasoningModel({ reasoning: true, supportedEfforts: derived.efforts, inconclusive: derived.inconclusive });
    return { model: { ...model, reasoning: built.reasoning, thinkingLevelMap: built.map }, note: built.note };
  }

  if (isCompleteThinkingLevelMap(model.thinkingLevelMap)) {
    return { model };
  }
  return { model: { ...model, thinkingLevelMap: { ...CANONICAL_THINKING_LEVEL_MAP } } };
}

/** Best-effort map for filling the missing keys of a user-authored map. */
function effortMapForFill(profile: EndpointProfile, evidence: ReasoningProbeResult | undefined, _effectiveApi: string): Record<string, string> {
  if (profile.reasoningEfforts !== undefined && profile.reasoningEfforts.length > 0) return nearestEffortMap(profile.reasoningEfforts);
  if (evidence !== undefined && evidence.error === undefined) {
    const derived = supportedEffortsFromResult(evidence);
    if (derived.efforts && derived.efforts.length > 0) return nearestEffortMap(derived.efforts);
  }
  return { ...CANONICAL_THINKING_LEVEL_MAP };
}

function stripTransportFields(model: ModelConfig): ModelConfig {
  const {
    baseUrl: _baseUrl,
    headers: _headers,
    apiKey: _apiKey,
    authHeader: _authHeader,
    ...rest
  } = model as ModelConfig & { apiKey?: string; authHeader?: boolean };
  return rest;
}

function isIncluded(profile: EndpointProfile, modelId: string): boolean {
  if (profile.modelPolicy.mode === "includeOnly") return profile.modelPolicy.include?.includes(modelId) ?? false;
  return !(profile.modelPolicy.exclude?.includes(modelId) ?? false);
}

function applyModelOverride(model: ModelConfig, ...overrides: Array<Partial<ModelConfig> | undefined>): ModelConfig {
  let result = clone(model);
  for (const override of overrides) {
    if (!override) continue;
    result = deepMerge(result, override) as ModelConfig;
  }
  return result;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return clone(override);
  if (isRecord(base) && isRecord(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) result[key] = deepMerge(result[key], value);
    return result;
  }
  return clone(override);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
