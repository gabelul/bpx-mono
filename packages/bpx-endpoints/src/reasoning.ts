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
 * only classifies, mines, and maps.
 */

import type { ReasoningProbeResult } from "./types.js";

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

/**
 * Semantic strength of known wire effort values. Unknown values sort after known ones.
 *
 * Ranks are frozen API: `nearestEffortMap` compares these against LEVEL_STRENGTH,
 * so inserting new values must never shift an existing value's rank (a shifted
 * `medium` would silently change every registered map). `none` and `minimal`
 * slot below `low`; existing low..xhigh keep their historical ranks.
 */
const EFFORT_STRENGTH: Record<string, number> = { none: 0, minimal: 0.5, low: 1, medium: 2, high: 3, xhigh: 4 };

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

/**
 * Effort values the probe tries against a live endpoint. Empirical acceptance
 * is the strongest evidence, but the list can only discover what it tries —
 * `extractSupportedEfforts` catches declared sets that fall outside it.
 */
export const PROBE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "minimal", "none"] as const;

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
  // Inconclusive evidence is murky regardless of shape — keep reasoning with
  // the canonical map and say so. (Checking this before the efforts branches
  // matters: { inconclusive: true } arrives with efforts undefined.)
  if (input.inconclusive && (input.supportedEfforts === undefined || input.supportedEfforts.length === 0)) {
    return {
      reasoning: true,
      map: { ...CANONICAL_THINKING_LEVEL_MAP },
      note: "Reasoning probe was inconclusive (timeouts or rejections unrelated to reasoning_effort) — using the canonical low/medium/high map.",
    };
  }
  const efforts = input.supportedEfforts;
  if (efforts !== undefined && efforts.length > 0) {
    return { reasoning: true, map: nearestEffortMap(efforts) };
  }
  if (efforts !== undefined && !input.inconclusive) {
    return {
      reasoning: false,
      note: "Endpoint accepted no reasoning_effort value — registered as non-reasoning. If the model thinks via another mechanism, keep reasoning: true and set model compat supportsReasoningEffort:false plus a thinkingFormat (e.g. 'qwen-chat-template' or 'chat-template' with chatTemplateKwargs), or list the accepted values via reasoningEfforts in models.custom.json.",
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

/** Wire effort values the miner is allowed to believe. Anything else is noise. */
const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Phrases under which an endpoint is actually DECLARING its accepted set (as
 * opposed to echoing the rejected input back). Mining outside these windows
 * would misread error bodies that quote the bad value the client just sent.
 */
const DECLARATION_PATTERN =
  /\b(?:supported|accepted|allowed|valid|expected|must be|one of|only|choices are|should be)[^.\n]{0,80}/gi;

const EFFORT_TOKEN_PATTERN = /\b(none|minimal|low|medium|high|xhigh)\b/gi;
const DEFAULT_ANNOTATION = /\s*\((?:default|recommended)\)/gi;

/**
 * Mine an endpoint's advertised accepted-effort set from a rejection body.
 *
 * Parsing order, guarded against false positives:
 * 1. If the body is JSON with an `error.message` string, only that message is
 *    mined — request-echo fields ("request":{"reasoning_effort":"high"})
 *    elsewhere in the body are ignored.
 * 2. Otherwise the raw text is split into sentences and any sentence containing
 *    a negated-support statement ("reasoning_effort is not supported") is
 *    dropped before mining, so negations can't smuggle in the echoed value.
 * 3. Surviving text is scanned for declaration phrases ("supported types are",
 *    "must be one of", ...) and only effort-vocabulary tokens inside those
 *    windows are believed.
 *
 * Returns undefined unless a confident declaration exists. The result is the
 * endpoint's ADVERTISED set: safe-to-send values, not proof that unlisted
 * values fail (HyperQwen advertises xhigh/medium/low but also accepts `none`).
 */
export function extractSupportedEfforts(body: string): string[] | undefined {
  // Effort-relatedness is a property of the WHOLE body (the structured message
  // alone may not name the parameter — "Supported types are ..." doesn't);
  // extraction targets are narrower: the structured message if present, else
  // the raw text with negated sentences dropped.
  if (!effortRelatedRejection(body.toLowerCase())) return undefined;
  const targets: string[] = [];
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string") targets.push(message);
  } catch {
    targets.push(body);
  }
  for (const text of targets) {
    const mined = mineDeclarations(text);
    if (mined) return mined;
  }
  return undefined;
}

const NEGATED_SUPPORT =
  /\b(?:is|are|was|were|does|do)\s+not\s+(?:supported|accepted|allowed|implemented)|\bunsupported\b|\bnot\s+(?:a\s+)?(?:valid|recognized)\b/i;

function mineDeclarations(text: string): string[] | undefined {
  const lower = text.toLowerCase();
  // Drop sentences that negate support — their neighboring words are context,
  // not declarations, and the echoed request value often sits right there.
  const sentences = lower.split(/[.\n]/).filter((sentence) => !NEGATED_SUPPORT.test(sentence));
  const found = new Set<string>();
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(DECLARATION_PATTERN)) {
      const window = match[0].replace(DEFAULT_ANNOTATION, "");
      for (const token of window.matchAll(EFFORT_TOKEN_PATTERN)) {
        if ((KNOWN_EFFORTS as readonly string[]).includes(token[1])) found.add(token[1]);
      }
    }
  }
  if (found.size === 0) return undefined;
  return orderEfforts([...found]);
}

