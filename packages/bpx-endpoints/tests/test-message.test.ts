import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { confirmAndTestProfileModel } from "../src/test-message.js";
import type { CachedProfile, EndpointProfile } from "../src/types.js";

type StreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;

function profile(overrides: Partial<EndpointProfile> = {}): EndpointProfile {
  return {
    id: "endpoint-1",
    enabled: true,
    name: "E1",
    api: "openai-completions",
    baseUrl: "https://x.test/v1",
    discovery: { mode: "endpoint", modelsPath: "/models" },
    modelPolicy: { mode: "includeAll", exclude: [] },
    ...overrides,
  };
}

function cachedModel(): CachedProfile["models"][string] {
  return {
    id: "test-model",
    available: true,
    candidates: [
      {
        sourceId: "pi:openai:gpt-4",
        sourceType: "pi-built-in",
        modelId: "gpt-4",
        match: "exact",
        model: {
          id: "gpt-4",
          name: "GPT-4",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      },
    ],
  };
}

function textDelta(delta: string): AssistantMessageEvent {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: { role: "assistant", content: [{ type: "text", text: delta }], api: "openai-completions", provider: "endpoint-1", model: "gpt-4", usage: undefined } as never,
  };
}

function streamWith(...events: AssistantMessageEvent[]): StreamFn {
  return async function* () {
    for (const event of events) yield event;
  };
}

/** A stream that never yields, but rejects when the provided signal aborts — mimics a real hung request. */
function hangingStream(): StreamFn {
  return async function* (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) {
    await new Promise<void>((resolve, reject) => {
      if (options?.signal?.aborted) return reject(options.signal.reason);
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      setTimeout(() => reject(new Error("harness: stream escaped signal")), 10_000);
    });
  };
}

async function run(input: Partial<Parameters<typeof confirmAndTestProfileModel>[0]> = {}) {
  const notify = vi.fn();
  const result = await confirmAndTestProfileModel({
    profile: profile(),
    cachedModel: cachedModel(),
    confirm: async () => true,
    notify,
    ...input,
  });
  return { result, notify };
}

describe("confirmAndTestProfileModel", () => {
  it("reports success with latency and reply preview", async () => {
    const { result, notify } = await run({ streamLoader: async () => streamWith(textDelta("OK")) });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.replyPreview).toBe("OK");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("succeeded"), "info");
  });

  it("uses the effective registered model when provided", async () => {
    const seen: Model<Api>[] = [];
    const effectiveModel = { ...cachedModel().candidates[0]!.model, id: "effective-model", name: "Effective" } as unknown as Model<Api>;
    await run({
      model: effectiveModel,
      streamLoader: async () =>
        (async function* (model: Model<Api>) {
          seen.push(model);
          yield textDelta("OK");
        }) as unknown as StreamFn,
    });
    expect(seen[0]!.id).toBe("effective-model");
  });

  it("reports failure when the stream produces zero events", async () => {
    const { result, notify } = await run({ streamLoader: async () => streamWith() });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toMatch(/content/i);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("failed"), "error");
  });

  it("reports timeout for a hung endpoint", async () => {
    const { result, notify } = await run({ streamLoader: async () => hangingStream(), timeoutMs: 50 });
    expect(result.status).toBe("timeout");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("timed out"), "error");
  });

  it("reports cancelled when the caller signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const { result } = await run({
      signal: controller.signal,
      streamLoader: async () => hangingStream(),
      timeoutMs: 5000,
    });
    expect(result.status).toBe("cancelled");
  });

  it("returns cancelled without streaming when the user declines the confirmation", async () => {
    const streamLoader = vi.fn();
    const { result } = await run({
      confirm: async () => false,
      streamLoader: streamLoader as never,
    });
    expect(result.status).toBe("cancelled");
    expect(streamLoader).not.toHaveBeenCalled();
  });

  it("classifies auth failures with an actionable hint", async () => {
    const { result, notify } = await run({
      streamLoader: async () =>
        (async function* () {
          throw new Error("Request failed with 401 Unauthorized");
        }) as unknown as StreamFn,
    });
    expect(result.status).toBe("failed");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("apiKey source"), "error");
  });

  it("passes signal and maxTokens through to the stream", async () => {
    let captured: SimpleStreamOptions | undefined;
    const { result } = await run({
      streamLoader: async () =>
        (async function* (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) {
          captured = options;
          yield textDelta("OK");
        }) as unknown as StreamFn,
    });
    expect(result.status).toBe("success");
    expect(captured?.maxTokens).toBe(64);
    expect(captured?.signal).toBeDefined();
  });
});
