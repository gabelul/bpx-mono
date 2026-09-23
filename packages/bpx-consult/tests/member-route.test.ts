import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BpxConsultConfig } from "../src/config.js";

const mocked = vi.hoisted(() => ({
	callCli: vi.fn(),
	pick: vi.fn(),
	listCodex: vi.fn(),
	save: vi.fn(),
	load: vi.fn(),
}));
vi.mock("../src/cli-backend.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/cli-backend.js")>(),
	callCliAdvisor: mocked.callCli,
}));
vi.mock("../src/picker.js", () => ({ showFilterablePicker: mocked.pick }));
vi.mock("../src/cli-models.js", () => ({ listCliModels: mocked.listCodex }));
vi.mock("../src/config.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/config.js")>(),
	saveConfig: mocked.save,
	loadConfig: mocked.load,
}));

const { confirmMemberModel, describePersonaBackend, probeMemberRoute, runMemberDetail } = await import("../src/consult-ui.js");
const ctx = { cwd: "/tmp", ui: { notify: vi.fn() }, modelRegistry: { find: vi.fn(() => undefined) } } as never;

/** Council config with a Codex route and a separate saved inline model. */
function codexConfig(): BpxConsultConfig {
	return {
		modes: { solo: { model: "anthropic/claude-sonnet-4-6" } },
		personas: { critic: { defaultModel: "anthropic/claude-sonnet-4-6", codexModel: "gpt-5.5", backend: { type: "cli", command: "codex" } } },
	};
}

beforeEach(() => {
	mocked.callCli.mockReset().mockResolvedValue({ text: "OK", timedOut: false, exitCode: 0 });
	mocked.pick.mockReset();
	mocked.listCodex.mockReset().mockResolvedValue([{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }]);
	mocked.save.mockReset().mockReturnValue(true);
	mocked.load.mockReset().mockImplementation(() => mocked.save.mock.calls.at(-1)?.[0]);
});

describe("backend-first member screen", () => {
	it("shows Codex model selection after backend, not the inactive pi model", async () => {
		mocked.pick.mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, codexConfig(), "critic", [], {});
		const screen = mocked.pick.mock.calls[0]?.[1];
		expect(screen.items.map((item: { value: string }) => item.value)).toEqual(["backend", "model", "window", "test", "__back__"]);
		expect(screen.proseLines).toContain("Model: gpt-5.5");
		expect(screen.proseLines[0]).toContain("cli:codex");
	});

	it("probes selected Codex model before persisting through the full picker flow", async () => {
		const config = codexConfig();
		mocked.pick.mockResolvedValueOnce("model").mockResolvedValueOnce("gpt-5.6-sol")
			.mockResolvedValueOnce("test").mockResolvedValueOnce("assign").mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, config, "critic", [], {});
		expect(mocked.callCli.mock.calls[0]?.[0].backend.model).toBe("gpt-5.6-sol");
		expect(mocked.save).toHaveBeenCalledTimes(1);
		expect(mocked.callCli.mock.invocationCallOrder[0]).toBeLessThan(mocked.save.mock.invocationCallOrder[0]!);
		expect(mocked.save.mock.calls[0]?.[0].personas.critic).toMatchObject({
			defaultModel: "anthropic/claude-sonnet-4-6", cliModels: { codex: "gpt-5.6-sol" },
		});
	});

	it("loads Codex models for its picker rather than pi's registry", async () => {
		mocked.pick.mockResolvedValueOnce("model").mockResolvedValueOnce(null).mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, codexConfig(), "critic", [{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" }] as never, {});
		expect(mocked.listCodex).toHaveBeenCalledWith("codex", "/tmp");
		const modelPicker = mocked.pick.mock.calls[1]?.[1];
		expect(modelPicker.items.map((item: { value: string }) => item.value)).toContain("gpt-5.6-sol");
		expect(modelPicker.items.map((item: { value: string }) => item.value)).not.toContain("anthropic/claude-sonnet-4-6");
	});

	it("matches probe/live fallback when a persona has no defaultModel", async () => {
		const config: BpxConsultConfig = {
			modes: { solo: { model: "openai/codex" } },
			backends: { "openai/codex": { type: "cli", command: "codex" } },
			personas: { reviewer: { systemPrompt: "Review this." } },
		};
		expect(describePersonaBackend(config, config.personas!.reviewer!)).toBe("cli:codex");
		mocked.pick.mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, config, "reviewer", [], {});
		const screen = mocked.pick.mock.calls[0]?.[1];
		expect(screen.items.map((item: { value: string }) => item.value)).toEqual(["backend", "model", "window", "test", "__back__"]);
		expect(screen.proseLines).toContain("Model: Codex configured default");
		expect((await probeMemberRoute(ctx, config, "reviewer")).ok).toBe(true);
		expect(mocked.callCli.mock.calls[0]?.[0].backend.command).toBe("codex");
	});

	it("preserves a legacy Codex model through Claude and back", async () => {
		const config = codexConfig();
		config.personas!.critic!.codexModel = "gpt-old";
		mocked.pick.mockResolvedValueOnce("backend").mockResolvedValueOnce("cli:claude").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("model").mockResolvedValueOnce("sonnet").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("backend").mockResolvedValueOnce("cli:codex").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, config, "critic", [], {});
		const saved = mocked.save.mock.calls.at(-1)?.[0].personas.critic;
		expect(saved.cliModels).toMatchObject({ codex: "gpt-old", claude: "sonnet" });
		expect(saved.backend.command).toBe("codex");
		expect(describePersonaBackend(config, saved)).toBe("cli:codex");
	});

	it("shows pi model and effort when route is inline", async () => {
		const config = codexConfig();
		config.personas!.critic!.backend = { type: "inline" };
		mocked.pick.mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, config, "critic", [], {});
		const screen = mocked.pick.mock.calls[0]?.[1];
		expect(screen.items.map((item: { value: string }) => item.value)).toEqual(["backend", "model", "effort", "test", "__back__"]);
		expect(screen.proseLines).toContain("Model: claude-sonnet-4-6");
	});
});

