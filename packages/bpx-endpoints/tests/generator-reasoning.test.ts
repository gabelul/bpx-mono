import { describe, expect, it } from "vitest";
import { generateModelsConfig } from "../src/generator.js";
import type { BuiltInModelRecord, CachedModel, CachedProfile, DiscoveryCache, EndpointProfile, ManagedConfig, ModelConfig, ReasoningProbeResult, RuntimeCapabilities } from "../src/types.js";

const REASONING_SOURCE_MAP = { off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null };

function profile(overrides: Partial<EndpointProfile> = {}): EndpointProfile {
  return {
    id: "endpoint-1",
    enabled: true,
    name: "E1",
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
    discovery: { mode: "endpoint", modelsPath: "/models" },
    modelPolicy: { mode: "includeAll", exclude: [] },
    ...overrides,
  };
}

function builtInModel(id: string, overrides: Partial<BuiltInModelRecord> = {}): BuiltInModelRecord {
  return {
    id,
    name: id,
    provider: "qwen",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

function cachedModel(id: string, model: BuiltInModelRecord): CachedModel {
  return {
    id,
    name: id,
    available: true,
    candidates: [
      {
        sourceId: `pi:${model.provider}:${id}`,
        sourceType: "pi-built-in",
        provider: model.provider,
        modelId: id,
        match: "exact",
        model,
      },
    ],
  };
}

function cachedProfile(models: Record<string, CachedModel>, reasoning?: ReasoningProbeResult): CachedProfile {
  return {
    refreshedAt: "2026-08-29T00:00:00.000Z",
    endpointModels: Object.keys(models).map((id) => ({ id })),
    models,
    warnings: [],
    reasoning,
  };
}

function cache(profiles: Record<string, CachedProfile>): DiscoveryCache {
  return { version: 1, profiles };
}

function runtime(builtIn: BuiltInModelRecord[]): RuntimeCapabilities {
  return { adapters: ["openai-completions"], builtInModels: builtIn };
}

function reasoningProbe(accepted: string[], rejected: ReasoningProbeResult["rejected"] = []): ReasoningProbeResult {
  return { probedAt: "2026-08-29T00:00:00.000Z", modelId: "qwen-27b", accepted, rejected };
}

const config: ManagedConfig = { version: 1, profiles: { "endpoint-1": profile() } };

function firstModel(result: ReturnType<typeof generateModelsConfig>): ModelConfig {
  return result.config.providers["endpoint-1"]!.models![0]!;
}

describe("generateModelsConfig reasoning policy", () => {
  it("completes a null-leaking source map into the canonical map (the bug)", () => {
    const model = builtInModel("qwen-27b", { thinkingLevelMap: REASONING_SOURCE_MAP });
    const result = generateModelsConfig(config, cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }) }), runtime([model]));
    const generated = firstModel(result);
    expect(generated.reasoning).toBe(true);
    expect(generated.thinkingLevelMap).toEqual({ off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" });
    for (const level of Object.keys(generated.thinkingLevelMap!)) expect(typeof generated.thinkingLevelMap![level]).toBe("string");
  });

  it("maps to the endpoint's accepted efforts when probe data exists (low/medium server)", () => {
    const model = builtInModel("qwen-27b", { thinkingLevelMap: REASONING_SOURCE_MAP });
    const probe = reasoningProbe(["low", "medium"], [{ value: "high", status: 400, detail: "Unexpected reasoning effort high.", effortRelated: true }]);
    const result = generateModelsConfig(
      config,
      cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }, probe) }),
      runtime([model]),
    );
    const generated = firstModel(result);
    expect(generated.thinkingLevelMap).toEqual({ off: "low", minimal: "low", low: "low", medium: "medium", high: "medium", xhigh: "medium", max: "medium" });
  });

  it("manual reasoningEfforts win over probe results", () => {
    const model = builtInModel("qwen-27b");
    const probe = reasoningProbe(["low", "medium"]);
    const configWithManual: ManagedConfig = { version: 1, profiles: { "endpoint-1": profile({ reasoningEfforts: ["medium"] }) } };
    const result = generateModelsConfig(
      configWithManual,
      cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }, probe) }),
      runtime([model]),
    );
    const generated = firstModel(result);
    for (const level of Object.keys(generated.thinkingLevelMap!)) expect(generated.thinkingLevelMap![level]).toBe("medium");
  });

  it("registers reasoning models as non-reasoning when the endpoint accepted nothing cleanly, with a warning", () => {
    const model = builtInModel("qwen-27b");
    const probe = reasoningProbe([], [{ value: "low", status: 400, detail: "Unexpected reasoning effort low.", effortRelated: true }]);
    const result = generateModelsConfig(
      config,
      cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }, probe) }),
      runtime([model]),
    );
    const generated = firstModel(result);
    expect(generated.reasoning).toBe(false);
    expect(generated.thinkingLevelMap).toBeUndefined();
    expect(result.issues.some((issue) => issue.code === "reasoning_policy")).toBe(true);
  });

  it("keeps reasoning with canonical map when the probe was inconclusive", () => {
    const model = builtInModel("qwen-27b");
    const probe = reasoningProbe([], [{ value: "low", status: 400, detail: "model not found", effortRelated: false }]);
    const result = generateModelsConfig(
      config,
      cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }, probe) }),
      runtime([model]),
    );
    const generated = firstModel(result);
    expect(generated.reasoning).toBe(true);
    expect(generated.thinkingLevelMap).toEqual({ off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" });
  });

  it("preserves an explicit complete custom map when there is no probe/manual ground truth", () => {
    const customMap = { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" };
    const model = builtInModel("qwen-27b", { thinkingLevelMap: customMap });
    const result = generateModelsConfig(config, cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }) }), runtime([model]));
    expect(firstModel(result).thinkingLevelMap).toEqual(customMap);
  });

  it("leaves non-reasoning models untouched", () => {
    const model = builtInModel("plain-model", { reasoning: false });
    const result = generateModelsConfig(config, cache({ "endpoint-1": cachedProfile({ "plain-model": cachedModel("plain-model", model) }) }), runtime([model]));
    expect(firstModel(result).reasoning).toBe(false);
    expect(firstModel(result).thinkingLevelMap).toBeUndefined();
  });

  it("does not touch non-openai-completions profiles", () => {
    const model: BuiltInModelRecord = builtInModel("qwen-27b", { thinkingLevelMap: REASONING_SOURCE_MAP });
    const otherConfig: ManagedConfig = { version: 1, profiles: { "endpoint-1": profile({ api: "anthropic-messages" }) } };
    const otherRuntime: RuntimeCapabilities = { adapters: ["anthropic-messages"], builtInModels: [model] };
    const result = generateModelsConfig(otherConfig, cache({ "endpoint-1": cachedProfile({ "qwen-27b": cachedModel("qwen-27b", model) }) }), otherRuntime);
    const generated = firstModel(result);
    expect(generated.thinkingLevelMap).toEqual(REASONING_SOURCE_MAP);
  });
});
