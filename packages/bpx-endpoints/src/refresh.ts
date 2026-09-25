import { exec } from "node:child_process";
import { promisify } from "node:util";
import { buildParameterCandidates, generatedDefaultModel } from "./candidates.js";
import { chatCompletionsUrl, effortRelatedRejection, extractSupportedEfforts, migrateLegacyReasoningCache, orderEfforts, PROBE_EFFORT_VALUES, responsesUrl } from "./reasoning.js";
import type { CachedProfile, EndpointDiscoveryResult, EndpointModel, ModelsDevRecord, EndpointProfile, ReasoningProbeResult, RuntimeCapabilities } from "./types.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const execAsync = promisify(exec);
const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 1;

/**
 * Failures that mean "this path is probably wrong — try the next candidate URL"
 * rather than "stop and surface". 404 (path missing), unsupported response
 * shape, and non-JSON payloads are probe-worthy; auth (401/403), rate limits,
 * and network errors are not.
 */
export class ProbeWorthyError extends Error {}

export async function resolveApiKey(apiKey: string | undefined, profileId: string): Promise<string | undefined> {
  if (apiKey === undefined) return undefined;
  return resolveValueReference(apiKey, profileId, "apiKey");
}

/**
 * Resolve a profile's baseUrl reference. "!command" (whole value) runs a shell
 * command; everywhere else "$VAR" and "${VAR}" tokens expand from the
 * environment, including mid-URL forms like http://$HOST:8080/v1. An unset
 * variable is a hard error — failing fast beats sending a broken URL to DNS.
 * Expansion happens at use time: config files keep the reference, and env
 * changes apply on the next session without rewriting the config.
 */
export async function resolveProfileBaseUrl(profile: { id: string; baseUrl: string }): Promise<string> {
  const value = profile.baseUrl;
  if (value.startsWith("!")) return resolveValueReference(value, profile.id, "baseUrl");
  if (!value.includes("$")) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, plain: string | undefined) => {
    const varName = braced ?? plain!;
    const resolved = process.env[varName];
    if (!resolved) throw new Error(`Profile ${profile.id}: environment variable ${varName} referenced by baseUrl is not set or empty`);
    return resolved;
  });
}