/** Chat completions endpoint for a profile baseUrl (baseUrl may already end in /v1). */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** Responses endpoint for a profile baseUrl (baseUrl may already end in /v1). */
export function responsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

export function orderEfforts(accepted: string[]): string[] {
  const known = accepted.filter((value) => EFFORT_STRENGTH[value] !== undefined).sort((a, b) => EFFORT_STRENGTH[a]! - EFFORT_STRENGTH[b]!);
  const unknown = accepted.filter((value) => EFFORT_STRENGTH[value] === undefined);
  return [...known, ...unknown];
}
function effortStrength(value: string): number {
  return EFFORT_STRENGTH[value] ?? 100 + value.length;
}

/**
 * Effort probing and per-model reasoning policy apply to both OpenAI wire
 * protocols. Gate UI, commands, and policy on this — not on raw api equality
 * with openai-completions, which leaves responses endpoints unmanaged.
 */
export function supportsEffortPolicy(api: string | undefined): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

/** Evidence older than this is re-probed rather than reused. */
export const REASONING_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Migrate v0.2.x-era reasoning caches into the per-model shape.
 *
 * Records WITHOUT an endpointIdentity predate identity tracking: their shape
 * migrates, but they are flagged degraded so the next refresh re-probes them
 * (v0.2.x promoted timeouts to acceptances and migration cannot tell which
 * accepted values were guesses). Records WITH an identity pass untouched.
 * Anything unreadable is dropped — stale evidence must never
 * masquerade as fresh.
 */
export function migrateLegacyReasoningCache(previous: unknown): Record<string, ReasoningProbeResult> | undefined {
  if (previous === undefined || previous === null) return undefined;
  if (typeof previous !== "object") return undefined;
  const record = previous as Record<string, unknown>;
  if (typeof record.probedAt === "string" && typeof record.modelId === "string") {
    const legacy = previous as ReasoningProbeResult;
    return { [record.modelId]: legacy.endpointIdentity ? legacy : { ...legacy, degraded: true } };
  }
  const out: Record<string, ReasoningProbeResult> = {};
  for (const [key, value] of Object.entries(record)) {
    const candidate = value as ReasoningProbeResult;
    if (candidate && typeof candidate === "object" && typeof candidate.probedAt === "string" && typeof candidate.modelId === "string") {
      out[key] = candidate.endpointIdentity ? candidate : { ...candidate, degraded: true };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Collapse one model's probe evidence into the effort set it is safe to send.
 *
 * Evidence sources, strongest first: values the endpoint accepted (empirical),
 * values it declared in a rejection body (advertised). Contradictions resolve
 * against safety: a value the endpoint rejected with an effort-specific error
 * is never sent, even if some other evidence mentions it. Values that timed
 * out are unknown, not accepted: queued servers, delayed validation, and
 * heterogeneous routing all make silence ambiguous.
 *
 * Returns efforts:[] when every candidate was cleanly effort-rejected (the
 * endpoint speaks no reasoning_effort), and inconclusive:true when the evidence
 * is too murky to register anything (timeouts, unrelated errors).
 */
export function supportedEffortsFromResult(result: ReasoningProbeResult): { efforts?: string[]; inconclusive: boolean } {
  const rejectedValues = new Set(result.rejected.filter((item) => item.effortRelated).map((item) => item.value));
  const base = new Set<string>();
  for (const value of [...result.accepted, ...(result.advertised ?? [])]) {
    if (!rejectedValues.has(value)) base.add(value);
  }
  if (base.size > 0) return { efforts: orderEfforts([...base]), inconclusive: false };
  const cleanlyRejected = result.rejected.length > 0 && result.rejected.every((item) => item.effortRelated);
  const timedOut = result.timedOut ?? [];
  if (cleanlyRejected && timedOut.length === 0) {
    // Non-reasoning is only sound when the probe attempted the full
    // vocabulary: a restricted candidate set (or a learn-on-failure entry
    // whose only rejected value is "unknown") proves nothing about the rest.
    const attempted = new Set([...result.accepted, ...result.rejected.map((item) => item.value), ...timedOut]);
    const covered = (KNOWN_EFFORTS as readonly string[]).every((value) => attempted.has(value));
    if (covered) return { efforts: [], inconclusive: false };
  }
  return { inconclusive: true };
}
