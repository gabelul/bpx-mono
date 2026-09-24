import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type BpxConsultConfig } from "../src/config.js";
import { gutCheckConfig } from "../src/gut-check.js";

const mocked = vi.hoisted(() => ({ callCli: vi.fn() }));
vi.mock("../src/cli-backend.js", async (original) => ({
	...await original<typeof import("../src/cli-backend.js")>(),
	callCliAdvisor: mocked.callCli,
}));

const { executeSolo } = await import("../src/solo.js");
const { executeCouncil } = await import("../src/council.js");
const { executeDebate } = await import("../src/debate.js");

const find = vi.fn(() => undefined);
const ctx = {
	cwd: "/tmp",
	modelRegistry: { find, getApiKeyAndHeaders: () => { throw new Error("inline auth must not run"); } },
	sessionManager: { getEntries: () => [], getLeafId: () => null, getSessionId: () => "all-mode-test" },
	ui: { notify: vi.fn() },
} as unknown as ExtensionContext;

/** Configure each role independently, with no corresponding Pi registry model. */
function cliConfig(): BpxConsultConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	config.modes!.solo = { model: "external/solo", backend: { type: "cli", command: "codex" }, cliModels: { codex: "gpt-solo" } };
	config.modes!.gutCheck = { model: "external/gut", backend: { type: "cli", command: "claude" }, cliModels: { claude: "haiku" }, terse: true };
	config.modes!.council = {
		members: ["architect", "critic", "simplifier"],
		parallel: false,
		synthesizer: { model: "external/synth", backend: { type: "cli", command: "opencode" }, cliModels: { opencode: "anthropic/claude-haiku-4-5" }, cliWindows: { "opencode:anthropic/claude-haiku-4-5": 200000 } },
	};
	config.modes!.debate = { advocate: "architect", critic: "critic", rounds: 1 };
	config.personas = {
		architect: { defaultModel: "external/architect", backend: { type: "cli", command: "codex" }, cliModels: { codex: "gpt-architect" } },
		critic: { defaultModel: "external/critic", backend: { type: "cli", command: "claude" }, cliModels: { claude: "sonnet" } },
		simplifier: { defaultModel: "external/simplifier", backend: { type: "cli", command: "opencode" }, cliModels: { opencode: "opencode/paid" }, cliWindows: { "opencode:opencode/paid": 64000 } },
	};
	return config;
}

beforeEach(() => {
	find.mockClear();
	mocked.callCli.mockReset().mockResolvedValue({ text: "One useful recommendation.", timedOut: false, exitCode: 0 });
});

