import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KNOWN_APIS, type BuiltInModelRecord, type RuntimeCapabilities } from "./types.js";

export function filterRuntimeProviderModels(runtime: RuntimeCapabilities, excludedProviderIds: Iterable<string>): RuntimeCapabilities {
  const excluded = new Set(excludedProviderIds);
  return {
    adapters: runtime.adapters,
    builtInModels: runtime.builtInModels.filter((model) => !excluded.has(model.provider)),
  };
}

export function getRuntimeCapabilities(ctx?: Pick<ExtensionCommandContext, "modelRegistry">): RuntimeCapabilities {
  const builtInModels = getBuiltInModels(ctx);
  const dynamicApis = new Set<string>(KNOWN_APIS);
  for (const model of builtInModels) dynamicApis.add(model.api);
  return { adapters: [...dynamicApis].sort(), builtInModels };
}

function getBuiltInModels(ctx?: Pick<ExtensionCommandContext, "modelRegistry">): BuiltInModelRecord[] {
  const registry = ctx?.modelRegistry as { getAll?: () => unknown[] } | undefined;
  const models = registry?.getAll?.() ?? [];
  return models.flatMap((model) => toBuiltInRecord(model));
}

function toBuiltInRecord(value: unknown): BuiltInModelRecord[] {
  if (!isRecord(value)) return [];
  if (typeof value.provider !== "string" || typeof value.id !== "string" || typeof value.api !== "string") return [];
  return [
    {
      provider: value.provider,
      id: value.id,
      name: typeof value.name === "string" ? value.name : value.id,
      api: value.api,
      ...(typeof value.baseUrl === "string" && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      reasoning: typeof value.reasoning === "boolean" ? value.reasoning : false,
      thinkingLevelMap: isRecord(value.thinkingLevelMap) ? (value.thinkingLevelMap as Record<string, string | null>) : undefined,
      input: Array.isArray(value.input) ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image") : ["text"],
      cost: isCost(value.cost) ? value.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : 128000,
      maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : 16384,
      compat: isRecord(value.compat) ? value.compat : undefined,
    },
  ];
}

function isCost(value: unknown): value is { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return (
    isRecord(value) &&
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
