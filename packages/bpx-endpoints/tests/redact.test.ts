import { describe, expect, it } from "vitest";
import { maskEffectiveConfig, maskSecret, redactSecrets } from "../src/redact.js";
import type { ModelsConfig } from "../src/types.js";

function configWith(overrides: unknown): ModelsConfig {
  return { providers: { "endpoint-1": { name: "E1", baseUrl: "https://x.test/v1", api: "openai-completions", ...(overrides as object) } } };
}

describe("maskSecret", () => {
  it("masks literal values, keeping a recognizable prefix/suffix", () => {
    expect(maskSecret("sk-1234567890abcdef1234567890abcdef")).toBe("sk-1...cdef");
  });

  it("fully masks short literals", () => {
    expect(maskSecret("abc")).toBe("********");
  });

  it("preserves $ENV and !command references (they are not secrets)", () => {
    expect(maskSecret("${MY_KEY}")).toBe("${MY_KEY}");
    expect(maskSecret("!security get-key")).toBe("!security get-key");
  });
});

describe("maskEffectiveConfig", () => {
  it("masks provider.apiKey but preserves $ENV refs", () => {
    const masked = maskEffectiveConfig(configWith({ apiKey: "sk-literal-1234567890", headers: {} }));
    expect(masked.providers["endpoint-1"]!.apiKey).toMatch(/^sk-/);
    expect(masked.providers["endpoint-1"]!.apiKey).not.toContain("1234567890");
    const envMasked = maskEffectiveConfig(configWith({ apiKey: "${CODE_X}" }));
    expect(envMasked.providers["endpoint-1"]!.apiKey).toBe("${CODE_X}");
  });

  it("masks every value inside provider.headers — including custom auth headers", () => {
    const masked = maskEffectiveConfig(
      configWith({ headers: { "X-API-Key": "tok-9876543210abcdef", Authorization: "Bearer sk-live-abcdef0123456789" } }),
    );
    const headers = masked.providers["endpoint-1"]!.headers!;
    expect(headers["X-API-Key"]).toBe("tok-...cdef");
    expect(headers["Authorization"]).toBe("Bear...6789");
    expect(headers["Authorization"]).not.toContain("abcdef0123456789");
  });

  it("preserves env-ref header values", () => {
    const masked = maskEffectiveConfig(configWith({ headers: { Authorization: "${GATEWAY_TOKEN}" } }));
    expect(masked.providers["endpoint-1"]!.headers!.Authorization).toBe("${GATEWAY_TOKEN}");
  });

  it("masks secrets nested in per-model headers and modelOverrides", () => {
    const config: ModelsConfig = {
      providers: {
        "endpoint-1": {
          name: "E1",
          baseUrl: "https://x.test/v1",
          api: "openai-completions",
          models: [
            {
              id: "m1",
              name: "M1",
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
              headers: { "X-API-Key": "model-token-1234567890" },
            },
          ],
          modelOverrides: { m2: { headers: { Authorization: "Bearer override-secret-123456" } } },
        },
      },
    };
    const masked = maskEffectiveConfig(config);
    expect(masked.providers["endpoint-1"]!.models![0]!.headers!["X-API-Key"]).toBe("mode...7890");
    expect(masked.providers["endpoint-1"]!.modelOverrides!.m2!.headers!.Authorization).toBe("Bear...3456");
    expect(masked.providers["endpoint-1"]!.modelOverrides!.m2!.headers!.Authorization).not.toContain("123456");
  });

  it("masks keys named apiKey/authorization/token/secret/password anywhere in the tree", () => {
    const masked = redactSecrets({ a: { token: "tok-abc", other: "keep-me", nested: { secret: "s3", apiKey: "k-123" } } });
    expect(masked).toEqual({ a: { token: "********", other: "keep-me", nested: { secret: "********", apiKey: "********" } } });
  });

  it("does not mutate the input config", () => {
    const original = configWith({ apiKey: "sk-literal-1234567890", headers: { "X-API-Key": "tok-9876543210abcdef" } });
    const snapshot = JSON.stringify(original);
    maskEffectiveConfig(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("leaves non-secret fields untouched", () => {
    const masked = maskEffectiveConfig(configWith({ baseUrl: "https://x.test/v1", name: "E1" }));
    expect(masked.providers["endpoint-1"]!.baseUrl).toBe("https://x.test/v1");
    expect(masked.providers["endpoint-1"]!.name).toBe("E1");
  });
});