describe("mode dispatch through selected CLI routes", () => {
	it("Solo uses its Codex ID without resolving an inline model", async () => {
		const result = await executeSolo({ ctx, config: cliConfig(), signal: undefined, onUpdate: undefined });
		expect(result.content[0]).toMatchObject({ type: "text", text: "One useful recommendation." });
		expect(mocked.callCli.mock.calls[0]?.[0].backend).toMatchObject({ command: "codex", model: "gpt-solo" });
		expect(find).not.toHaveBeenCalled();
	});

	it("keeps historical show advice out of every advisor mode", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "Review current work", timestamp: 1 });
		session.appendCustomMessageEntry("bpx-consult", "OLD_PRIVATE_ADVICE", true);
		session.appendCustomMessageEntry("another-extension", "VISIBLE_CONTEXT", true);
		const isolated = { ...ctx, sessionManager: session } as ExtensionContext;
		const config = cliConfig();
		await executeSolo({ ctx: isolated, config, signal: undefined, onUpdate: undefined });
		await executeCouncil({ ctx: isolated, config, signal: undefined, onUpdate: undefined });
		await executeDebate({ ctx: isolated, config, signal: undefined, onUpdate: undefined });
		const forwarded = JSON.stringify(mocked.callCli.mock.calls.map(([input]) => input.messages));
		expect(forwarded).not.toContain("OLD_PRIVATE_ADVICE");
		expect(forwarded).toContain("VISIBLE_CONTEXT");
	});

	it("Gut-check uses its own Claude ID, not Solo's Codex route", async () => {
		const result = await executeSolo({ ctx, config: gutCheckConfig(cliConfig()), signal: undefined, onUpdate: undefined });
		expect(result.content[0]).toMatchObject({ type: "text", text: "One useful recommendation." });
		expect(mocked.callCli.mock.calls[0]?.[0].backend).toMatchObject({ command: "claude", model: "haiku" });
		expect(find).not.toHaveBeenCalled();
	});

	it("Council members and synthesizer use their own selected CLI models", async () => {
		const result = await executeCouncil({ ctx, config: cliConfig(), signal: undefined, onUpdate: undefined });
		expect(result.details?.members).toHaveLength(3);
		expect(mocked.callCli.mock.calls.map(([input]) => [input.backend.command, input.backend.model])).toEqual([
			["codex", "gpt-architect"], ["claude", "sonnet"], ["opencode", "opencode/paid"],
			["opencode", "anthropic/claude-haiku-4-5"],
		]);
		expect(find).not.toHaveBeenCalled();
	});

	it("updates Council seats independently when parallel replies arrive out of order", async () => {
		const config = cliConfig();
		config.modes!.council!.parallel = true;
		const pending = new Map<string, (value: { text: string; timedOut: boolean; exitCode: number }) => void>();
		mocked.callCli.mockImplementation((input) => input.systemPrompt.includes("synthesizer model")
			? Promise.resolve({ text: "Recommendation", timedOut: false, exitCode: 0 })
			: new Promise((resolve) => { pending.set(input.backend.model, resolve); }));
		const updates = vi.fn();
		const run = executeCouncil({ ctx, config, signal: undefined, onUpdate: updates });
		await vi.waitFor(() => expect(pending.size).toBe(3));
		pending.get("sonnet")!({ text: "Critic reply", timedOut: false, exitCode: 0 });
		await vi.waitFor(() => expect(updates.mock.calls.some(([update]) => update.details.members.find((m: { persona: string }) => m.persona === "critic")?.status === "ok")).toBe(true));
		const criticSnapshot = updates.mock.calls.at(-1)![0].details.members;
		expect(criticSnapshot.find((m: { persona: string }) => m.persona === "architect")?.status).toBe("pending");
		pending.get("gpt-architect")!({ text: "Architect reply", timedOut: false, exitCode: 0 });
		pending.get("opencode/paid")!({ text: "Simplifier reply", timedOut: false, exitCode: 0 });
		await run;
		expect(criticSnapshot.find((m: { persona: string }) => m.persona === "architect")?.status).toBe("pending");
		expect(updates.mock.calls.at(-1)![0].details.phase).toMatch(/Synthesizing 3\/3 replies/);
	});

	it("reports Debate's closing phase with immutable completed steps", async () => {
		const updates = vi.fn();
		await executeDebate({ ctx, config: cliConfig(), signal: undefined, onUpdate: updates });
		const first = updates.mock.calls[0]![0].details.steps;
		expect(first).toEqual([{ round: 1, role: "advocate", status: "running" }]);
		expect(updates.mock.calls.at(-1)![0].details.phase).toContain("Closing verdict");
		expect(first).toEqual([{ round: 1, role: "advocate", status: "running" }]);
	});

	it("keeps member replies when CLI synthesizer fails", async () => {
		mocked.callCli.mockImplementation(async (input) => input.systemPrompt.includes("synthesizer model")
			? { text: "", timedOut: false, exitCode: 1, errorMessage: "CLI unavailable" }
			: { text: "A member recommendation.", timedOut: false, exitCode: 0 });
		const result = await executeCouncil({ ctx, config: cliConfig(), signal: undefined, onUpdate: undefined });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("A member recommendation.");
		expect(result.details?.errorMessage).toBe("CLI unavailable");
	});

	it("Debate advocate, critic, and synthesizer use configured CLI models", async () => {
		const result = await executeDebate({ ctx, config: cliConfig(), signal: undefined, onUpdate: undefined });
		expect(result.details?.steps.map((step) => step.status)).toContain("ok");
		expect(mocked.callCli.mock.calls.map(([input]) => [input.backend.command, input.backend.model])).toEqual([
			["codex", "gpt-architect"], ["claude", "sonnet"], ["opencode", "anthropic/claude-haiku-4-5"],
		]);
		expect(find).not.toHaveBeenCalled();
	});
});
