import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type BpxConsultConfig } from "../src/config.js";

const mocked = vi.hoisted(() => ({ pick: vi.fn(), save: vi.fn(), load: vi.fn(), callCli: vi.fn(), list: vi.fn() }));
vi.mock("../src/picker.js", () => ({ showFilterablePicker: mocked.pick }));
vi.mock("../src/cli-backend.js", async (original) => ({
	...await original<typeof import("../src/cli-backend.js")>(), callCliAdvisor: mocked.callCli,
}));
vi.mock("../src/cli-models.js", () => ({ listCliModels: mocked.list }));
vi.mock("../src/config.js", async (original) => ({
	...await original<typeof import("../src/config.js")>(), saveConfig: mocked.save, loadConfig: mocked.load,
}));

const { runConsultConfigurator } = await import("../src/consult-ui.js");
const ctx = {
	hasUI: true, cwd: "/tmp", modelRegistry: { getAvailable: () => [], find: vi.fn(() => undefined) },
	ui: { notify: vi.fn(), input: vi.fn() },
} as unknown as ExtensionContext;

beforeEach(() => {
	mocked.pick.mockReset();
	mocked.save.mockReset().mockReturnValue(true);
	mocked.load.mockReset().mockImplementation(() => mocked.save.mock.calls.at(-1)?.[0] ?? structuredClone(DEFAULT_CONFIG));
	mocked.callCli.mockReset().mockResolvedValue({ text: "OK", exitCode: 0, timedOut: false });
	mocked.list.mockReset().mockResolvedValue([]);
	vi.mocked(ctx.ui.input).mockReset();
});

