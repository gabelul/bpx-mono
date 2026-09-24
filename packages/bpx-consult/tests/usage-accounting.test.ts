import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type BpxConsultConfig } from "../src/config.js";
import { ConsultUsage } from "../src/usage.js";

const mocked = vi.hoisted(() => ({ complete: vi.fn(), cli: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: mocked.complete }));
vi.mock("../src/cli-backend.js", async (original) => ({
	...await original<typeof import("../src/cli-backend.js")>(),
	callCliAdvisor: mocked.cli,
}));

const { executeSolo } = await import("../src/solo.js");
const { executeCouncil } = await import("../src/council.js");
const { executeDebate } = await import("../src/debate.js");

const model = { id: "unit", provider: "test", contextWindow: 200000, maxTokens: 4096 };
const ctx = {
	cwd: "/tmp",
	modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
	sessionManager: { getEntries: () => [], getLeafId: () => null, getSessionId: () => "usage-test" },
	ui: { notify: vi.fn() },
} as unknown as ExtensionContext;

/** Give each response distinct token and cost values so omitted calls are visible. */
function usage(n: number): Usage {
	return {
		input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4,
		totalTokens: n * 10,
		cost: { input: n / 100, output: n / 50, cacheRead: n / 200, cacheWrite: n / 400, total: n / 20 },
	};
}

function response(n: number, stopReason = "stop", errorMessage?: string) {
	return { content: [{ type: "text", text: stopReason === "stop" ? `Reply ${n}` : "" }], usage: usage(n), stopReason, errorMessage };
}

function config(): BpxConsultConfig {
	const value = structuredClone(DEFAULT_CONFIG);
	value.modes!.solo = { model: "test/unit" };
	value.modes!.council = { members: ["architect", "critic"], parallel: false, synthesizer: { model: "test/unit" } };
	value.modes!.debate = { advocate: "architect", critic: "critic", rounds: 1 };
	return value;
}

beforeEach(() => {
	mocked.complete.mockReset();
	mocked.cli.mockReset().mockResolvedValue({ text: "CLI reply", timedOut: false, exitCode: 0 });
});

describe("consult usage", () => {
	it("sums cache and cost fields, preserves unknown optional fields, and seals late calls", () => {
		const tracker = new ConsultUsage();
		tracker.record({ ...usage(2), reasoning: 1 } as Usage);
		tracker.record({ ...usage(3), reasoning: 2 } as Usage);
		const result = tracker.attach({ content: [{ type: "text", text: "OK" }], details: { usage: undefined } });
		expect(result.usage).toMatchObject({ input: 5, output: 10, cacheRead: 15, cacheWrite: 20, totalTokens: 50, reasoning: 3, cost: { total: .25 } });
		tracker.record(usage(100));
		expect(result.usage?.input).toBe(5);
	});

	it("Solo includes both a too-long retry and successful response", async () => {
		mocked.complete.mockResolvedValueOnce(response(2, "error", "prompt is too long")).mockResolvedValueOnce(response(3));
		const result = await executeSolo({ ctx, config: config(), signal: undefined, onUpdate: undefined });
		expect(mocked.complete).toHaveBeenCalledTimes(2);
		expect((result as typeof result & { usage?: Usage }).usage).toMatchObject({ input: 5, totalTokens: 50, cost: { total: .25 } });
		expect(result.details?.usage).toEqual({ input: 5, output: 10, total: 50 });
	});

	it("Council counts every inline member and failed synthesis", async () => {
		mocked.complete.mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(3)).mockResolvedValueOnce(response(4, "error", "synthesis failed"));
		const result = await executeCouncil({ ctx, config: config(), signal: undefined, onUpdate: undefined });
		expect(result.details?.errorMessage).toBe("synthesis failed");
		expect((result as typeof result & { usage?: Usage }).usage).toMatchObject({ input: 9, totalTokens: 90, cost: { total: .45 } });
		expect(result.details?.usage).toEqual({ input: 9, output: 18, total: 90 });
	});

	it("Council keeps usage when all members fail and synthesis never runs", async () => {
		mocked.complete.mockResolvedValueOnce(response(2, "error", "first failed")).mockResolvedValueOnce(response(3, "error", "second failed"));
		const result = await executeCouncil({ ctx, config: config(), signal: undefined, onUpdate: undefined });
		expect(result.details?.errorMessage).toBe("all members failed");
		expect(mocked.complete).toHaveBeenCalledTimes(2);
		expect((result as typeof result & { usage?: Usage }).usage).toMatchObject({ input: 5, totalTokens: 50, cost: { total: .25 } });
	});

	it("mixed Council reports only inline usage, without pricing the CLI", async () => {
		const value = config();
		value.personas = { critic: { backend: { type: "cli", command: "codex" } } };
		mocked.complete.mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(4));
		const result = await executeCouncil({ ctx, config: value, signal: undefined, onUpdate: undefined });
		expect(mocked.cli).toHaveBeenCalledTimes(1);
		expect((result as typeof result & { usage?: Usage }).usage).toMatchObject({ input: 6, totalTokens: 60 });
		expect((result as typeof result & { usage?: Usage }).usage?.cost.total).toBeCloseTo(.3);
	});

	it("Debate keeps completed round usage when a later step fails", async () => {
		mocked.complete.mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(3, "error", "critic failed"));
		const result = await executeDebate({ ctx, config: config(), signal: undefined, onUpdate: undefined });
		expect(result.details?.errorMessage).toContain("critic failed");
		expect((result as typeof result & { usage?: Usage }).usage).toMatchObject({ input: 5, totalTokens: 50, cost: { total: .25 } });
		expect(result.details?.usage).toEqual({ input: 5, output: 10, total: 50 });
	});

	it("CLI-only consultations report no invented usage", async () => {
		const value = config();
		value.modes!.solo = { model: "external/model", backend: { type: "cli", command: "codex" } };
		const result = await executeSolo({ ctx, config: value, signal: undefined, onUpdate: undefined });
		expect((result as typeof result & { usage?: Usage }).usage).toBeUndefined();
		expect(result.details?.usage).toBeUndefined();
	});
});
