import { describe, expect, it } from "vitest";
import {
  buildReasoningModel,
  CANONICAL_THINKING_LEVEL_MAP,
  chatCompletionsUrl,
  effortRelatedRejection,
  isCompleteThinkingLevelMap,
  nearestEffortMap,
  PI_THINKING_LEVELS,
} from "../src/reasoning.js";
import { probeReasoningEfforts } from "../src/refresh.js";
import type { EndpointProfile } from "../src/types.js";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// buildReasoningModel — the map policy
// ---------------------------------------------------------------------------

describe("buildReasoningModel", () => {
  it("leaves non-reasoning models untouched", () => {
    const result = buildReasoningModel({ reasoning: false });
    expect(result.reasoning).toBe(false);
    expect(result.map).toBeUndefined();
  });

  it("emits a complete canonical map when the endpoint is unknown", () => {
    const result = buildReasoningModel({ reasoning: true });
    expect(result.reasoning).toBe(true);
    expect(result.map).toEqual(CANONICAL_THINKING_LEVEL_MAP);
  });

  it("never produces null or missing entries — no pi level can leak a raw wire value", () => {
    const result = buildReasoningModel({ reasoning: true });
    for (const level of PI_THINKING_LEVELS) {
      expect(typeof result.map?.[level]).toBe("string");
    }
  });

  it("maps every pi level to the nearest accepted effort when the endpoint accepts low/medium only (the HyperAI wrapper case)", () => {
    const result = buildReasoningModel({ reasoning: true, supportedEfforts: ["low", "medium"] });
    expect(result.map).toEqual({
      off: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "medium",
      xhigh: "medium",
      max: "medium",
    });
  });

  it("keeps xhigh when the endpoint accepts the full set", () => {
    const result = buildReasoningModel({ reasoning: true, supportedEfforts: ["low", "medium", "high", "xhigh"] });
    expect(result.map).toEqual({
      off: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "xhigh",
    });
  });

  it("registers as non-reasoning when the endpoint cleanly accepted nothing", () => {
    const result = buildReasoningModel({ reasoning: true, supportedEfforts: [] });
    expect(result.reasoning).toBe(false);
    expect(result.map).toBeUndefined();
    expect(result.note).toMatch(/non-reasoning/);
  });

  it("keeps reasoning with the canonical map when the probe was inconclusive", () => {
    const result = buildReasoningModel({ reasoning: true, supportedEfforts: [], inconclusive: true });
    expect(result.reasoning).toBe(true);
    expect(result.map).toEqual(CANONICAL_THINKING_LEVEL_MAP);
    expect(result.note).toMatch(/inconclusive/);
  });

  it("honors manual efforts over probe results", () => {
    const result = buildReasoningModel({ reasoning: true, supportedEfforts: ["medium"] });
    expect(result.map).toEqual({
      off: "medium",
      minimal: "medium",
      low: "medium",
      medium: "medium",
      high: "medium",
      xhigh: "medium",
      max: "medium",
    });
  });
});

// ---------------------------------------------------------------------------
// nearestEffortMap / isCompleteThinkingLevelMap
// ---------------------------------------------------------------------------

describe("nearestEffortMap", () => {
  it("maps off to the weakest accepted effort", () => {
    const map = nearestEffortMap(["xhigh"]);
    expect(map.off).toBe("xhigh");
    expect(map.minimal).toBe("xhigh");
  });

  it("ties resolve to the weaker effort", () => {
    // medium (2) sits exactly between low (1) and high (3): dist 1 to both, low wins
    const map = nearestEffortMap(["low", "high"]);
    expect(map.medium).toBe("low");
    expect(map.max).toBe("high");
  });

  it("sorts unknown accepted values after known ones without crashing", () => {
    const map = nearestEffortMap(["medium", "turbo"]);
    expect(map.low).toBe("medium");
    expect(typeof map.xhigh).toBe("string");
  });
});

