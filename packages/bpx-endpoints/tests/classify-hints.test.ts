import { describe, expect, it } from "vitest";
import { classifyEndpointErrorHint } from "../src/test-message.js";

describe("classifyEndpointErrorHint", () => {
  it("maps auth failures to an apiKey source hint", () => {
    const hint = classifyEndpointErrorHint("Request failed with 401 Unauthorized", "https://api.example.com/v1");
    expect(hint).toMatch(/Check the apiKey source/);
  });

  it("maps 403 and invalid-key wording to the same hint", () => {
    expect(classifyEndpointErrorHint("403 forbidden", "https://x.test")).toMatch(/apiKey source/);
    expect(classifyEndpointErrorHint("invalid_api_key", "https://x.test")).toMatch(/apiKey source/);
  });

  it("suggests a trailing /v1 only when baseUrl has no version segment", () => {
    const noVersion = classifyEndpointErrorHint("404 not found", "https://api.example.com");
    expect(noVersion).toMatch(/no version segment/);

    const withVersion = classifyEndpointErrorHint("404 not found", "https://api.example.com/v1");
    expect(withVersion).not.toMatch(/no version segment/);
    expect(withVersion).toMatch(/Check baseUrl and the model id/);
  });

  it("maps rate limiting, timeouts, and DNS failures", () => {
    expect(classifyEndpointErrorHint("429 too many requests", "https://x.test")).toMatch(/rate limiting/);
    expect(classifyEndpointErrorHint("request timed out", "https://x.test")).toMatch(/timed out/);
    expect(classifyEndpointErrorHint("getaddrinfo ENOTFOUND api.test", "https://x.test")).toMatch(/DNS/);
  });

  it("maps connection refused and TLS problems", () => {
    expect(classifyEndpointErrorHint("connect ECONNREFUSED 127.0.0.1:8080", "http://localhost:8080")).toMatch(/server running/);
    expect(classifyEndpointErrorHint("self-signed certificate in chain", "https://x.test")).toMatch(/certificate/);
  });

  it("flags HTML responses as a baseUrl-looks-like-a-website problem", () => {
    expect(classifyEndpointErrorHint("Unexpected token < in JSON at position 0", "https://x.test")).toMatch(/non-JSON/);
    expect(classifyEndpointErrorHint("received <html>", "https://x.test")).toMatch(/non-JSON/);
  });

  it("returns empty string for unrecognized errors", () => {
    expect(classifyEndpointErrorHint("something novel happened", "https://x.test")).toBe("");
  });
});
