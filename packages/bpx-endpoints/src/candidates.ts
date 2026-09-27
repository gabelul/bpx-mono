import { nearestEffortMap } from "./reasoning.js";
import type { BuiltInModelRecord, EndpointModel, MatchKind, ModelConfig, ModelsDevRecord, ParameterSourceCandidate } from "./types.js";

export function normalizeModelId(modelId: string): string {
  const cleaned = modelId.trim().replace(/^models\//, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] ?? cleaned : cleaned;
}

export function buildParameterCandidates(input: {
  endpointModelId: string;
  endpointModel?: EndpointModel;
  api: string;
  builtInModels: BuiltInModelRecord[];
  modelsDevModels: ModelsDevRecord[];
}): ParameterSourceCandidate[] {
  const candidates: Array<ParameterSourceCandidate & { rank: number }> = [];
  for (const model of input.builtInModels) {
    const match = matchModelId(input.endpointModelId, model.id);
    if (!match) continue;
    candidates.push({
      sourceId: `pi:${model.provider}:${model.id}`,
      sourceType: "pi-built-in",
      provider: model.provider,
      modelId: model.id,
      match,
      model: stripProvider(model),
      rank: rankCandidate("pi-built-in", match, input.api, model),
    });
  }
  for (const model of input.modelsDevModels) {
    const match = matchModelId(input.endpointModelId, model.id);
    if (!match) continue;
    candidates.push({
      sourceId: `models-dev:${model.provider}:${model.id}`,
      sourceType: "models.dev",
      provider: model.provider,
      modelId: model.id,
      match,
      model: stripProvider(model),
      rank: rankCandidate("models.dev", match, input.api, model),
    });
  }
  const endpointCandidate = input.endpointModel ? endpointMetadataCandidate(input.endpointModel, input.api) : undefined;
  if (endpointCandidate) candidates.push({ ...endpointCandidate, rank: 300 });
  return candidates.sort((a, b) => a.rank - b.rank || a.sourceId.localeCompare(b.sourceId)).map(({ rank: _rank, ...candidate }) => candidate);
}

export function generatedDefaultModel(modelId: string, name?: string): ModelConfig {
  return {
    id: modelId,
    name: name ?? modelId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

/** Build a parameter candidate from metadata returned by the endpoint's /models response. */
export function endpointMetadataCandidate(endpointModel: EndpointModel, api: string): ParameterSourceCandidate | undefined {
  const metadata = endpointModel.metadata;
  if (!metadata) return undefined;
  const contextWindow = numberField(metadata.context_window, metadata.contextWindow, metadata.context_length, metadata.context);
  const maxTokens = numberField(metadata.max_output_tokens, metadata.maxTokens, metadata.max_tokens, metadata.output_tokens, metadata.output);
  const efforts = reasoningEfforts(metadata.supported_reasoning_levels, metadata.reasoning_efforts, metadata.supported_reasoning_efforts);
  const reasoning = efforts.length > 0 || booleanField(metadata.reasoning, metadata.supports_reasoning, metadata.supportsReasoning);
  const model: ModelConfig = {
    id: endpointModel.id,
    name: stringField(metadata.display_name, metadata.name) ?? endpointModel.name ?? endpointModel.id,
    api,
    reasoning,
    ...(reasoning && efforts.length > 0 ? { thinkingLevelMap: nearestEffortMap(efforts) } : {}),
    input: inputField(metadata.input_modalities, metadata.inputModalities, metadata.input, metadata.modalities),
    cost: {
      input: numberField(path(metadata, ["cost", "input"]), path(metadata, ["pricing", "input"]), metadata.input_cost, metadata.cost_input),
      output: numberField(path(metadata, ["cost", "output"]), path(metadata, ["pricing", "output"]), metadata.output_cost, metadata.cost_output),
      cacheRead: numberField(path(metadata, ["cost", "cache_read"]), path(metadata, ["cost", "cacheRead"]), path(metadata, ["pricing", "cache_read"]), path(metadata, ["pricing", "cacheRead"])),
      cacheWrite: numberField(path(metadata, ["cost", "cache_write"]), path(metadata, ["cost", "cacheWrite"]), path(metadata, ["pricing", "cache_write"]), path(metadata, ["pricing", "cacheWrite"])),
    },
    contextWindow: contextWindow || 128000,
    maxTokens: maxTokens || 16384,
  };
  return {
    sourceId: `endpoint-metadata:${endpointModel.id}`,
    sourceType: "endpoint-metadata",
    modelId: endpointModel.id,
    match: "exact",
    model,
  };
}

/** Extract supported reasoning effort strings from endpoint metadata arrays. */
function reasoningEfforts(...values: unknown[]): string[] {
  const efforts: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const effort = typeof item === "string" ? item : isRecord(item) ? stringField(item.effort, item.value, item.id, item.name) : undefined;
      if (effort && !efforts.includes(effort)) efforts.push(effort);
    }
  }
  return efforts;
}

/** Normalize endpoint input modality metadata to Pi's supported input list. */
function inputField(...values: unknown[]): Array<"text" | "image"> {
  for (const value of values) {
    if (Array.isArray(value)) {
      const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
      if (input.length > 0) return input;
    }
    if (isRecord(value) && Array.isArray(value.input)) {
      const input = value.input.filter((item): item is "text" | "image" => item === "text" || item === "image");
      if (input.length > 0) return input;
    }
  }
  return ["text"];
}

/** Return the first non-empty string field from metadata aliases. */
function stringField(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/** Return the first boolean field from metadata aliases. */
function booleanField(...values: unknown[]): boolean {
  for (const value of values) if (typeof value === "boolean") return value;
  return false;
}

/** Return the first finite numeric field from metadata aliases. */
function numberField(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/** Read a nested metadata value without throwing on missing objects. */
function path(value: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Check for plain object-ish records, excluding arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchModelId(endpointModelId: string, candidateModelId: string): MatchKind | undefined {
  if (endpointModelId === candidateModelId) return "exact";
  const endpointNormalized = normalizeModelId(endpointModelId);
  const candidateNormalized = normalizeModelId(candidateModelId);
  if (endpointNormalized === candidateNormalized) return "normalized";
  if (isFuzzyCandidate(endpointNormalized, candidateNormalized)) return "fuzzy";
  return undefined;
}

function isFuzzyCandidate(endpoint: string, candidate: string): boolean {
  if (endpoint.length < 5 || candidate.length < 5) return false;
  return endpoint.includes(candidate) || candidate.includes(endpoint);
}

function rankCandidate(sourceType: "pi-built-in" | "models.dev", match: MatchKind, api: string, model: { api?: string; provider: string }): number {
  const matchRank = match === "exact" ? 0 : match === "normalized" ? 100 : 200;
  const sourceRank = sourceType === "pi-built-in" ? 0 : 10;
  const apiRank = model.api === api ? -2 : 0;
  return matchRank + sourceRank + apiRank;
}

function stripProvider(model: BuiltInModelRecord | ModelsDevRecord): ModelConfig {
  const {
    provider: _provider,
    baseUrl: _baseUrl,
    headers: _headers,
    apiKey: _apiKey,
    authHeader: _authHeader,
    ...rest
  } = model as BuiltInModelRecord & { apiKey?: string; authHeader?: boolean };
  return { ...rest };
}