async function resolveValueReference(value: string, profileId: string, field: string): Promise<string> {
  if (value.startsWith("${") && value.endsWith("}")) {
    const varName = value.slice(2, -1).trim();
    const resolved = process.env[varName];
    if (!resolved) throw new Error(`Profile ${profileId}: environment variable ${varName} referenced by ${field} is not set or empty`);
    return resolved;
  }
  if (value.startsWith("$")) {
    const varName = value.slice(1).trim();
    const resolved = process.env[varName];
    if (!resolved) throw new Error(`Profile ${profileId}: environment variable ${varName} referenced by ${field} is not set or empty`);
    return resolved;
  }
  if (value.startsWith("!")) {
    const command = value.slice(1).trim();
    try {
      const { stdout } = await execAsync(command, { encoding: "utf8", timeout: 10_000 });
      const result = stdout.trim();
      if (!result) throw new Error(`Profile ${profileId}: command ${command} returned empty output`);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Profile ")) throw error;
      throw new Error(`Profile ${profileId}: command ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return value;
}

/**
 * Candidate discovery URLs in order of preference:
 * 1. discovery.modelsUrl (explicit full-URL override — Ollama's /api/tags lives
 *    at the origin root while the chat base is /v1, so baseUrl-join can't express it)
 * 2. the previously resolved URL (so refresh doesn't repeat the guessing game)
 * 3. baseUrl + modelsPath (the configured join)
 * 4. when discovery.probe is enabled: origin-root variants commonly served by
 *    OpenAI-compatible / Ollama / llama.cpp endpoints.
 */
export function discoveryUrls(profile: EndpointProfile, hintUrl?: string): string[] {
  const urls: string[] = [];
  const push = (url: string | undefined) => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  if (profile.discovery.modelsUrl) {
    push(profile.discovery.modelsUrl);
    return urls;
  }
  push(hintUrl);
  push(joinUrl(profile.baseUrl, profile.discovery.modelsPath));
  if (profile.discovery.probe) {
    const origin = originOf(profile.baseUrl);
    for (const candidate of ["/models", "/v1/models", "/api/tags", "/api/models"]) {
      push(`${origin}${candidate}`);
    }
  }
  return urls;
}

export async function discoverEndpointModels(profile: EndpointProfile, fetcher: Fetcher = fetch, hintUrl?: string): Promise<EndpointDiscoveryResult> {
  const resolved = { ...profile, baseUrl: await resolveProfileBaseUrl(profile) };
  const urls = discoveryUrls(resolved, hintUrl);
  let lastError: unknown;
  for (const url of urls) {
    try {
      const discovered = await discoverFromUrl(resolved, url, fetcher);
      if (discovered.models.length === 0 && urls.length > 1) {
        lastError = new Error(`Endpoint model discovery found no models at ${url}`);
        continue;
      }
      return { ...discovered, discoveryUrl: url };
    } catch (error) {
      if (!(error instanceof ProbeWorthyError)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Endpoint model discovery failed for ${profile.id}: no candidate URLs succeeded`);
}

async function discoverFromUrl(profile: EndpointProfile, url: string, fetcher: Fetcher): Promise<{ models: EndpointModel[]; warnings: string[] }> {
  const headers = await discoveryHeaders(profile);
  let response: Response;
  try {
    response = await fetchWithRetry({ fetcher, url, init: { headers }, timeoutMs: DISCOVERY_TIMEOUT_MS, retries: MAX_RETRIES });
  } catch (error) {
    throw describeDiscoveryFetchError(profile, url, error);
  }
  if (!response.ok) throw endpointDiscoveryHttpError(profile.id, response.status, url, profile.apiKey);
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new ProbeWorthyError(`Endpoint model discovery failed for ${profile.id}: ${url} returned non-JSON (likely an HTML page). Check baseUrl points at the API, not a website.`);
  }
  try {
    return parseEndpointModels(payload);
  } catch (error) {
    if (error instanceof ProbeWorthyError) throw error;
    throw new ProbeWorthyError(`Endpoint model discovery failed for ${profile.id}: ${url} returned an unsupported response shape.`);
  }
}

/**
 * Fetch with bounded retries. Retries only transient conditions: HTTP 429
 * (honoring Retry-After) and 5xx responses, plus network-level errors that
 * look like dropped connections or per-attempt timeouts. Auth failures and
 * caller aborts pass through immediately.
 */
export async function fetchWithRetry(input: {
  fetcher: Fetcher;
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  retries?: number;
}): Promise<Response> {
  const { fetcher, url, retries = MAX_RETRIES } = input;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const init: RequestInit = { ...input.init };
    if (input.timeoutMs !== undefined) init.signal = AbortSignal.timeout(input.timeoutMs);
    try {
      const response = await fetcher(url, init);
      const retryableStatus = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!retryableStatus || attempt >= retries) return response;
      await sleep(retryAfterMs(response) ?? backoffMs(attempt));
    } catch (error) {
      if (attempt >= retries || !isRetryableNetworkError(error)) throw error;
      lastError = error;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Request to ${url} failed`);
}

export function endpointDiscoveryHttpError(profileId: string, status: number, url: string, apiKey?: string): Error {
  if (status === 401 || status === 403) {
    return new Error(`Endpoint model discovery failed for ${profileId}: HTTP ${status}. Check the apiKey source (${apiKeySourceDescription(apiKey)}).`);
  }
  if (status === 404) {
    const v1Hint = /\/v\d+(?:\/|$)/.test(url) ? "" : " Many OpenAI-compatible endpoints need a /v1 segment in baseUrl.";
    return new ProbeWorthyError(`Endpoint model discovery failed for ${profileId}: HTTP ${status} at ${url}. Check baseUrl and discovery.modelsPath.${v1Hint}`);
  }
  if (status === 429) {
    return new Error(`Endpoint model discovery failed for ${profileId}: HTTP 429 rate limited at ${url}. Wait and retry, or check your plan/quota.`);
  }
  return new Error(`Endpoint model discovery failed for ${profileId}: HTTP ${status} at ${url}`);
}

export function endpointDiscoveryFetchError(profile: EndpointProfile, url: string, _signal: AbortSignal, error: unknown): Error {
  return describeDiscoveryFetchError(profile, url, error);
}

function describeDiscoveryFetchError(profile: EndpointProfile, url: string, error: unknown): Error {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new Error(`Endpoint model discovery failed for ${profile.id}: request timed out. Check baseUrl reachability or your network.`);
  }
  const detail = describeFetchCause(error);
  return new Error(`Endpoint model discovery failed for ${profile.id}: ${detail ?? `network error while requesting ${url}`}. Check baseUrl and your network connection.`);
}

function describeFetchCause(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  const text = cause instanceof Error ? `${(cause as NodeJS.ErrnoException).code ?? ""} ${cause.message}` : String(cause);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return "DNS lookup failed — check the hostname in baseUrl";
  if (/ECONNREFUSED/i.test(text)) return "connection refused — is the server running and the port in baseUrl correct?";
  if (/certificate|CERT_|SSL|TLS|self[- ]signed/i.test(text)) return "TLS certificate problem — check the https endpoint's certificate or the URL scheme";
  return undefined;
}

export function apiKeySourceDescription(apiKey?: string): string {
  if (apiKey === undefined) return "none";
  if (apiKey.startsWith("$")) return apiKey;
  if (apiKey.startsWith("!")) return "!command";
  return "'literal key'";
}

const PROBE_REASONING_TIMEOUT_MS = 30_000;
const PROBE_REASONING_MAX_TOKENS = 1;
const PROBE_REASONING_PROMPT = "hi";
const PROBE_REASONING_DETAIL_CHARS = 300;

/**
 * Probe a live endpoint for the reasoning_effort values it actually accepts.
 *
 * Sends one minimal request per candidate value (in parallel, 1 token each)
 * for the given model id — chat completions body for openai-completions,
 * responses body (reasoning.effort) for openai-responses. 2xx means accepted;
 * 400/422 bodies are classified effort-related and, when the server declares
 * its supported set ("Supported types are xhigh, medium, and low"), the
 * declared values are mined into `advertised`.
 *
 * Evidence semantics (v0.3.0):
 * - accepted: the endpoint returned 2xx — empirically valid.
 * - advertised: the endpoint declared these values — safe to send, but the
 *   declaration is not exhaustive (values it failed to mention may work).
 * - timedOut: unknown. A request that neither succeeded nor produced an error
 *   body says nothing about the value: queued servers, delayed validation, and
 *   cold model loads all look like silence. (v0.2.x promoted timeouts to
 *   accepted when the server showed any fast signal; that inference was
 *   unsound and is gone.) A probe where every value timed out with zero
 *   signals is fatal — the endpoint hung.
 *
 * The probe is deliberately tiny (max_tokens 1 / max_output_tokens 16) —
 * enough for the server's request validation to run, which is where
 * reasoning_effort is rejected.
 */
export async function probeReasoningEfforts(input: {
  profile: EndpointProfile;
  modelId: string;
  fetcher?: Fetcher;
  values?: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
}): Promise<ReasoningProbeResult> {
  const values = [...(input.values ?? PROBE_EFFORT_VALUES)];
  const fetcher = input.fetcher ?? fetch;
  const isResponses = input.profile.api === "openai-responses";
  const url = isResponses ? responsesUrl(await resolveProfileBaseUrl(input.profile)) : chatCompletionsUrl(await resolveProfileBaseUrl(input.profile));
  const headers = await probeHeaders(input.profile);
  const timeoutMs = input.timeoutMs ?? PROBE_REASONING_TIMEOUT_MS;
  const accepted: string[] = [];
  const rejected: ReasoningProbeResult["rejected"] = [];
  const advertised = new Set<string>();
  const timedOut: string[] = [];
  let fatal: string | undefined;
  let sawFastSignal = false;
  await Promise.all(
    values.map(async (value) => {
      if (fatal) return;
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(
            isResponses
              ? { model: input.modelId, input: PROBE_REASONING_PROMPT, max_output_tokens: 16, reasoning: { effort: value } }
              : {
                  model: input.modelId,
                  messages: [{ role: "user", content: PROBE_REASONING_PROMPT }],
                  max_tokens: PROBE_REASONING_MAX_TOKENS,
                  reasoning_effort: value,
                },
          ),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (isProbeTimeout(error)) {
          timedOut.push(value);
          return;
        }
        fatal = `request failed for ${value}: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      sawFastSignal = true;
      if (response.ok) {
        accepted.push(value);
        return;
      }
      const text = await response.text().catch(() => "");
      if (response.status === 400 || response.status === 422) {
        const effortRelated = effortRelatedRejection(text);
        if (effortRelated) {
          const mined = extractSupportedEfforts(text);
          if (mined) for (const value2 of mined) advertised.add(value2);
        }
        rejected.push({ value, status: response.status, detail: text.slice(0, PROBE_REASONING_DETAIL_CHARS), effortRelated });
      } else {
        fatal = `HTTP ${response.status} for ${value}${text ? `: ${text.slice(0, 200)}` : ""}`;
      }
    }),
  );
  const probedAt = (input.now ?? (() => new Date()))().toISOString();
  if (fatal) return { probedAt, modelId: input.modelId, accepted, rejected, error: fatal };
  const result: ReasoningProbeResult = {
    probedAt,
    modelId: input.modelId,
    accepted,
    rejected,
    endpointIdentity: { api: input.profile.api, baseUrl: await resolveProfileBaseUrl(input.profile) },
    ...(timedOut.length > 0 ? { timedOut } : {}),
    ...(advertised.size > 0 ? { advertised: orderEfforts([...advertised]), learnedFrom: accepted.length > 0 ? ("probe" as const) : ("error-message" as const) } : {}),
  };
  if (timedOut.length > 0 && !sawFastSignal && timedOut.length === values.length) {
    return { ...result, error: `all probe requests timed out after ${timeoutMs}ms — endpoint slow or unresponsive` };
  }
  return result;
}

