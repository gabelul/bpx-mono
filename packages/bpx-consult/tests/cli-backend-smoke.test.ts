/**
 * CLI backend integration smoke test — engineers each risky branch against fake
 * CLI scripts (deterministic, no real codex/claude auth needed). Validated via
 * vitest so the NodeNext .js→.ts resolution works without manual loader hacks.
 */
import { describe, expect, it, vi } from "vitest";
import { callCliAdvisor } from "../src/cli-backend.js";

import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-bin");

const baseMessages = [{ role: "user" as const, content: "Should I ship?", timestamp: Date.now() }];

/** Invoke a fixture via bash so the test doesn't depend on the executable bit
 * surviving git/macOS round-trips. spawn() needs +x to run a script directly;
 * `bash <script>` works regardless of mode. (CI failed pre-fix because the
 * fixtures shipped as 100644, not 100755.) */
function callFixture(fixture: string, timeoutMs = 10000) {
	return callCliAdvisor({
		systemPrompt: "advisor",
		messages: baseMessages as never,
		backend: { type: "cli", command: "bash", args: [join(BIN, fixture)], timeoutMs },
		signal: undefined,
	});
}

// Kept for the missing-CLI test (no fixture, raw bogus command).
async function call(backend: { type: "cli"; command: string; args?: string[]; timeoutMs?: number }) {
	return callCliAdvisor({ systemPrompt: "advisor", messages: baseMessages as never, backend, signal: undefined });
}

describe("CLI backend — engineered branches", () => {
	it("1b. parseCliOutput extracts text from junk+JSONL (codex command)", async () => {
		// Direct parser test — exercises the junk-preamble tolerance.
		const { parseCliOutput } = await import("../src/cli-backend.js");
		const fakeStdout = [
			"Deprecation: --sandbox renamed in v2",
			"Using model gpt-5.5",
			'{"type":"item.completed","item":{"text":"From the CLI advisor: ship it."}}',
		].join("\n");
		expect(parseCliOutput(fakeStdout, "codex")).toBe("From the CLI advisor: ship it.");
	});

	it("2. timeout fires → clean result, no hang", async () => {
		const r = await callFixture("slow-cli", 800);
		expect(r.timedOut).toBe(true);
		expect(r.text).toBe("");
		expect(r.errorMessage).toMatch(/timed out after 800ms/);
	});

	it("waits for a SIGTERM-ignoring child to die before reporting timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cli-kill-"));
		const binary = join(dir, "ignore-term");
		const pidFile = join(dir, "pid");
		try {
			writeFileSync(binary, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv[2], String(process.pid));\nprocess.on('SIGTERM', () => {});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
			chmodSync(binary, 0o755);
			const result = await callCliAdvisor({ systemPrompt: "advisor", messages: baseMessages as never,
				backend: { type: "cli", command: binary, args: [pidFile], timeoutMs: 250 }, signal: undefined });
			expect(result.timedOut).toBe(true);
			expect(existsSync(pidFile)).toBe(true);
			expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(["inherit", "ignore"])("kills a descendant after its parent exits 0 on TERM (%s stdio)", async (stdio) => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cli-tree-"));
		const binary = join(dir, "parent");
		const pidFile = join(dir, "pids");
		try {
			writeFileSync(binary, `#!/usr/bin/env node\nconst fs = require('fs');\nconst child = require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: process.argv[3] });\nfs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));\nprocess.on('SIGTERM', () => process.exit(0));\nprocess.stdin.resume();\n`);
			chmodSync(binary, 0o755);
			const result = await callCliAdvisor({ systemPrompt: "advisor", messages: baseMessages as never,
				backend: { type: "cli", command: binary, args: [pidFile, stdio], timeoutMs: 300 }, signal: undefined });
			expect(result.timedOut).toBe(true);
			const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };
			for (const pid of Object.values(pids)) {
				await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_000, interval: 25 });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 10_000);

	it("rejects serialized prompts that exceed a tiny CLI window before spawning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cli-window-"));
		const binary = join(dir, "reply");
		const marker = join(dir, "spawned");
		try {
			writeFileSync(binary, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv[2], 'yes');\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('OK'));\n`);
			chmodSync(binary, 0o755);
			const backend = { type: "cli" as const, command: binary, args: [marker], contextWindow: 512 };
			const longSystem = await callCliAdvisor({ systemPrompt: "x".repeat(4000), messages: [], backend, signal: undefined });
			expect(longSystem.errorMessage).toMatch(/context window/i);
			expect(existsSync(marker)).toBe(false);
			const manyRoles = await callCliAdvisor({ systemPrompt: "Answer OK", messages: Array.from({ length: 100 }, () => ({ role: "user" as const, content: "x", timestamp: 0 })), backend, signal: undefined });
			expect(manyRoles.errorMessage).toMatch(/context window/i);
			expect(existsSync(marker)).toBe(false);
			const small = await callCliAdvisor({ systemPrompt: "Answer OK", messages: [], backend, signal: undefined });
			expect(small.text).toBe("OK");
			expect(existsSync(marker)).toBe(true);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("preserves a multibyte reply split across stdout chunks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cli-utf8-"));
		const binary = join(dir, "split-utf8");
		try {
			writeFileSync(binary, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => {\nprocess.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));\nsetTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50);\n});\n`);
			chmodSync(binary, 0o755);
			const result = await callCliAdvisor({ systemPrompt: "advisor", messages: baseMessages as never,
				backend: { type: "cli", command: binary, args: ["custom"] }, signal: undefined });
			expect(result.text).toBe("café");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("3. non-zero exit → graceful error result, not crash", async () => {
		const r = await callFixture("fail-cli");
		expect(r.timedOut).toBe(false);
		expect(r.exitCode).toBe(3);
		expect(r.text).toBe("");
		expect(r.errorMessage).toMatch(/exited 3.*auth failed/);
	});

	it("4. plain-text (claude shape) returns the trimmed stdout", async () => {
		const r = await callFixture("fake-claude");
		expect(r.exitCode).toBe(0);
		expect(r.text).toBe("A plain prose reply from the claude CLI.");
	});

	it("5. missing CLI (ENOENT) → graceful 'failed to run', not crash", async () => {
		const r = await call({ type: "cli", command: "nonexistent-cli-xyz-12345", timeoutMs: 10000 });
		expect(r.timedOut).toBe(false);
		expect(r.text).toBe("");
		expect(r.errorMessage).toMatch(/failed to run/);
	});
});

describe("CLI backend — mixed inline+cli parallelism (the async bet)", () => {
	it("runs a CLI call and an inline-style resolve in parallel without serializing", async () => {
		// We can't call inline completeSimple here (needs pi runtime), but we CAN
		// prove the parallelism mechanism: two CLI calls with overlapping durations
		// must complete in ~max(d1,d2), NOT sum. If execSync had been used, this
		// would take ~sum. This is the same async property a mixed council relies on.
		const slowStart = Date.now();
		const [a, b] = await Promise.all([
			callFixture("fake-codex"),
			callFixture("fake-claude"),
		]);
		const elapsed = Date.now() - slowStart;
		expect(a.text).toBeTruthy();
		expect(b.text).toBeTruthy();
		// Two near-instant CLIs in parallel should be well under 5s. If they'd
		// serialized via execSync we'd still be fast here, so this is a smoke check,
		// not a hard proof — the real proof is that spawn is non-blocking by
		// construction (unlike execSync). Kept as a regression net.
		expect(elapsed).toBeLessThan(5000);
	});
});
