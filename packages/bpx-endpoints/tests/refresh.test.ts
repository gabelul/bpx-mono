import { describe, expect, it } from "vitest";
import { discoveryUrls, fetchWithRetry, parseEndpointModels, ProbeWorthyError, discoverEndpointModels, resolveProfileBaseUrl } from "../src/refresh.js";
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// ---------------------------------------------------------------------------
// parseEndpointModels — response shape handling
// ---------------------------------------------------------------------------

describe("parseEndpointModels", () => {
  it("parses bare arrays", () => {
    const result = parseEndpointModels([{ id: "a" }, { id: "b" }]);
    expect(result.models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.warnings).toEqual([]);
  });

  it("parses { data: [...] }", () => {
    const result = parseEndpointModels({ data: [{ id: "gpt-4" }] });
    expect(result.models[0]!.id).toBe("gpt-4");
  });

  it("parses { models: [...] } (Ollama /api/tags style)", () => {
    const result = parseEndpointModels({ models: [{ name: "llama3:8b", model: "llama3:8b" }] });
    expect(result.models[0]!.id).toBe("llama3:8b");
  });

  it("parses { data: { models: [...] } } nesting", () => {
    const result = parseEndpointModels({ data: { object: "list", models: [{ id: "nested" }] } });
    expect(result.models[0]!.id).toBe("nested");
  });

  it("parses object-keyed maps { models: { id: {...} } }", () => {
    const result = parseEndpointModels({ models: { "gpt-4": { name: "GPT-4" }, "gpt-4o": { name: "GPT-4o" } } });
    expect(result.models.map((m) => m.id).sort()).toEqual(["gpt-4", "gpt-4o"]);
  });

  it("parses object-keyed maps under data", () => {
    const result = parseEndpointModels({ data: { "claude-3": { name: "Claude 3" }, "claude-3-opus": {} } });
    expect(result.models.map((m) => m.id).sort()).toEqual(["claude-3", "claude-3-opus"]);
  });

  it("uses the map key as the model id even when the value carries a different id", () => {
    const result = parseEndpointModels({ models: { "key-name": { id: "value-id" } } });
    expect(result.models[0]!.id).toBe("key-name");
  });

  it("drops duplicate ids with a warning", () => {
    const result = parseEndpointModels([{ id: "a" }, { id: "a" }, { id: "b" }]);
    expect(result.models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.warnings.join(" ")).toMatch(/duplicate/i);
  });

  it("skips entries without a usable id with a warning", () => {
    const result = parseEndpointModels([{ id: "a" }, {}, { foo: 1 }, "just-a-string"]);
    expect(result.models.map((m) => m.id)).toEqual(["a", "just-a-string"]);
    expect(result.warnings.join(" ")).toMatch(/Skipped 2/);
  });

  it("warns on an explicitly empty model list", () => {
    const result = parseEndpointModels({ data: [] });
    expect(result.models).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/no models/i);
  });

  it("throws ProbeWorthyError for unsupported shapes", () => {
    expect(() => parseEndpointModels({ foo: "bar" })).toThrow(ProbeWorthyError);
    expect(() => parseEndpointModels(42)).toThrow(ProbeWorthyError);
  });

  it("does not treat a metadata-only record as an object-keyed map", () => {
    expect(() => parseEndpointModels({ object: "list", has_more: false })).toThrow(ProbeWorthyError);
  });
});

// ---------------------------------------------------------------------------
// discoveryUrls — modelsUrl override, hint, probing
// ---------------------------------------------------------------------------

describe("discoveryUrls", () => {
  it("uses discovery.modelsUrl exclusively when set (full override)", () => {
    const urls = discoveryUrls(profile({ discovery: { mode: "endpoint", modelsPath: "/models", modelsUrl: "http://host:11434/api/tags", probe: true } }));
    expect(urls).toEqual(["http://host:11434/api/tags"]);
  });

  it("joins baseUrl + modelsPath by default", () => {
    const urls = discoveryUrls(profile());
    expect(urls).toEqual(["http://localhost:1234/v1/models"]);
  });

  it("prefers the cached hint URL when provided (no repeat guessing)", () => {
    const urls = discoveryUrls(profile(), "http://localhost:1234/api/tags");
    expect(urls[0]).toBe("http://localhost:1234/api/tags");
  });

  it("probes origin-root common paths when probe is enabled (deduped)", () => {
    const urls = discoveryUrls(profile({ discovery: { mode: "endpoint", modelsPath: "/models", probe: true } }));
    expect(urls).toEqual([
      "http://localhost:1234/v1/models",
      "http://localhost:1234/models",
      "http://localhost:1234/api/tags",
      "http://localhost:1234/api/models",
    ]);
  });

  it("does not probe when probe is disabled", () => {
    const urls = discoveryUrls(profile());
    expect(urls).toEqual(["http://localhost:1234/v1/models"]);
  });
});

// ---------------------------------------------------------------------------
// discoverEndpointModels — probing behavior
// ---------------------------------------------------------------------------