describe("isCompleteThinkingLevelMap", () => {
  it("accepts a map with all seven levels as non-empty strings", () => {
    expect(isCompleteThinkingLevelMap(CANONICAL_THINKING_LEVEL_MAP)).toBe(true);
  });

  it("rejects null entries", () => {
    expect(isCompleteThinkingLevelMap({ off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "high" })).toBe(false);
  });

  it("rejects missing entries and empty strings", () => {
    expect(isCompleteThinkingLevelMap({ low: "low" })).toBe(false);
    expect(isCompleteThinkingLevelMap({ off: "", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "high" })).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isCompleteThinkingLevelMap(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effortRelatedRejection — rejection body classification
// ---------------------------------------------------------------------------

describe("effortRelatedRejection", () => {
  it("classifies sglang's Pydantic literal_error for reasoning_effort as effort-related", () => {
    const body = "1 validation error:\n  {'type': 'literal_error', 'loc': ('body', 'reasoning_effort'), 'msg': \"Input should be 'low', 'medium' or 'high'\", 'input': 'xhigh'}";
    expect(effortRelatedRejection(body)).toBe(true);
  });

  it("classifies the sglang wrapper's 'Unexpected reasoning effort' as effort-related", () => {
    expect(effortRelatedRejection('{"message":"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low."}')).toBe(true);
  });

  it("does not classify unrelated 400s (e.g. max_tokens) as effort-related", () => {
    expect(effortRelatedRejection('{"message":"max_tokens is not supported for this model"}')).toBe(false);
    expect(effortRelatedRejection("HTML error page")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeReasoningEfforts — live probe with a mocked fetcher
// ---------------------------------------------------------------------------

describe("probeReasoningEfforts", () => {
  it("records accepted values from 2xx and rejected values with effort classification", async () => {
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      expect(url).toBe("http://localhost:1234/v1/chat/completions");
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      if (body.reasoning_effort === "low" || body.reasoning_effort === "medium") return jsonResponse({ ok: true });
      return jsonResponse({ error: { message: `Unexpected reasoning effort ${body.reasoning_effort}.` } }, 400);
    };
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "qwen-27b", fetcher });
    expect(result.error).toBeUndefined();
    expect(result.accepted).toEqual(["low", "medium"]);
    expect(result.rejected.map((r) => r.value)).toEqual(["high", "xhigh"]);
    expect(result.rejected.every((r) => r.effortRelated)).toBe(true);
  });

  it("aborts with a fatal error on auth failure instead of guessing", async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ error: "unauthorized" }, 401);
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "qwen-27b", fetcher });
    expect(result.accepted).toEqual([]);
    expect(result.error).toMatch(/401/);
  });

  it("records a fatal error when the network request throws", async () => {
    const fetcher = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "qwen-27b", fetcher });
    expect(result.accepted).toEqual([]);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("marks unrelated 400s as not effort-related (inconclusive signal)", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      if (body.reasoning_effort === "low") return jsonResponse({ ok: true });
      return jsonResponse({ error: { message: "model not found" } }, 400);
    };
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "qwen-27b", fetcher });
    expect(result.accepted).toEqual(["low"]);
    expect(result.rejected.every((r) => !r.effortRelated)).toBe(true);
  });

  it("honors custom effort values", async () => {
    const seen: string[] = [];
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      seen.push(body.reasoning_effort ?? "");
      return jsonResponse({ ok: true });
    };
    await probeReasoningEfforts({ profile: profile(), modelId: "m", fetcher, values: ["minimal", "max"] });
    expect(seen).toEqual(["minimal", "max"]);
  });

  it("treats timeouts as accepted when the server validates eagerly (slow generation, instant rejection)", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      if (body.reasoning_effort === "low" || body.reasoning_effort === "medium") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return jsonResponse({ error: { message: `Unexpected reasoning effort ${body.reasoning_effort}.` } }, 400);
    };
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "qwen-27b", fetcher, timeoutMs: 100 });
    expect(result.error).toBeUndefined();
    expect(result.accepted).toEqual(["low", "medium"]);
    expect(result.rejected.map((r) => r.value)).toEqual(["high", "xhigh"]);
  });

  it("treats timeouts as accepted when some values already 200'd", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      if (body.reasoning_effort === "low") return jsonResponse({ ok: true });
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "m", fetcher, timeoutMs: 100 });
    expect(result.error).toBeUndefined();
    expect(result.accepted).toContain("low");
    expect(result.accepted).toContain("medium");
  });

  it("aborts with a fatal error when every value times out with no signal at all", async () => {
    const fetcher = async (): Promise<Response> => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const result = await probeReasoningEfforts({ profile: profile(), modelId: "m", fetcher, timeoutMs: 100 });
    expect(result.accepted).toEqual([]);
    expect(result.error).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// chatCompletionsUrl
// ---------------------------------------------------------------------------

describe("chatCompletionsUrl", () => {
  it("appends /chat/completions to the baseUrl", () => {
    expect(chatCompletionsUrl("http://host:8080/v1")).toBe("http://host:8080/v1/chat/completions");
  });

  it("does not double the slash when baseUrl ends in /", () => {
    expect(chatCompletionsUrl("http://host:8080/v1/")).toBe("http://host:8080/v1/chat/completions");
  });
});