describe("member model candidate probes", () => {
	it("rejects a missing custom CLI window in the probe before live resolution", async () => {
		const config = codexConfig();
		config.personas!.critic!.backend = { type: "cli", command: "custom-cli" };
		const result = await probeMemberRoute(ctx, config, "critic");
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/context window/i);
		expect(mocked.callCli).not.toHaveBeenCalled();
	});
	it("tests the proposed Codex model through cli:codex before assigning it", async () => {
		const config = codexConfig();
		const candidate = { ...config.personas!.critic!, codexModel: "gpt-5.6-sol" };
		mocked.pick.mockResolvedValueOnce("test").mockResolvedValueOnce("assign");
		expect(await confirmMemberModel(ctx, config, "critic", candidate, "gpt-5.6-sol")).toBe(true);
		expect(mocked.callCli).toHaveBeenCalledWith(expect.objectContaining({
			backend: expect.objectContaining({ type: "cli", command: "codex", model: "gpt-5.6-sol" }),
		}));
		expect(config.personas!.critic!.codexModel).toBe("gpt-5.5"); // candidate not saved by probe
	});

	it("rejects a failed Codex candidate without changing the assigned model", async () => {
		const config = codexConfig();
		mocked.callCli.mockResolvedValue({ text: "", timedOut: false, exitCode: 1, errorMessage: "unsupported model" });
		mocked.pick.mockResolvedValueOnce("test");
		expect(await confirmMemberModel(ctx, config, "critic", { ...config.personas!.critic!, codexModel: "gpt-6-sol" }, "gpt-6-sol")).toBe(false);
		expect(config.personas!.critic!.codexModel).toBe("gpt-5.5");
		expect(mocked.pick).toHaveBeenCalledTimes(1);
	});

	it("retest uses the same resolved route and stored model", async () => {
		const config = codexConfig();
		const result = await probeMemberRoute(ctx, config, "critic");
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("cli:codex/gpt-5.5");
		expect(mocked.callCli.mock.calls[0]?.[0].backend.model).toBe("gpt-5.5");
	});

	it("tests CLI when an inline model selects a legacy CLI route", async () => {
		const config: BpxConsultConfig = {
			backends: { "anthropic/new": { type: "cli", command: "codex" } },
			personas: { critic: { defaultModel: "anthropic/old" } },
		};
		mocked.pick.mockResolvedValueOnce("test").mockResolvedValueOnce("assign");
		expect(await confirmMemberModel(ctx, config, "critic", { defaultModel: "anthropic/new" }, "new", [])).toBe(true);
		expect(mocked.callCli.mock.calls[0]?.[0].backend.command).toBe("codex");
		expect(config.personas!.critic!.defaultModel).toBe("anthropic/old");
	});

	it("warns about an inline-to-CLI transition before assignment", async () => {
		const config: BpxConsultConfig = {
			backends: { "anthropic/new": { type: "cli", command: "codex" } },
			personas: { critic: { defaultModel: "anthropic/old" } },
		};
		mocked.pick.mockResolvedValueOnce("model").mockResolvedValueOnce("anthropic/new").mockResolvedValueOnce("cancel").mockResolvedValueOnce("__back__");
		await runMemberDetail(ctx, config, "critic", [{ provider: "anthropic", id: "new", name: "New" }] as never, {});
		expect(mocked.pick.mock.calls[2]?.[1].proseLines.join(" ")).toContain("inline → cli:codex");
		expect(config.personas!.critic!.defaultModel).toBe("anthropic/old");
	});

	it("tests an inline candidate through pi when it changes a legacy CLI route", async () => {
		const config: BpxConsultConfig = {
			backends: { "anthropic/old": { type: "cli", command: "codex" } },
			personas: { critic: { defaultModel: "anthropic/old" } },
		};
		const candidate = { defaultModel: "anthropic/missing" };
		mocked.pick.mockResolvedValueOnce("test");
		expect(await confirmMemberModel(ctx, config, "critic", candidate, "missing")).toBe(false);
		expect(mocked.callCli).not.toHaveBeenCalled();
		expect(config.personas!.critic!.defaultModel).toBe("anthropic/old");
	});
});