describe("discoverEndpointModels", () => {
  it("returns the first URL that yields models and records the resolved URL", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return url.endsWith("/api/tags") ? jsonResponse({ models: [{ name: "llama3:8b" }] }) : jsonResponse({}, 404);
    };
    const result = await discoverEndpointModels(profile({ discovery: { mode: "endpoint", modelsPath: "/models", probe: true } }), fetcher);
    expect(result.discoveryUrl).toBe("http://localhost:1234/api/tags");
    expect(result.models[0]!.id).toBe("llama3:8b");
    expect(calls.length).toBeGreaterThan(1); // probed past the 404
  });

  it("throws immediately on auth failures — never probes past 401/403", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return jsonResponse({ error: "denied" }, 401);
    };
    await expect(discoverEndpointModels(profile({ discovery: { mode: "endpoint", modelsPath: "/models", probe: true } }), fetcher)).rejects.toThrow(/HTTP 401/);
    expect(calls).toEqual(["http://localhost:1234/v1/models"]);
  });

  it("returns an empty result without probing when only one URL is configured", async () => {
    const fetcher = async () => jsonResponse({ data: [] });
    const result = await discoverEndpointModels(profile(), fetcher);
    expect(result.models).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/no models/i);
  });

  it("keeps the explicit modelsUrl when set, even for an empty result", async () => {
    const fetcher = async () => jsonResponse({ models: [] });
    const result = await discoverEndpointModels(profile({ discovery: { mode: "endpoint", modelsPath: "/models", modelsUrl: "http://host:11434/api/tags", probe: true } }), fetcher);
    expect(result.discoveryUrl).toBe("http://host:11434/api/tags");
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetry — bounded retries
// ---------------------------------------------------------------------------

describe("fetchWithRetry", () => {
  it("returns immediately on success", async () => {
    const fetcher = async () => jsonResponse({ ok: true });
    const response = await fetchWithRetry({ fetcher, url: "https://x.test" });
    expect(response.status).toBe(200);
  });

  it("retries 429 honoring Retry-After then succeeds", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 429, { "retry-after": "0" }) : jsonResponse({ ok: true });
    };
    const response = await fetchWithRetry({ fetcher, url: "https://x.test" });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries 5xx then succeeds", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
    };
    const response = await fetchWithRetry({ fetcher, url: "https://x.test" });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("returns the final 429/5xx response when retries are exhausted", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return jsonResponse({}, 500);
    };
    const response = await fetchWithRetry({ fetcher, url: "https://x.test", retries: 1 });
    expect(response.status).toBe(500);
    expect(calls).toBe(2);
  });

  it("does not retry 4xx errors other than 429", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return jsonResponse({}, 404);
    };
    const response = await fetchWithRetry({ fetcher, url: "https://x.test", retries: 2 });
    expect(response.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("retries transient network errors (ECONNRESET) and succeeds", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      }
      return jsonResponse({ ok: true });
    };
    const response = await fetchWithRetry({ fetcher, url: "https://x.test" });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not retry caller aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetcher = async (_url: string, init?: RequestInit) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => undefined);
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    await expect(fetchWithRetry({ fetcher, url: "https://x.test" })).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveProfileBaseUrl — $ENV / !command expansion at use time
// ---------------------------------------------------------------------------
describe("resolveProfileBaseUrl", () => {
  it("passes plain URLs through untouched, including $ that is not a variable reference", async () => {
    const plain = await resolveProfileBaseUrl({ id: "p", baseUrl: "http://localhost:1234/v1" });
    expect(plain).toBe("http://localhost:1234/v1");
    const literal = await resolveProfileBaseUrl({ id: "p", baseUrl: "http://host/path?price=$5" });
    expect(literal).toBe("http://host/path?price=$5");
  });

  it("expands $VAR and ${VAR} mid-URL from the environment", async () => {
    process.env.BPX_TEST_HOST = "10.0.0.7:8080";
    try {
      expect(await resolveProfileBaseUrl({ id: "p", baseUrl: "http://$BPX_TEST_HOST/v1" })).toBe("http://10.0.0.7:8080/v1");
      expect(await resolveProfileBaseUrl({ id: "p", baseUrl: "http://${BPX_TEST_HOST}/v1" })).toBe("http://10.0.0.7:8080/v1");
      expect(await resolveProfileBaseUrl({ id: "p", baseUrl: "$BPX_TEST_HOST" })).toBe("10.0.0.7:8080");
    } finally {
      delete process.env.BPX_TEST_HOST;
    }
  });

  it("throws a profile-scoped error when the referenced variable is unset", async () => {
    delete process.env.BPX_TEST_MISSING;
    await expect(resolveProfileBaseUrl({ id: "p", baseUrl: "http://$BPX_TEST_MISSING/v1" })).rejects.toThrow(/BPX_TEST_MISSING referenced by baseUrl/);
  });

  it("expands !command references", async () => {
    const url = await resolveProfileBaseUrl({ id: "p", baseUrl: "!echo http://from-command:9000" });
    expect(url).toBe("http://from-command:9000");
  });
});
