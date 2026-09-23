import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCliModels } from "../src/cli-models.js";

const dirs: string[] = [];

/** Create an executable in a temporary directory, never touching installed CLIs. */
function executable(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "bpx-cli-models-"));
	dirs.push(dir);
	const path = join(dir, "fake-opencode");
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CLI model discovery", () => {
	it("lists and deduplicates actual OpenCode provider/model IDs", async () => {
		const path = executable(`
if (process.argv[2] !== "models" || process.argv[3] !== "--verbose") process.exit(3);
process.stdout.write("opencode/big-pickle\\n" + JSON.stringify({ limit: { context: 128000, input: 64000 } }, null, 2) + "\\n" +
  "anthropic/claude-sonnet-4-6\\n" + JSON.stringify({ limit: { context: 200000 } }, null, 2) + "\\n" +
  "opencode/big-pickle\\n" + JSON.stringify({ limit: { context: 128000, input: 64000 } }, null, 2) + "\\n");`);
		expect(await listCliModels("opencode", undefined, undefined, path)).toEqual([
			{ id: "opencode/big-pickle", displayName: "opencode/big-pickle", contextWindow: 64000 },
			{ id: "anthropic/claude-sonnet-4-6", displayName: "anthropic/claude-sonnet-4-6", contextWindow: 200000 },
		]);
	});

	it("does not invent Claude model availability", async () => {
		expect(await listCliModels("claude")).toEqual([]);
	});

	it("surfaces a missing OpenCode executable", async () => {
		await expect(listCliModels("opencode", undefined, undefined, join(tmpdir(), "no-such-opencode-bpx"))).rejects.toThrow(/ENOENT/);
	});

	it("aborts discovery and waits for subprocess cleanup", async () => {
		const path = executable(`process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000);`);
		const controller = new AbortController();
		const pending = listCliModels("opencode", undefined, controller.signal, path);
		setTimeout(() => controller.abort(), 80);
		await expect(pending).rejects.toThrow();
	});
});
