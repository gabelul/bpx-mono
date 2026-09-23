import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, resolveSeatBackend } from "../src/config.js";
import { executeSolo } from "../src/solo.js";
import { gutCheckConfig } from "../src/gut-check.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-bin", "fake-claude");

/** Exercise gut-check's solo-config override with a real fake CLI process. */
describe("gut-check CLI routing", () => {
	it("uses the gut-check model's legacy CLI mapping rather than the solo model", async () => {
		const find = vi.fn((_provider: string, _id: string) => ({ provider: "anthropic", id: "claude-haiku-4-5", contextWindow: 200_000 }));
		const getApiKeyAndHeaders = vi.fn(() => { throw new Error("inline route must not run"); });
		const ctx = {
			cwd: process.cwd(),
			modelRegistry: { find, getApiKeyAndHeaders },
			sessionManager: { getEntries: () => [], getLeafId: () => null, getSessionId: () => "test" },
		} as unknown as ExtensionContext;
		const gutCheck = { model: "anthropic/claude-haiku-4-5", terse: true };
		const config = {
			...DEFAULT_CONFIG,
			modes: { ...DEFAULT_CONFIG.modes, solo: { model: "openai/other" }, gutCheck },
			backends: { "anthropic/claude-haiku-4-5": { type: "cli" as const, command: "bash", args: [fixture], contextWindow: 200_000 } },
		};
		const result = await executeSolo({ ctx, config: gutCheckConfig(config), signal: undefined, onUpdate: undefined });
		expect(result.content[0]).toMatchObject({ type: "text", text: "A plain prose reply from the claude CLI." });
		expect(find).not.toHaveBeenCalled();
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("does not borrow Solo's legacy Codex override", () => {
		const config = {
			...DEFAULT_CONFIG,
			modes: {
				...DEFAULT_CONFIG.modes,
				solo: { model: "pi/solo", backend: { type: "cli" as const, command: "codex" }, codexModel: "gpt-solo" },
				gutCheck: { backend: { type: "cli" as const, command: "codex" } },
			},
		};
		const effective = gutCheckConfig(config);
		const backend = resolveSeatBackend(effective, effective.modes!.solo!);
		expect(backend).toMatchObject({ type: "cli", command: "codex" });
		expect(backend?.model).toBeUndefined();
	});

	it("keeps gut-check backend separate when it has no model override", () => {
		const config = {
			...DEFAULT_CONFIG,
			modes: {
				...DEFAULT_CONFIG.modes,
				solo: { model: "anthropic/solo", backend: { type: "cli" as const, command: "codex" }, cliModels: { codex: "solo-model" } },
				gutCheck: { backend: { type: "cli" as const, command: "claude" }, cliModels: { claude: "haiku" } },
			},
		};
		expect(gutCheckConfig(config).modes?.solo).toMatchObject({ model: "anthropic/solo", backend: { command: "claude" }, cliModels: { claude: "haiku" } });
	});
});
