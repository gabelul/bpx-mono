/**
 * Reasoning-effort policy for OpenAI-compatible endpoints.
 *
 * Why this exists: pi sends `reasoning_effort = model.thinkingLevelMap[level] ?? level`.
 * A null or missing map entry makes pi leak the raw thinking level ("high",
 * "xhigh", "max") as the wire value. OpenAI's own schema only accepts
 * low/medium/high, and some self-hosted servers accept even less — an sglang
 * wrapper in the wild rejects both "high" and "xhigh" and only accepts
 * low/medium. Leaked values 400.
 *
 * bpx-endpoints therefore never copies a metadata source's thinkingLevelMap
 * verbatim into the generated config for openai-completions reasoning models.
 * Instead it always emits a complete, non-null map:
 * - from a canonical safe set (low/medium/high) when the endpoint is unknown,
 * - from live probe results or a manual per-profile list when the endpoint's
 *   actual accepted efforts have been established.
 *
 * The map is pure config data — this module has no network access. The probe
 * itself lives in refresh.ts (it needs the profile's auth plumbing); this file
 * only classifies and maps.
 */

/** Every pi thinking level. The map must cover all of them — no nulls, no gaps. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** Wire effort values the OpenAI schema tolerates — the safe default set. */
export const SAFE_EFFORTS = ["low", "medium", "high"] as const;

/** Semantic strength of each pi thinking level (target for nearest-effort mapping). */
export const LEVEL_STRENGTH: Record<PiThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 4,
};

/** Semantic strength of known wire effort values. Unknown values sort after known ones. */
const EFFORT_STRENGTH: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4 };

/**
 * Canonical complete map used when the endpoint's supported efforts are
 * unknown. Every pi level maps to a value the OpenAI schema accepts, so pi can
 * never leak a raw level string. "off" maps to the weakest effort (the closest
 * OpenAI-compatible APIs get to disabling thinking).
 */
export const CANONICAL_THINKING_LEVEL_MAP: Record<PiThinkingLevel, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Effort values the probe tries against a live endpoint. */
export const PROBE_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;

export interface ReasoningBuildInput {
  reasoning: boolean;
  /**
   * Efforts the endpoint is known to accept: a manual profile override, or the
   * accepted set from a live probe. `undefined` means "unknown" — fall back to
   * the canonical map. An empty array means "the endpoint accepted nothing".
   */
  supportedEfforts?: string[];
  /**
   * True when the probe's rejections were NOT effort-related, making an empty
   * accepted set ambiguous (the endpoint may 400 for unrelated reasons).
   */
  inconclusive?: boolean;
}

export interface ReasoningBuildResult {
  reasoning: boolean;
  map?: Record<string, string>;
  /** Human note surfaced as a generation/doctor warning. */
  note?: string;
}

/**
 * Decide the registered reasoning mode + thinkingLevelMap for one model.
 *
 * - Non-reasoning models: untouched (pi never sends reasoning_effort for them).
 * - Known supported efforts (probe or manual): every pi level maps to the
 *   nearest accepted effort by strength; "off" maps to the weakest one.
 * - Endpoint accepted nothing (clean, effort-related rejections): register as
 *   non-reasoning — any reasoning_effort value would 400.
 * - Endpoint accepted nothing but rejections were unrelated (inconclusive):
 *   keep reasoning with the canonical map and warn.
 * - Unknown endpoint: canonical low/medium/high map — complete, so no leaks.
 */
export function buildReasoningModel(input: ReasoningBuildInput): ReasoningBuildResult {
  if (!input.reasoning) return { reasoning: false };
  const efforts = input.supportedEfforts;
  if (efforts !== undefined && efforts.length > 0) {
    return { reasoning: true, map: nearestEffortMap(efforts) };
  }
  if (efforts !== undefined && !input.inconclusive) {
    return {
      reasoning: false,
      note: "Endpoint accepted no reasoning_effort value — registered as non-reasoning. If the model thinks via a different parameter (e.g. chat_template_kwargs), set compat.thinkingFormat or reasoningEfforts in models.custom.json.",
    };
  }
  if (efforts !== undefined && input.inconclusive) {
    return {
      reasoning: true,
      map: { ...CANONICAL_THINKING_LEVEL_MAP },
      note: "Reasoning probe was inconclusive (rejections unrelated to reasoning_effort) — using the canonical low/medium/high map.",
    };
  }
  return { reasoning: true, map: { ...CANONICAL_THINKING_LEVEL_MAP } };
}

/**
 * Map every pi thinking level onto the endpoint's accepted effort values,
 * choosing for each level the accepted value closest in strength (ties go to
 * the weaker effort; "off" always maps to the weakest accepted value).
 */
export function nearestEffortMap(accepted: string[]): Record<PiThinkingLevel, string> {
  const ordered = orderEfforts(accepted);
  const map = {} as Record<PiThinkingLevel, string>;
  for (const level of PI_THINKING_LEVELS) {
    const target = LEVEL_STRENGTH[level];
    let best = ordered[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const effort of ordered) {
      const distance = Math.abs(effortStrength(effort) - target);
      if (distance < bestDistance || (distance === bestDistance && effortStrength(effort) < effortStrength(best))) {
        best = effort;
        bestDistance = distance;
      }
    }
    map[level] = best;
  }
  return map;
}

/**
 * A thinkingLevelMap is "complete" when every pi level maps to a non-empty
 * string — only then can pi not leak a raw level. Complete maps are treated as
 * intentional (e.g. from the models.custom.json override layer) and left alone
 * when no probe/manual ground truth exists.
 */
export function isCompleteThinkingLevelMap(map: Record<string, string | null> | undefined): map is Record<string, string> {
  if (!map) return false;
  for (const level of PI_THINKING_LEVELS) {
    const value = map[level];
    if (typeof value !== "string" || value.length === 0) return false;
  }
  return true;
}

/**
 * Classify a 400/422 rejection body: does it say the reasoning_effort value
 * itself is invalid (vs. an unrelated schema error)?
 */
export function effortRelatedRejection(body: string): boolean {
  const text = body.toLowerCase();
  if (/reasoning[ _-]?effort/.test(text)) return true;
  if (/\beffort\b/.test(text) && /unexpected|invalid|unsupported|not supported|should|expected|input|literal|valid|allowed|only|choices?/i.test(text)) return true;
  return false;
}

/** Chat completions endpoint for a profile baseUrl (baseUrl may already end in /v1). */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function orderEfforts(accepted: string[]): string[] {
  const known = accepted.filter((value) => EFFORT_STRENGTH[value] !== undefined).sort((a, b) => EFFORT_STRENGTH[a]! - EFFORT_STRENGTH[b]!);
  const unknown = accepted.filter((value) => EFFORT_STRENGTH[value] === undefined);
  return [...known, ...unknown];
}

function effortStrength(value: string): number {
  return EFFORT_STRENGTH[value] ?? 100 + value.length;
}
