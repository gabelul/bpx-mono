import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { Model, Api, AssistantMessageEvent, Context, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { KnownApi } from "../src/types.js";

/**
 * Transport verification (advisor demand): config generation proves nothing
 * about what pi actually puts on the wire. These tests capture the real
 * serialized request bodies from pi-ai's own adapters for both OpenAI APIs
 * while exercising pi thinking levels through a model whose thinkingLevelMap
 * routes off → "none" — the true-off wiring.
 */

const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
let server: Server;
let baseUrl = "";

function makeModel(api: KnownApi): Model<Api> {
  return {
    id: "qwen3.8-27b",
    name: "qwen3.8-27b",
    api,
    provider: "test-provider",
    baseUrl: `${baseUrl}/v1`,
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "medium",
      xhigh: "xhigh",
      max: "xhigh",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  } as unknown as Model<Api>;
}

async function streamOnce(api: KnownApi, thinkingLevel: "off" | "medium" | "xhigh"): Promise<void> {
  const model = makeModel(api);
  const context: Context = { messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }] };
  // pi-ai's ThinkingLevel type omits "off", but the adapters accept it at
  // runtime (it routes through thinkingLevelMap like any level — that routing
  // is exactly what this file verifies on the wire).
  const options: SimpleStreamOptions = { apiKey: "test-key", maxTokens: 32, reasoning: thinkingLevel as ThinkingLevel };
  for await (const _event of streamSimple(model, context, options) as AsyncIterable<AssistantMessageEvent>) {
    // drain
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { unparsed: raw.slice(0, 200) };
      }
      captured.push({ url: req.url ?? "", body });
      // minimal valid streaming-ish responses the adapters accept
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("/responses")) {
        res.end(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            created_at: Date.now() / 1000,
            status: "completed",
            model: "qwen3.8-27b",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: Date.now() / 1000,
            model: "qwen3.8-27b",
            choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("pi transport sends the mapped wire values (real adapters)", () => {
  it("openai-completions: pi 'off' goes on the wire as reasoning_effort 'none'", async () => {
    captured.length = 0;
    await streamOnce("openai-completions", "off");
    expect(captured.length).toBeGreaterThan(0);
    const body = captured[0]!.body;
    expect(body.reasoning_effort).toBe("none");
  });

  it("openai-completions: pi 'xhigh' maps to 'xhigh' on the wire", async () => {
    captured.length = 0;
    await streamOnce("openai-completions", "xhigh");
    expect(captured[0]!.body.reasoning_effort).toBe("xhigh");
  });

  it("openai-responses: pi 'off' becomes reasoning effort 'none' in the responses payload", async () => {
    captured.length = 0;
    await streamOnce("openai-responses", "off");
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.url).toContain("/responses");
    const reasoning = captured[0]!.body.reasoning as { effort?: string } | undefined;
    expect(reasoning?.effort).toBe("none");
  });

  it("openai-responses: pi 'medium' becomes reasoning effort 'medium'", async () => {
    captured.length = 0;
    await streamOnce("openai-responses", "medium");
    const reasoning = captured[0]!.body.reasoning as { effort?: string } | undefined;
    expect(reasoning?.effort).toBe("medium");
  });
});
