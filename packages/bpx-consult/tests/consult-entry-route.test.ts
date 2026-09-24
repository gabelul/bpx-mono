import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

const mocked = vi.hoisted(() => ({ solo: vi.fn(), load: vi.fn() }));
vi.mock("../src/solo.js", () => ({ executeSolo: mocked.solo }));
vi.mock("../src/config.js", async (original) => ({
	...await original<typeof import("../src/config.js")>(), loadConfig: mocked.load,
}));
vi.mock("../src/triggers.js", () => ({ registerTriggers: vi.fn() }));
vi.mock("../src/deliver.js", () => ({ registerConsultRenderer: vi.fn() }));

const { default: extension } = await import("../index.js");

describe("consult tool entry routing", () => {
	it("passes gut-check's own backend/model to Solo dispatcher", async () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.modes!.solo = { model: "pi/solo", backend: { type: "cli", command: "codex" }, cliModels: { codex: "gpt-solo" } };
		config.modes!.gutCheck = { model: "pi/gut", backend: { type: "cli", command: "claude" }, cliModels: { claude: "haiku" } };
		mocked.load.mockReturnValue(config);
		mocked.solo.mockResolvedValue({ content: [{ type: "text", text: "OK" }], details: { mode: "solo" } });
		let handler: ((...args: unknown[]) => Promise<unknown>) | undefined;
		const pi = {
			on: vi.fn(), registerCommand: vi.fn(), registerEntryRenderer: vi.fn(),
			registerTool: vi.fn((tool: { execute: (...args: unknown[]) => Promise<unknown> }) => { handler = tool.execute; }),
		} as unknown as ExtensionAPI;
		extension(pi);
		const ctx = { cwd: "/tmp", isProjectTrusted: () => true } as unknown as ExtensionContext;
		await handler!("call-1", { mode: "gut-check" }, undefined, undefined, ctx);
		const dispatched = mocked.solo.mock.calls[0]?.[0].config.modes.solo;
		expect(dispatched).toMatchObject({ model: "pi/gut", backend: { command: "claude" }, cliModels: { claude: "haiku" } });
		expect(dispatched.cliModels.codex).toBeUndefined();
	});
});
