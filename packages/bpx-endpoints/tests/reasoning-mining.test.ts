import { describe, expect, it } from "vitest";
import {
  buildReasoningModel,
  effortRelatedRejection,
  extractSupportedEfforts,
  migrateLegacyReasoningCache,
  nearestEffortMap,
  responsesUrl,
  supportedEffortsFromResult,
} from "../src/reasoning.js";
import type { ReasoningProbeResult } from "../src/types.js";

// The real body that started this work: HyperQwen's launcher 400s on "high".
const HYPERQWEN_BODY = JSON.stringify({
  message: "Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.",
  type: "BadRequestError",
  param: null,
  code: 400,
});

describe("extractSupportedEfforts", () => {
  it("mines the declared set from a HyperQwen-style body without the rejected value", () => {
    expect(extractSupportedEfforts(HYPERQWEN_BODY)).toEqual(["low", "medium", "xhigh"]);
  });

  it("does not steal the rejected value via the word 'unexpected'", () => {
    // "unexpected" contains "expected"; the trigger must be word-bounded.
    const body = "Unexpected reasoning effort high.";
    expect(extractSupportedEfforts(body)).toBeUndefined();
  });

  it("returns undefined for unrelated schema errors even when effort appears", () => {
    const body = String.raw`1 validation error: {'type': 'json_invalid', 'loc': ('body', 99), 'msg': 'JSON decode error'}`;
    expect(extractSupportedEfforts(body)).toBeUndefined();
  });

  it("returns undefined when the body only echoes the rejected input", () => {
    expect(extractSupportedEfforts("Invalid value: 'high'.")).toBeUndefined();
  });

  it("mines openai-style and sglang-style declarations", () => {
    expect(extractSupportedEfforts("Invalid parameter: reasoning_effort must be one of 'low', 'medium', or 'high'.")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(extractSupportedEfforts("Reasoning effort is not supported. Only low and medium are allowed.")).toEqual(["low", "medium"]);
  });
});

describe("effortRelatedRejection", () => {
  it("classifies the hyperqwen body as effort-related", () => {
    expect(effortRelatedRejection(HYPERQWEN_BODY)).toBe(true);
  });
});

describe("supportedEffortsFromResult", () => {
  it("unions accepted and advertised, minus effort-rejected values", () => {
    const result: ReasoningProbeResult = {
      probedAt: "2026-09-25T00:00:00Z",
      modelId: "m",
      accepted: ["low"],
      rejected: [{ value: "minimal", status: 400, detail: "", effortRelated: true }],
      advertised: ["low", "medium", "high"],
    };
    expect(supportedEffortsFromResult(result)).toEqual({ efforts: ["low", "medium", "high"], inconclusive: false });
  });

  it("never sends a value the endpoint effort-rejected, even if mentioned elsewhere", () => {
    const result: ReasoningProbeResult = {
      probedAt: "2026-09-25T00:00:00Z",
      modelId: "m",
      accepted: [],
      rejected: [{ value: "high", status: 400, detail: HYPERQWEN_BODY, effortRelated: true }],
      advertised: ["high", "low"],
    };
    expect(supportedEffortsFromResult(result).efforts).toEqual(["low"]);
  });

  it("empty efforts only when every candidate was cleanly effort-rejected", () => {
    const clean: ReasoningProbeResult = {
      probedAt: "2026-09-25T00:00:00Z",
      modelId: "m",
      accepted: [],
      rejected: [{ value: "low", status: 400, detail: "nope", effortRelated: true }],
    };
    expect(supportedEffortsFromResult(clean)).toEqual({ efforts: [], inconclusive: false });
  });

  it("timeouts are unknown, not rejections — murky evidence is inconclusive", () => {
    const murky: ReasoningProbeResult = {
      probedAt: "2026-09-25T00:00:00Z",
      modelId: "m",
      accepted: [],
      rejected: [],
      timedOut: ["low", "medium"],
    };
    expect(supportedEffortsFromResult(murky)).toEqual({ inconclusive: true });
  });
});

describe("nearestEffortMap — frozen strength ranks", () => {
  it("maps historical accepted sets exactly as v0.2.x did", () => {
    // low=1, medium=2, high=3, xhigh=4 are frozen API; adding none/minimal below
    // must not shift any existing mapping.
    expect(nearestEffortMap(["low", "medium", "high"])).toEqual({
      off: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    });
    expect(nearestEffortMap(["low", "medium"])).toEqual({
      off: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "medium",
      xhigh: "medium",
      max: "medium",
    });
  });

  it("maps pi off to 'none' when the endpoint accepts none (true off)", () => {
    const map = nearestEffortMap(["none", "low", "medium", "xhigh"]);
    expect(map.off).toBe("none");
    expect(map.minimal).toBe("low"); // minimal(1) is an exact match for low(1)
    expect(map.low).toBe("low");
    expect(map.high).toBe("medium"); // ties go to the weaker effort
    expect(map.xhigh).toBe("xhigh");
    expect(map.max).toBe("xhigh");
  });
});

describe("buildReasoningModel notes mention the pi-native escape hatch", () => {
  it("non-reasoning note points at compat supportsReasoningEffort/thinkingFormat", () => {
    const built = buildReasoningModel({ reasoning: true, supportedEfforts: [] });
    expect(built.reasoning).toBe(false);
    expect(built.note).toContain("supportsReasoningEffort");
    expect(built.note).toContain("thinkingFormat");
  });
});

describe("migrateLegacyReasoningCache", () => {
  it("wraps a v0.2.x single result under its own modelId", () => {
    const legacy: ReasoningProbeResult = {
      probedAt: "2026-09-05T00:00:00Z",
      modelId: "qwen-27b",
      accepted: ["low", "medium"],
      rejected: [],
    };
    const migrated = migrateLegacyReasoningCache(legacy);
    expect(migrated).toEqual({ "qwen-27b": legacy });
  });

  it("keeps already-per-model records and drops junk", () => {
    const perModel = { "a-model": { probedAt: "2026-09-05T00:00:00Z", modelId: "a-model", accepted: ["low"], rejected: [] } };
    expect(migrateLegacyReasoningCache(perModel)).toEqual(perModel);
    expect(migrateLegacyReasoningCache({ garbage: true })).toBeUndefined();
    expect(migrateLegacyReasoningCache(undefined)).toBeUndefined();
  });
});

describe("responsesUrl", () => {
  it("appends /responses without doubling the slash", () => {
    expect(responsesUrl("https://x.example/v1")).toBe("https://x.example/v1/responses");
    expect(responsesUrl("https://x.example/v1/")).toBe("https://x.example/v1/responses");
  });
});

describe("mining hardening (advisor regressions)", () => {
  it("does not mine the echoed request field from a negated-support body", () => {
    // "not supported" negates; "high" next to it is the echoed input, not a declaration.
    const body = JSON.stringify({
      error: { message: "reasoning_effort is not supported" },
      request: { reasoning_effort: "high" },
    });
    expect(extractSupportedEfforts(body)).toBeUndefined();
  });

  it("drops negated sentences but mines the affirmative ones", () => {
    const body = JSON.stringify({
      error: { message: "Reasoning effort xhigh is not supported. Supported types are low, medium, and high." },
      request: { reasoning_effort: "xhigh" },
    });
    expect(extractSupportedEfforts(body)).toEqual(["low", "medium", "high"]);
  });

  it("mines only the structured error message, ignoring sibling echo fields", () => {
    const body = JSON.stringify({
      error: { message: "Supported types are xhigh, medium, and low." },
      request: { reasoning_effort: "high" },
    });
    expect(extractSupportedEfforts(body)).toEqual(["low", "medium", "xhigh"]);
  });
});
