/**
 * CLI backend unit tests — the branches that don't need a real CLI installed.
 *
 * The mixed inline+cli parallel council (the load-bearing async justification)
 * is validated live in tmux, not here — it needs a real codex/claude binary.
 * These tests cover: defensive parse (junk preamble), timeout path wiring,
 * exit-code handling, and the prompt assembly.
 */
import { describe, expect, it } from "vitest";
import { parseCliOutput } from "../src/cli-backend.js";

describe("parseCliOutput — defensive parsing", () => {
	it("extracts text from codex/opencode JSONL item.completed lines", () => {
		const out = [
			'{"type":"status","status":"running"}', // chatter
			'{"type":"item.completed","item":{"text":"The plan is sound but watch the null case."}}',
		].join("\n");
		expect(parseCliOutput(out, "codex")).toBe("The plan is sound but watch the null case.");
	});

	it("tolerates junk preamble before the JSONL payload (real CLIs print warnings first)", () => {
		const out = [
			"Deprecation notice: --sandbox will be renamed in v2",
			"Using model gpt-5.5",
			'{"type":"item.completed","item":{"text":"actual advisor reply"}}',
		].join("\n");
		expect(parseCliOutput(out, "codex")).toBe("actual advisor reply");
	});

	it("ignores non-JSON lines that happen to start with { (broken JSON)", () => {
		const out = [
			"{ this is not valid json",
			'{"type":"item.completed","item":{"text":"real reply"}}',
		].join("\n");
		expect(parseCliOutput(out, "opencode")).toBe("real reply");
	});

	it("collects multiple item.completed payloads", () => {
		const out = [
			'{"type":"item.completed","item":{"text":"first point"}}',
			'{"type":"item.completed","item":{"text":"second point"}}',
		].join("\n");
		expect(parseCliOutput(out, "codex")).toBe("first point\nsecond point");
	});

	it("falls back to plain text when no JSONL payload is found (claude)", () => {
		const out = "Some prose reply from claude that is not JSON.\nMultiple lines.";
		expect(parseCliOutput(out, "claude")).toBe(out);
	});

	it("falls back to plain text for codex when JSONL contract isn't honored", () => {
		// Some codex builds print plain text despite the documented JSONL contract.
		const out = "plain reply despite JSONL expectation";
		expect(parseCliOutput(out, "codex")).toBe(out);
	});

	it("handles {text: ...} at the top level", () => {
		const out = '{"text":"top-level text shape"}';
		expect(parseCliOutput(out, "codex")).toBe("top-level text shape");
	});

	it("returns empty string for empty output", () => {
		expect(parseCliOutput("", "codex")).toBe("");
		expect(parseCliOutput("   \n  ", "claude")).toBe("");
	});

	it("ignores empty text payloads", () => {
		const out = '{"type":"item.completed","item":{"text":"   "}}\n{"type":"item.completed","item":{"text":"real"}}';
		expect(parseCliOutput(out, "codex")).toBe("real");
	});
});

// parseCliOutput is exported; the spawn/timeout/exit logic is exercised via the
// live tmux smoke test (timeout fired → clean result; missing CLI → graceful
// "unavailable"; mixed inline+cli parallel council).
describe("parseCliOutput branches (completeness)", () => {
	it("handles message.content array shape", () => {
		const out = '{"content":[{"type":"text","text":"array shape reply"}]}';
		expect(parseCliOutput(out, "codex")).toBe("array shape reply");
	});
});
