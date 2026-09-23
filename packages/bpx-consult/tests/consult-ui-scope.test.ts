import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bpxConfigPath, loadConfig, projectConfigPath } from "../src/config.js";

const pick = vi.hoisted(() => vi.fn());
vi.mock("../src/picker.js", () => ({ showFilterablePicker: pick }));
const { runConsultConfigurator } = await import("../src/consult-ui.js");

const previousDir = process.env.PI_CODING_AGENT_DIR;
let root: string | undefined;
afterEach(() => {
	pick.mockReset();
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("/consult global save scope", () => {
	it("does not leak project-only settings into global config or claim to edit them", async () => {
		root = mkdtempSync(join(tmpdir(), "bpx-consult-scope-"));
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(join(root, "agent"), { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(bpxConfigPath(), JSON.stringify({ modes: { solo: { model: "global/model" } } }));
		writeFileSync(projectConfigPath(project), JSON.stringify({ modes: { solo: { model: "project/model" } } }));
		const ctx = { hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
		pick.mockResolvedValueOnce("defaultMode").mockResolvedValueOnce("debate").mockResolvedValueOnce("__done__");
		await runConsultConfigurator(ctx, { cwd: project, projectTrusted: true });
		const globalFile = JSON.parse(readFileSync(bpxConfigPath(), "utf8"));
		expect(globalFile.defaultMode).toBe("debate");
		expect(globalFile.modes.solo.model).toBe("global/model");
		expect(loadConfig({ cwd: project, projectTrusted: true }).modes?.solo?.model).toBe("project/model");
		expect(pick.mock.calls[0]?.[1].proseLines.join(" ")).toMatch(/project's .* may override/i);
	});
});
