import type { ModelsConfig, ProviderConfig } from "./types.js";

export function mergeModelsConfig(generated: ModelsConfig, custom: ModelsConfig | undefined): ModelsConfig {
  const result = sanitizeGeneratedConfig(clone(generated));
  if (!custom) return result;
  for (const [providerId, override] of Object.entries(custom.providers)) {
    const baseProvider = result.providers[providerId];
    if (!baseProvider) continue;
    result.providers[providerId] = applyModelOverrides(deepMerge(baseProvider, override) as ProviderConfig);
  }
  return result;
}

function applyModelOverrides(provider: ProviderConfig): ProviderConfig {
  if (!provider.models || !provider.modelOverrides) return provider;
  return {
    ...provider,
    models: provider.models.map((model) => {
      const override = provider.modelOverrides?.[model.id];
      return override ? deepMerge(model, override) as typeof model : model;
    }),
  };
}

function sanitizeGeneratedConfig(config: ModelsConfig): ModelsConfig {
  for (const provider of Object.values(config.providers)) {
    if (!provider.models) continue;
    provider.models = provider.models.map((model) => {
      const {
        baseUrl: _baseUrl,
        headers: _headers,
        apiKey: _apiKey,
        authHeader: _authHeader,
        ...rest
      } = model as typeof model & { apiKey?: string; authHeader?: boolean };
      return rest;
    });
  }
  return config;
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
