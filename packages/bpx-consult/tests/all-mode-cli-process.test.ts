import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type BpxConsultConfig } from "../src/config.js";
import { gutCheckConfig } from "../src/gut-check.js";
import { executeSolo } from "../src/solo.js";
import { executeCouncil } from "../src/council.js";
import { executeDebate } from "../src/debate.js";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("real CLI subprocess dispatch through every mode", () => {
	it("uses independent CLI-only routes for Solo, gut-check, Council, and Debate", async () => {
		dir = mkdtempSync(join(tmpdir(), "bpx-consult-modes-"));
		const executable = join(dir, "reply");
		const log = join(dir, "calls.txt");
		writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.argv[3], process.argv[2] + "|" + input.slice(0, 40).replace(/\\n/g, " ") + "\\n");
  process.stdout.write(process.argv[2]);
});
`);
		chmodSync(executable, 0o755);
		const backend = (seat: string) => ({ type: "cli" as const, command: executable, args: [seat, log], contextWindow: 20000 });
		const config: BpxConsultConfig = structuredClone(DEFAULT_CONFIG);
		config.modes!.solo = { model: "external/solo", backend: backend("solo") };
		config.modes!.gutCheck = { model: "external/gut", backend: backend("gut"), terse: true };
		config.modes!.council = {
			members: ["architect", "critic"], parallel: false,
			synthesizer: { model: "external/synth", backend: backend("synth") },
		};
		config.modes!.debate = { advocate: "architect", critic: "critic", rounds: 1 };
		config.personas = {
			architect: { defaultModel: "external/architect", backend: backend("architect") },
			critic: { defaultModel: "external/critic", backend: backend("critic") },
		};
		const find = vi.fn(() => undefined);
		const ctx = {
			cwd: dir,
			modelRegistry: { find },
			sessionManager: { getEntries: () => [], getLeafId: () => null, getSessionId: () => "all-cli-process" },
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;

		const solo = await executeSolo({ ctx, config, signal: undefined, onUpdate: undefined });
		const gut = await executeSolo({ ctx, config: gutCheckConfig(config), signal: undefined, onUpdate: undefined });
		const council = await executeCouncil({ ctx, config, signal: undefined, onUpdate: undefined });
		const debate = await executeDebate({ ctx, config, signal: undefined, onUpdate: undefined });
		expect(solo.content[0]).toMatchObject({ type: "text", text: "solo" });
		expect(gut.content[0]).toMatchObject({ type: "text", text: "gut" });
		expect(council.details?.members.map((member) => member.status)).toEqual(["ok", "ok"]);
		expect(debate.details?.steps.filter((step) => step.status === "ok")).toHaveLength(2);
		expect(debate.details?.errorMessage).toBeUndefined();
		expect(readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("|")[0])).toEqual([
			"solo", "gut", "architect", "critic", "synth", "architect", "critic", "synth",
		]);
		expect(find).not.toHaveBeenCalled();
	});
});
