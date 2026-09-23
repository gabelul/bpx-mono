import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), save: vi.fn(), load: vi.fn(), advisor: vi.fn() }));
vi.mock("../src/picker.js", () => ({ showFilterablePicker: mocks.pick }));
vi.mock("../src/config.js", async (original) => ({
	...await original<typeof import("../src/config.js")>(), saveConfig: mocks.save, loadConfig: mocks.load,
}));
vi.mock("../src/advisor.js", async (original) => ({
	...await original<typeof import("../src/advisor.js")>(),
	resolveAdvisor: () => ({ label: "Test model", model: { provider: "test", id: "model", contextWindow: 20000 } }),
	callAdvisor: mocks.advisor,
}));
const { runConsultConfigurator } = await import("../src/consult-ui.js");
const model = { provider: "test", id: "model", name: "Test model" } as Model<Api>;
const ctx = {
	hasUI: true, cwd: "/tmp",
	modelRegistry: { getAvailable: () => [model] },
	ui: { notify: vi.fn(), input: vi.fn() },
} as unknown as ExtensionContext;

beforeEach(() => {
	mocks.pick.mockReset().mockResolvedValueOnce("council.manage").mockResolvedValueOnce("add")
		.mockResolvedValueOnce("ai").mockResolvedValueOnce("test/model").mockResolvedValueOnce("create");
	mocks.save.mockReset().mockReturnValue(true);
	mocks.load.mockReset().mockImplementation(() => structuredClone(DEFAULT_CONFIG));
	mocks.advisor.mockReset().mockResolvedValue({
		text: JSON.stringify({ name: "reviewer", stance: "neutral", systemPrompt: "Review code for concrete faults." }),
		stopReason: "stop",
	});
	vi.mocked(ctx.ui.input).mockReset().mockResolvedValue("Find correctness bugs");
	vi.mocked(ctx.ui.notify).mockReset();
});

describe("generated persona save feedback", () => {
	it("does not announce creation when the config write fails", async () => {
		mocks.save.mockReturnValue(false);
		mocks.pick.mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config: structuredClone(DEFAULT_CONFIG) });
		expect(mocks.save).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("wasn't kept"), "error");
		expect(vi.mocked(ctx.ui.notify).mock.calls.some(([message]) => String(message).includes("Added + seated reviewer"))).toBe(false);
	});

	it("announces creation after the config write succeeds", async () => {
		mocks.pick.mockResolvedValueOnce("__back__").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { config: structuredClone(DEFAULT_CONFIG) });
		const success = vi.mocked(ctx.ui.notify).mock.calls.findIndex(([message]) => String(message).includes("Added + seated reviewer"));
		expect(success).toBeGreaterThanOrEqual(0);
		expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ctx.ui.notify).mock.invocationCallOrder[success]!);
	});
});
