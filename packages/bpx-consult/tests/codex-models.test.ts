import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listCodexModels } from "../src/codex-models.js";

const dir = mkdtempSync(join(tmpdir(), "bpx-codex-models-"));
let serial = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Create an isolated executable that speaks enough of Codex's JSONL protocol. */
function fakeCodex(handler: string): string {
	const file = join(dir, `codex-${++serial}`);
	writeFileSync(file, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") process.exit(3);
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
const fail = (id, message) => process.stdout.write(JSON.stringify({ id, error: { message } }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return reply(msg.id, { userAgent: "fake" });
  ${handler}
});
`);
	chmodSync(file, 0o755);
	return file;
}

describe("Codex app-server model discovery", () => {
	it("initializes, follows cursor, skips hidden models, and returns CLI model IDs", async () => {
		const executable = fakeCodex(`
  if (msg.method === "initialized") { global.ready = true; return; }
  if (msg.method !== "model/list" || !global.ready) return fail(msg.id, "not initialized");
  if (!msg.params.cursor) return reply(msg.id, { data: [{ model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false }], nextCursor: "page-2" });
  if (msg.params.cursor === "page-2") return reply(msg.id, { data: [{ model: "internal", displayName: "Internal", hidden: true }, { model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false }], nextCursor: null });
  return fail(msg.id, "unexpected cursor");`);
		expect(await listCodexModels(dir, undefined, executable)).toEqual([
			{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
			{ id: "gpt-6-astra", displayName: "GPT-6-Astra" },
		]);
	});

	it("reports a missing Codex executable cleanly", async () => {
		await expect(listCodexModels(dir, undefined, join(dir, "missing-codex"))).rejects.toThrow(/ENOENT/);
	});

	it("reports server errors without falling back to pi models", async () => {
		const executable = fakeCodex(`if (msg.method === "model/list") return fail(msg.id, "auth unavailable");`);
		await expect(listCodexModels(dir, undefined, executable)).rejects.toThrow(/auth unavailable/);
	});

	it("rejects malformed JSON and closes its own process", async () => {
		const executable = fakeCodex(`if (msg.method === "model/list") process.stdout.write("not-json\\n");`);
		await expect(listCodexModels(dir, undefined, executable)).rejects.toThrow(/invalid JSON/);
	});

	it("rejects JSON null and invalid response shapes without crashing the process", async () => {
		const nullResponse = fakeCodex(`if (msg.method === "model/list") process.stdout.write("null\\n");`);
		await expect(listCodexModels(dir, undefined, nullResponse)).rejects.toThrow(/invalid response/);
		const invalidData = fakeCodex(`if (msg.method === "model/list") return reply(msg.id, { data: {}, nextCursor: null });`);
		await expect(listCodexModels(dir, undefined, invalidData)).rejects.toThrow(/invalid model list/);
	});

	it("decodes a multibyte display name split across stdout chunks", async () => {
		const executable = fakeCodex(`
  if (msg.method === "model/list") {
    const bytes = Buffer.from(JSON.stringify({ id: msg.id, result: { data: [{ model: "cafe", displayName: "Café" }], nextCursor: null } }) + "\\n");
    const split = bytes.indexOf(Buffer.from("é")[0]) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
  }`);
		expect(await listCodexModels(dir, undefined, executable)).toEqual([{ id: "cafe", displayName: "Café" }]);
	});

	it("aborts a stalled server and cleans up only its spawned process", async () => {
		const pidFile = join(dir, "stalled.pid");
		const executable = fakeCodex(`if (msg.method === "model/list") require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 250);
		try {
			await expect(listCodexModels(dir, controller.signal, executable)).rejects.toThrow();
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
		} finally { clearTimeout(timer); }
	});
});