function isProbeTimeout(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    const cause = error.cause;
    if (cause instanceof Error && cause.name === "TimeoutError") return true;
    if (!cause && error.name === "TimeoutError") return true;
  }
  return /timed out|aborted due to timeout|timeout/i.test(error instanceof Error ? error.message : String(error));
}

async function probeHeaders(profile: EndpointProfile): Promise<Record<string, string>> {
  const resolvedKey = await resolveApiKey(profile.apiKey, profile.id);
  const headers: Record<string, string> = {};
  if (resolvedKey !== undefined) headers.Authorization = `Bearer ${resolvedKey}`;
  for (const [key, value] of Object.entries(profile.headers ?? {})) {
    const resolvedValue = await resolveApiKey(value, profile.id);
    if (resolvedValue === undefined) throw new Error(`Profile ${profile.id}: header ${key} has no value`);
    headers[key] = resolvedValue;
  }
  return headers;
}

/**
 * Run the reasoning_effort probe when the profile opts in, has reasoning
 * models, and speaks an API the probe supports (openai-completions,
 * openai-responses). Evidence is collected PER MODEL — launchers validate per
 * model, and one model's accepted set says nothing about its siblings — capped
 * at REASONING_PROBE_MAX_MODELS per refresh to bound cost on large catalogs.
 * Fresh per-model evidence (under REASONING_EVIDENCE_TTL_MS) is reused unless
 * force is set. A fatal probe on one model is recorded on that model alone.
 */
