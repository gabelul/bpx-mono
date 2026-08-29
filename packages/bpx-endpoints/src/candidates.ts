import type { BuiltInModelRecord, MatchKind, ModelConfig, ModelsDevRecord, ParameterSourceCandidate } from "./types.js";

export function normalizeModelId(modelId: string): string {
  const cleaned = modelId.trim().replace(/^models\//, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] ?? cleaned : cleaned;
}

export function buildParameterCandidates(input: {
  endpointModelId: string;
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
