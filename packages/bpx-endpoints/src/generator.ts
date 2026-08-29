import { generatedDefaultModel } from "./candidates.js";
import { buildReasoningModel, CANONICAL_THINKING_LEVEL_MAP, isCompleteThinkingLevelMap } from "./reasoning.js";
import type { CachedModel, DoctorIssue, ManagedConfig, ModelConfig, ModelsConfig, EndpointProfile, ReasoningProbeResult, RuntimeCapabilities } from "./types.js";

export function generateModelsConfig(
  managed: ManagedConfig,
  cache: { profiles: Record<string, { models: Record<string, CachedModel>; reasoning?: ReasoningProbeResult }> },
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
    const built = buildModelsForProfile(profile, profileCache?.models ?? {}, profile.api, managed.modelOverrides ?? {}, profileCache?.reasoning);
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
  profileReasoning: ReasoningProbeResult | undefined,
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
    let model = applyModelOverride({ ...base, id: cachedModel.id, api }, globalOverrides[cachedModel.id], profile.modelOverrides?.[cachedModel.id]);
    const reasoning = applyReasoningPolicy(model, profile, profileReasoning);
    model = reasoning.model;
    if (reasoning.note) notes.push({ modelId: cachedModel.id, note: reasoning.note });
    result.push(stripTransportFields(model));
  }
  return { models: result, unsourcedCount, fuzzyCount, notes };
}

/**
 * The reasoning_effort fix. For openai-completions reasoning models, guarantee
 * the registered thinkingLevelMap is complete (no pi level can leak a raw wire
 * value):
 * - probe/manual ground truth: map every pi level to the nearest accepted effort;
 * - endpoint accepted nothing cleanly: register non-reasoning (any effort 400s);
 * - probe inconclusive: canonical map + warning;
 * - no ground truth: canonical map unless an explicit complete map already exists
 *   (e.g. a user-authored models.custom.json override — never clobber that).
 */
function applyReasoningPolicy(
  model: ModelConfig,
  profile: EndpointProfile,
  probe: ReasoningProbeResult | undefined,
): { model: ModelConfig; note?: string } {
  if (profile.api !== "openai-completions") return { model };
  if (!model.reasoning) return { model };

  let supportedEfforts: string[] | undefined;
  let inconclusive = false;
  if (profile.reasoningEfforts !== undefined) {
    supportedEfforts = profile.reasoningEfforts;
  } else if (probe !== undefined && probe.error === undefined) {
    supportedEfforts = probe.accepted;
    inconclusive = probe.accepted.length === 0 && probe.rejected.some((item) => !item.effortRelated);
  }

  if (supportedEfforts !== undefined) {
    const built = buildReasoningModel({ reasoning: true, supportedEfforts, inconclusive });
    return { model: { ...model, reasoning: built.reasoning, thinkingLevelMap: built.map }, note: built.note };
  }
  if (isCompleteThinkingLevelMap(model.thinkingLevelMap)) {
    return { model };
  }
  return { model: { ...model, thinkingLevelMap: { ...CANONICAL_THINKING_LEVEL_MAP } } };
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