describe("backend-first mode editor", () => {
	it("selects and tests gut-check's Claude model before saving it", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		mocked.pick.mockResolvedValueOnce("gutCheck.detail")
			.mockResolvedValueOnce("backend").mockResolvedValueOnce("cli:claude").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("model").mockResolvedValueOnce("haiku").mockResolvedValueOnce("test")
			.mockResolvedValueOnce("assign").mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		expect(mocked.list).toHaveBeenCalledWith("claude", "/tmp");
		expect(mocked.callCli.mock.calls[0]?.[0].backend).toMatchObject({ command: "claude", model: "haiku" });
		expect(mocked.callCli.mock.invocationCallOrder[0]).toBeLessThan(mocked.save.mock.invocationCallOrder[1]!);
		expect(mocked.save.mock.calls[1]?.[0].modes.gutCheck.cliModels).toEqual({ claude: "haiku" });
		expect(mocked.save.mock.calls[1]?.[0].modes.solo.cliModels).toBeUndefined();
	});

	it("probes backend-only gut-check with its inherited Solo model", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.solo = { model: "pi/inherited" };
		config.modes!.gutCheck = { backend: { type: "cli", command: "codex" } };
		mocked.pick.mockResolvedValueOnce("gutCheck.detail").mockResolvedValueOnce("test")
			.mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		expect(mocked.callCli.mock.calls[0]?.[0].backend.command).toBe("codex");
		expect(mocked.pick.mock.calls[1]?.[1].proseLines).toContain("Route: cli:codex (configured default)");
		expect(mocked.save).not.toHaveBeenCalled();
	});

	it("keeps synth's OpenCode model apart from member and Solo selections", async () => {
		const config: BpxConsultConfig = structuredClone(DEFAULT_CONFIG);
		mocked.list.mockResolvedValue([{ id: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku", contextWindow: 64000 }]);
		mocked.pick.mockResolvedValueOnce("council.manage").mockResolvedValueOnce("council.synth")
			.mockResolvedValueOnce("backend").mockResolvedValueOnce("cli:opencode")
			.mockResolvedValueOnce("anthropic/claude-haiku-4-5")
			.mockResolvedValueOnce("test").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("__back__").mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		expect(mocked.callCli.mock.calls[0]?.[0].backend).toMatchObject({ command: "opencode", model: "anthropic/claude-haiku-4-5" });
		expect(mocked.save.mock.calls[0]?.[0].modes.council.synthesizer.cliModels).toEqual({ opencode: "anthropic/claude-haiku-4-5" });
		expect(mocked.save.mock.calls[0]?.[0].modes.council.synthesizer.cliWindows).toEqual({ "opencode:anthropic/claude-haiku-4-5": 64000 });
	});

	it("edits a Debate role's effective route in its own menu", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		mocked.pick.mockResolvedValueOnce("debate.detail").mockResolvedValueOnce("advocate.route")
			.mockResolvedValueOnce("backend").mockResolvedValueOnce("cli:codex").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("__back__").mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		expect(mocked.save.mock.calls[0]?.[0].personas.architect.backend).toMatchObject({ type: "cli", command: "codex" });
	});

	it("adds a CLI-only Council persona with no Pi models available", async () => {
		vi.mocked(ctx.ui.input).mockResolvedValueOnce("reviewer");
		mocked.pick.mockResolvedValueOnce("council.manage").mockResolvedValueOnce("add")
			.mockResolvedValueOnce("manual").mockResolvedValueOnce("neutral")
			.mockResolvedValueOnce("cli:claude").mockResolvedValueOnce("__codex_default__")
			.mockResolvedValueOnce("assign").mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config: structuredClone(DEFAULT_CONFIG) });
		const saved = mocked.save.mock.calls[0]?.[0];
		expect(saved.personas.reviewer).toMatchObject({ backend: { type: "cli", command: "claude" } });
		expect(saved.personas.reviewer.defaultModel).toBeUndefined();
		expect(saved.modes.council.members).toContain("reviewer");
	});

	it("preselects a saved OpenCode model when returning from Claude", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.solo!.backend = { type: "cli", command: "claude" };
		config.modes!.solo!.cliModels = { claude: "sonnet", opencode: "provider/model-a" };
		config.modes!.solo!.cliWindows = { "opencode:provider/model-a": 64000 };
		mocked.pick.mockResolvedValueOnce("solo.detail").mockResolvedValueOnce("backend")
			.mockResolvedValueOnce("cli:opencode").mockResolvedValueOnce("provider/model-a")
			.mockResolvedValueOnce("assign").mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		const pickerItems = mocked.pick.mock.calls[3]?.[1].items;
		expect(pickerItems.find((item: { value: string }) => item.value === "provider/model-a").label).toMatch(/saved, not listed.*✓/);
		expect(pickerItems.find((item: { value: string }) => item.value === "__codex_default__").label).not.toContain("✓");
		expect(mocked.save.mock.calls[0]?.[0].modes.solo.cliModels.opencode).toBe("provider/model-a");
	});

	it("requires a declared window for a manual OpenCode ID", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.solo!.backend = { type: "cli", command: "opencode", contextWindow: 64000 };
		config.modes!.solo!.cliModels = { opencode: "old/model" };
		vi.mocked(ctx.ui.input).mockResolvedValueOnce("provider/new").mockResolvedValueOnce("8000");
		mocked.pick.mockResolvedValueOnce("solo.detail").mockResolvedValueOnce("model")
			.mockResolvedValueOnce("__codex_manual__").mockResolvedValueOnce("assign")
			.mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		const seat = mocked.save.mock.calls[0]?.[0].modes.solo;
		expect(seat.cliModels.opencode).toBe("provider/new");
		expect(seat.cliWindows["opencode:provider/new"]).toBe(8000);
		expect(seat.backend.contextWindow).toBeUndefined();
	});

	it("does not save a failed candidate probe", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.solo!.backend = { type: "cli", command: "codex" };
		mocked.callCli.mockResolvedValue({ text: "", exitCode: 1, timedOut: false, errorMessage: "unsupported model" });
		mocked.pick.mockResolvedValueOnce("solo.detail").mockResolvedValueOnce("model")
			.mockResolvedValueOnce("gpt-inaccessible").mockResolvedValueOnce("test")
			.mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config });
		expect(mocked.save).not.toHaveBeenCalled();
		expect(config.modes!.solo!.cliModels).toBeUndefined();
	});
});
