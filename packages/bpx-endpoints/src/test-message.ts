import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { apiKeySourceDescription, resolveApiKey } from "./refresh.js";
import { KNOWN_APIS, type CachedProfile, type KnownApi, type EndpointProfile, type TestMessageResult } from "./types.js";

type TestStreamFunction = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
type StreamLoader = (api: KnownApi) => Promise<TestStreamFunction>;
type Notify = (message: string, type: "info" | "error") => void;

const TEST_MESSAGE_PROMPT = "Say OK";
const COST_WARNING = "Send a test message? This makes a real API call and may incur token costs.";
const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 64;
/**
 * Confirm, then send a test message through the profile's stream pipeline and
 * classify the outcome. Cancellation (caller signal) is reported as
 * `{status:"cancelled"}`, a hung endpoint as `{status:"timeout"}`, auth/network
 * failures as `{status:"failed"}` with an actionable message, and a usable
 * stream round-trip as `{status:"success"}` with latency.
 *
 * The effective registered model (`model`) wins over the cache-built model:
 * testing the exact model pi would call — including models.custom.json and
 * managed overrides — is the point. When `model` is omitted (fresh profile,
 * not yet registered) it falls back to the cached-candidate model.
 */
export async function confirmAndTestProfileModel(input: {
  profile: EndpointProfile;
  cachedModel: CachedProfile["models"][string];
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: Notify;
  signal?: AbortSignal;
  model?: Model<Api>;
  streamLoader?: StreamLoader;
  timeoutMs?: number;
}): Promise<TestMessageResult> {
  const confirmed = await input.confirm("Send test message?", COST_WARNING);
  if (!confirmed) return { status: "cancelled" };

  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? TEST_TIMEOUT_MS;
  try {
    if (!isKnownApi(input.profile.api)) throw new Error(`Unsupported API protocol ${input.profile.api}.`);
    const apiKey = (await resolveApiKey(input.profile.apiKey, input.profile.id)) ?? "unused";
    const headers = await resolveProfileHeaders(input.profile);
    const stream = await (input.streamLoader ?? loadStreamSimple)(input.profile.api);
    const model = input.model ?? buildTestModel(input.profile, input.cachedModel);
    const context: Context = {
      messages: [{ role: "user", content: TEST_MESSAGE_PROMPT, timestamp: Date.now() }],
    };
    const signal = combineSignals(input.signal, AbortSignal.timeout(timeoutMs));
    let reply = "";
    let eventCount = 0;
    for await (const event of stream(model, context, { apiKey, headers, signal, maxTokens: TEST_MAX_TOKENS })) {
      eventCount += 1;
      if (event.type === "text_delta") reply += event.delta;
      if (event.type === "error") throw new Error(event.error.errorMessage ?? "The provider returned an error response.");
    }
    // A stream that ends with zero events never actually talked to the model —
    // the endpoint accepted the HTTP call but produced nothing usable.
    if (eventCount === 0) throw new Error("The stream ended without producing any content. Check the model id and the api protocol.");
    const latencyMs = Date.now() - startedAt;
    const preview = reply.trim().slice(0, 80);
    const replySummary = preview ? ` Reply: ${preview}` : "";
    input.notify(`Test message succeeded for ${input.profile.id} in ${latencyMs}ms.${replySummary}`, "info");
    return { status: "success", latencyMs, replyPreview: preview };
  } catch (error) {
    if (input.signal?.aborted) return { status: "cancelled" };
    if (isTimeoutError(error)) {
      input.notify(`Test message timed out for ${input.profile.id} after ${timeoutMs / 1000}s. Check baseUrl reachability or your network.`, "error");
      return { status: "timeout" };
    }
    input.notify(classifyTestMessageError(input.profile, error), "error");
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function buildTestModel(profile: EndpointProfile, cachedModel: CachedProfile["models"][string]): Model<Api> {
  const selectedSource = profile.parameterSourceSelections?.[cachedModel.id];
  const candidate = selectedSource
    ? cachedModel.candidates.find((item) => item.sourceId === selectedSource)
    : cachedModel.candidates[0];
  if (!candidate) throw new Error(`No parameter source is available for model ${cachedModel.id}.`);
  return {
    ...candidate.model,
    id: cachedModel.id,
    name: cachedModel.name ?? candidate.model.name,
    api: profile.api as KnownApi,
    provider: profile.id,
    baseUrl: profile.baseUrl,
  };
}

function isKnownApi(api: string): api is KnownApi {
  return (KNOWN_APIS as readonly string[]).includes(api);
}

async function resolveProfileHeaders(profile: EndpointProfile): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.headers ?? {})) {
    const resolvedValue = await resolveApiKey(value, profile.id);
    if (resolvedValue === undefined) throw new Error(`Profile ${profile.id}: header ${key} has no value`);
    headers[key] = resolvedValue;
  }
  return headers;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    const cause = error.cause;
    if (cause instanceof Error && cause.name === "TimeoutError") return true;
  }
  return /timed out|abort/i.test(error instanceof Error ? error.message : String(error));
}

function classifyTestMessageError(profile: EndpointProfile, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const hint = classifyEndpointErrorHint(detail, profile.baseUrl, profile.apiKey);
  return `Test message failed for ${profile.id}: ${detail}${hint ? ` ${hint}` : ""}`;
}

/** Map raw provider/network error text to an actionable next step. Exported for reuse and tests. */
export function classifyEndpointErrorHint(detail: string, baseUrl: string, apiKey?: string): string {
  if (/\b(?:401|403)\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key/i.test(detail)) {
    return `Check the apiKey source (${apiKeySourceDescription(apiKey)}).`;
  }
  if (/\b404\b|not found/i.test(detail)) {
    const v1Hint = /\/v\d+(?:\/|$)/.test(baseUrl) ? "" : ` The baseUrl ${baseUrl} has no version segment — many OpenAI-compatible endpoints need a trailing /v1.`;
    return `Check baseUrl and the model id.${v1Hint}`;
  }
  if (/\b429\b|rate limit|too many requests/i.test(detail)) {
    return "The provider is rate limiting. Wait and retry, or check your plan/quota.";
  }
  if (/timeout|timed out|abort/i.test(detail)) {
    return "Request timed out. Check baseUrl reachability or your network.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) {
    return "DNS lookup failed. Check the hostname in baseUrl.";
  }
  if (/ECONNREFUSED/i.test(detail)) {
    return "Connection refused. Is the server running and the port in baseUrl correct?";
  }
  if (/certificate|CERT_|SSL|TLS|self[- ]signed/i.test(detail)) {
    return "TLS certificate problem. Check the https endpoint's certificate, or use the correct http/https scheme.";
  }
  if (/unexpected token|not valid JSON|<html/i.test(detail)) {
    return "The endpoint returned non-JSON (likely an HTML error page). Check baseUrl points at the API, not a website.";
  }
  return "";
}

async function loadStreamSimple(_api: KnownApi): Promise<TestStreamFunction> {
  // Deep subpath imports like "@earendil-works/pi-ai/api/openai-completions" do not
  // resolve inside pi's extension loader: its alias map rewrites the
  // "@earendil-works/pi-ai" prefix to the compat entrypoint file, turning the
  // specifier into ".../dist/compat.js/api/..." (a file treated as a directory).
  // The compat entrypoint is alias-mapped by pi and exports the global
  // streamSimple, which dispatches on model.api and covers every KnownApi.
  // (Root entrypoint lacks streamSimple in pi-ai 0.80.x — see bpx-consult.)
  const { streamSimple } = await import("@earendil-works/pi-ai/compat");
  return streamSimple as unknown as TestStreamFunction;
}