const REASONING_PROBE_MAX_MODELS = 3;
const REASONING_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;


async function maybeProbeReasoning(input: {
  profile: EndpointProfile;
  models: CachedProfile["models"];
  fetcher?: Fetcher;
  now?: () => Date;
  previousReasoning?: unknown;
  force?: boolean;
}): Promise<{ reasoning?: Record<string, ReasoningProbeResult>; warning?: string }> {
  const { profile, models } = input;
  if (profile.api !== "openai-completions" && profile.api !== "openai-responses") return {};
  if (!profile.discovery.reasoningProbe) return {};
  const previous = migrateLegacyReasoningCache(input.previousReasoning);
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const reasoningModels = Object.values(models)
    .filter((model) => model.available && (model.candidates[0]?.model.reasoning ?? false))
    .map((model) => model.id)
    .sort();
  if (reasoningModels.length === 0) return {};

  // Reuse fresh per-model evidence; probe the rest, oldest evidence first
  // (never-probed models sort oldest so one bad model can't starve the rest).
  const evidenceAge = (modelId: string): number => {
    const cached = previous?.[modelId];
    if (!cached) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(cached.probedAt);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  const isUsable = (modelId: string): boolean => {
    const cached = previous?.[modelId];
    if (!cached || input.force) return false;
    if (cached.error || cached.degraded) return false;
    if (!cached.endpointIdentity || cached.endpointIdentity.api !== profile.api) return false;
    if (Number.isNaN(Date.parse(cached.probedAt))) return false;
    return nowMs - Date.parse(cached.probedAt) <= REASONING_EVIDENCE_TTL_MS;
  };
  const stale = reasoningModels
    .filter((modelId) => !isUsable(modelId))
    .sort((a, b) => evidenceAge(a) - evidenceAge(b));
  const fresh = reasoningModels.filter((modelId) => !stale.includes(modelId));
  const toProbe = stale.slice(0, REASONING_PROBE_MAX_MODELS);
  const skipped = stale.slice(REASONING_PROBE_MAX_MODELS);

  const results: Record<string, ReasoningProbeResult> = {};
  for (const modelId of fresh) results[modelId] = previous![modelId];
  const warnings: string[] = [];
  for (const modelId of toProbe) {
    try {
      results[modelId] = await probeReasoningEfforts({ profile, modelId, fetcher: input.fetcher, now: input.now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[modelId] = { probedAt: (input.now ?? (() => new Date()))().toISOString(), modelId, accepted: [], rejected: [], error: message };
      warnings.push(`Reasoning probe failed for ${modelId}: ${message}`);
    }
  }
  if (skipped.length > 0) {
    warnings.push(`Reasoning probe budget reached (${REASONING_PROBE_MAX_MODELS} models/refresh) — ${skipped.length} model(s) unprobed: ${skipped.join(", ")}`);
  }
  return { reasoning: Object.keys(results).length > 0 ? results : undefined, warning: warnings.length > 0 ? warnings.join(" ") : undefined };
}

export async function refreshProfileCache(input: {
  profile: EndpointProfile;
  runtime: RuntimeCapabilities;
  modelsDevModels: ModelsDevRecord[];
  fetcher?: Fetcher;
  discoveryResult?: EndpointDiscoveryResult;
  previous?: CachedProfile;
  now?: () => Date;
  /** Re-probe reasoning efforts even when cached evidence is still fresh. */
  forceReasoning?: boolean;
}): Promise<CachedProfile> {
  const discovery = input.discoveryResult ??
    (input.profile.discovery.mode === "manual"
      ? { models: input.profile.discovery.modelIds?.map((id): EndpointModel => ({ id, available: true })) ?? [], warnings: [] }
      : await discoverEndpointModels(input.profile, input.fetcher ?? fetch, input.previous?.discoveryUrl));
  const endpointModels = discovery.models;
  const warnings: string[] = [...discovery.warnings];
  const models: CachedProfile["models"] = {};
  for (const endpointModel of endpointModels) {
    const candidates = buildParameterCandidates({
      endpointModelId: endpointModel.id,
      api: input.profile.api,
      builtInModels: input.runtime.builtInModels,
      modelsDevModels: input.modelsDevModels,
    });
    const configuredSource = input.profile.parameterSourceSelections?.[endpointModel.id];
    const configuredStillExists = !!configuredSource && candidates.some((candidate) => candidate.sourceId === configuredSource);
    if (configuredSource && !configuredStillExists) warnings.push(`Selected parameter source ${configuredSource} for ${endpointModel.id} no longer exists.`);
    models[endpointModel.id] = {
      id: endpointModel.id,
      name: endpointModel.name,
      available: endpointModel.available ?? true,
      candidates,
    };
    if (candidates.length === 0) {
      models[endpointModel.id].candidates = [
        {
          sourceId: "generated-default",
          sourceType: "generated-default",
          modelId: endpointModel.id,
          match: "none",
          model: generatedDefaultModel(endpointModel.id, endpointModel.name),
        },
      ];
    }
  }
  const reasoning = await maybeProbeReasoning({ profile: input.profile, models, fetcher: input.fetcher, now: input.now, previousReasoning: input.previous?.reasoning, force: input.forceReasoning });
  if (reasoning.warning) warnings.push(reasoning.warning);
  return {
    refreshedAt: (input.now ?? (() => new Date()))().toISOString(),
    endpointModels,
    models,
    warnings,
    discoveryUrl: discovery.discoveryUrl,
    health: input.previous?.health,
    reasoning: reasoning.reasoning ?? migrateLegacyReasoningCache(input.previous?.reasoning),
  };
}

/**
 * Parse a discovery response into model entries. Accepts the shapes seen in
 * the wild:
 * - bare array: [{id}, ...]
 * - { data: [...] }                    (OpenAI-style list)
 * - { models: [...] }                  (Ollama /api/tags style)
 * - { data: { models: [...] } }        (nested list envelope)
 * - { models: { id: {...}, ... } }     (object-keyed map)
 * - { data: { id: {...}, ... } }       (object-keyed map under data)
 * Duplicate ids are dropped (counted in warnings); entries without a usable id
 * are skipped (counted in warnings).
 */
export function parseEndpointModels(payload: unknown): EndpointDiscoveryResult {
  const entries = extractModelEntries(payload);
  if (entries === undefined) {
    throw new ProbeWorthyError("Unsupported /models response shape: expected data[], models[], an array, or an object-keyed model map");
  }
  const models: EndpointModel[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let duplicates = 0;
  for (const entry of entries) {
    const model = parseEndpointModel(entry);
    if (!model) {
      skipped += 1;
      continue;
    }
    if (seen.has(model.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  const warnings: string[] = [];
  if (entries.length === 0) warnings.push("Discovery returned no models — the models URL may be wrong or the endpoint lists none.");
  if (skipped > 0) warnings.push(`Skipped ${skipped} endpoint model entries without a usable id`);
  if (duplicates > 0) warnings.push(`Dropped ${duplicates} duplicate model id(s)`);
  return { models, warnings };
}

function extractModelEntries(payload: unknown): Array<{ id?: string; value: unknown }> | undefined {
  if (Array.isArray(payload)) return payload.map((value) => ({ value }));
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.data)) return payload.data.map((value) => ({ value }));
  if (isRecord(payload.data)) {
    const data = payload.data;
    if (Array.isArray(data.models)) return data.models.map((value) => ({ value }));
    if (Array.isArray(data.data)) return data.data.map((value) => ({ value }));
    if (isObjectKeyed(data)) return objectEntries(data);
  }
  if (Array.isArray(payload.models)) return payload.models.map((value) => ({ value }));
  if (isRecord(payload.models) && isObjectKeyed(payload.models)) return objectEntries(payload.models);
  return undefined;
}

function parseEndpointModel(entry: { id?: string; value: unknown }): EndpointModel | undefined {
  const { id: keyedId, value } = entry;
  if (typeof value === "string") {
    const id = keyedId?.trim() || value.trim();
    return id ? { id } : undefined;
  }
  if (!isRecord(value)) return keyedId?.trim() ? { id: keyedId } : undefined;
  const id = keyedId?.trim() || firstNonEmptyString(value.id, value.model, value.name);
  if (!id) return undefined;
  return { id, name: typeof value.name === "string" && value.name.trim() ? value.name : undefined, available: typeof value.available === "boolean" ? value.available : undefined };
}

function objectEntries(record: Record<string, unknown>): Array<{ id: string; value: unknown }> {
  return Object.entries(record).map(([id, value]) => ({ id, value }));
}

const META_KEYS = new Set(["object", "data", "has_more", "first_id", "last_id", "total", "page", "limit", "url", "next", "previous"]);

/** A record is an object-keyed model map when it carries non-metadata keys. */
function isObjectKeyed(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => !META_KEYS.has(key));
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function originOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  const text = cause instanceof Error ? `${(cause as NodeJS.ErrnoException).code ?? ""} ${cause.message}` : String(cause);
  if (/ECONNRESET|EPIPE|EAI_AGAIN|UND_ERR/i.test(text)) return true;
  if (/timeout|timed out/i.test(text)) return true;
  return false;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoveryHeaders(profile: EndpointProfile): Promise<Headers> {
  const resolvedKey = await resolveApiKey(profile.apiKey, profile.id);
  const headers = new Headers();
  if (resolvedKey !== undefined) headers.set("Authorization", `Bearer ${resolvedKey}`);
  for (const [key, value] of Object.entries(profile.headers ?? {})) {
    const resolvedValue = await resolveApiKey(value, profile.id);
    if (resolvedValue === undefined) throw new Error(`Profile ${profile.id}: header ${key} has no value`);
    headers.set(key, resolvedValue);
  }
  return headers;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
