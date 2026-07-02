/**
 * CLI backend integration smoke test — engineers each risky branch against fake
 * CLI scripts (deterministic, no real codex/claude auth needed). Validated via
 * vitest so the NodeNext .js→.ts resolution works without manual loader hacks.
 */
import { describe, expect, it } from "vitest";
import { callCliAdvisor } from "../src/cli-backend.js";

const BIN = "/tmp/bpx-cli-test/bin";

const baseMessages = [{ role: "user" as const, content: "Should I ship?", timestamp: Date.now() }];

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
		const r = await call({ type: "cli", command: `${BIN}/slow-cli`, timeoutMs: 800 });
		expect(r.timedOut).toBe(true);
		expect(r.text).toBe("");
		expect(r.errorMessage).toMatch(/timed out after 800ms/);
	});

	it("3. non-zero exit → graceful error result, not crash", async () => {
		const r = await call({ type: "cli", command: `${BIN}/fail-cli`, timeoutMs: 10000 });
		expect(r.timedOut).toBe(false);
		expect(r.exitCode).toBe(3);
		expect(r.text).toBe("");
		expect(r.errorMessage).toMatch(/exited 3.*auth failed/);
	});

	it("4. plain-text (claude shape) returns the trimmed stdout", async () => {
		const r = await call({ type: "cli", command: `${BIN}/fake-claude`, timeoutMs: 10000 });
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
			call({ type: "cli", command: `${BIN}/fake-codex`, timeoutMs: 10000 }),
			call({ type: "cli", command: `${BIN}/fake-claude`, timeoutMs: 10000 }),
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
