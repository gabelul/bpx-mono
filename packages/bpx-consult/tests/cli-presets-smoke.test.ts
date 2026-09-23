import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { callCliAdvisor } from "../src/cli-backend.js";

/** Run preset argv and environment against temporary fake executables. */
describe("CLI preset subprocess contract", () => {
	it("uses OpenCode run/JSON/stdin with a subprocess-only no-tool agent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-opencode-preset-"));
		const originalPath = process.env.PATH;
		try {
			const binary = join(dir, "opencode");
			writeFileSync(binary, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const answer = JSON.stringify({ args: process.argv.slice(2), prompt: input,
    permission: cfg.agent["bpx-consult"].permission, globalPermission: JSON.parse(process.env.OPENCODE_PERMISSION) });
  process.stdout.write(JSON.stringify({ type: "text", part: { text: answer, time: { end: 1 } } }) + "\\n");
});
`);
			chmodSync(binary, 0o755);
			process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
			const result = await callCliAdvisor({ systemPrompt: "Read only", messages: [{ role: "user", content: "OK", timestamp: 0 }],
				backend: { type: "cli", command: "opencode", model: "anthropic/haiku" }, signal: undefined });
			const payload = JSON.parse(result.text);
			expect(payload.args).toEqual(["run", "--format", "json", "--pure", "--agent", "bpx-consult", "--model", "anthropic/haiku"]);
			expect(payload.prompt).toContain("Read only");
			expect(payload.permission).toMatchObject({ "*": "deny", bash: "deny", edit: "deny", task: "deny" });
			expect(payload.globalPermission).toMatchObject({ "*": "deny", bash: "deny" });
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps legacy JSONL output for custom OpenCode argv", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-opencode-custom-"));
		const originalPath = process.env.PATH;
		try {
			const binary = join(dir, "opencode");
			writeFileSync(binary, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'legacy answer' } }) + '\\n'));\n`);
			chmodSync(binary, 0o755);
			process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
			const result = await callCliAdvisor({ systemPrompt: "Advisor", messages: [],
				backend: { type: "cli", command: "opencode", args: ["custom"] }, signal: undefined });
			expect(result.text).toBe("legacy answer");
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses malformed existing OpenCode config instead of discarding it", async () => {
		const original = process.env.OPENCODE_CONFIG_CONTENT;
		try {
			process.env.OPENCODE_CONFIG_CONTENT = "{invalid";
			const result = await callCliAdvisor({ systemPrompt: "Advisor", messages: [],
				backend: { type: "cli", command: "opencode" }, signal: undefined });
			expect(result.errorMessage).toMatch(/OPENCODE_CONFIG_CONTENT is invalid JSON/);
		} finally {
			if (original === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
			else process.env.OPENCODE_CONFIG_CONTENT = original;
		}
	});

	it("passes Claude model and disables CLI tools", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-claude-preset-"));
		const originalPath = process.env.PATH;
		try {
			const binary = join(dir, "claude");
			writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(2))));\n');
			chmodSync(binary, 0o755);
			process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
			const result = await callCliAdvisor({ systemPrompt: "Advisor", messages: [],
				backend: { type: "cli", command: "claude", model: "sonnet" }, signal: undefined });
			expect(JSON.parse(result.text)).toEqual(["-p", "--tools", "", "--model", "sonnet"]);
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
