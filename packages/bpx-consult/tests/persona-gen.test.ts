/**
 * persona-gen — pure parsing + prompt tests.
 *
 * The network call lives in consult-ui; this covers the failure-prone surface:
 * extracting JSON from a model's messy reply (fences, prose, partial), sanitizing
 * the name into a safe slug, and rejecting bad stances/empty prompts. Every test
 * is a malformed-or-edge input — happy paths don't catch the bugs.
 */

import { describe, expect, it } from "vitest";
import { buildGeneratePrompt, GEN_SYSTEM_PROMPT, parsePersonaJson } from "../src/persona-gen.js";

describe("parsePersonaJson — happy paths", () => {
	it("parses clean JSON", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "security", stance: "against", systemPrompt: "Hunt for vulns." }));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.persona).toEqual({ name: "security", stance: "against", systemPrompt: "Hunt for vulns." });
		}
	});

	it("parses JSON wrapped in ```json fences", () => {
		const raw = "```json\n" + JSON.stringify({ name: "cost", stance: "neutral", systemPrompt: "Weigh ROI." }) + "\n```";
		const r = parsePersonaJson(raw);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.persona.name).toBe("cost");
	});

	it("parses JSON wrapped in bare ``` fences", () => {
		const raw = "Here you go:\n```\n" + JSON.stringify({ name: "api-design", stance: "for", systemPrompt: "Champion clean APIs." }) + "\n```\nHope this helps!";
		const r = parsePersonaJson(raw);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.persona.name).toBe("api-design");
	});

	it("parses JSON with prose before and after (first-{ to last-})", () => {
		const raw = `Sure! Here's the persona:\n{"name":"perf","stance":"against","systemPrompt":"Find hot paths."}\nLet me know.`;
		const r = parsePersonaJson(raw);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.persona.name).toBe("perf");
	});

	it("lowercases the stance", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "x", stance: "AGAINST", systemPrompt: "y" }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.persona.stance).toBe("against");
	});
});

describe("parsePersonaJson — name sanitizing", () => {
	it("converts spaces to hyphens and lowercases", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "API Design", stance: "for", systemPrompt: "x" }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.persona.name).toBe("api-design");
	});

	it("strips characters that aren't a-z0-9-", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "Sec/urity! 2", stance: "against", systemPrompt: "x" }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.persona.name).toBe("security-2");
	});

	it("rejects a name that sanitizes to empty", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "!!!", stance: "neutral", systemPrompt: "x" }));
		expect(r.ok).toBe(false);
	});

	it("rejects a non-string name", () => {
		const r = parsePersonaJson(JSON.stringify({ name: 42, stance: "neutral", systemPrompt: "x" }));
		expect(r.ok).toBe(false);
	});
});

describe("parsePersonaJson — rejections", () => {
	it("rejects an invalid stance (not coerced silently)", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "x", stance: "supportive", systemPrompt: "y" }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/stance/i);
	});

	it("rejects an empty systemPrompt (after trim)", () => {
		const r = parsePersonaJson(JSON.stringify({ name: "x", stance: "neutral", systemPrompt: "   " }));
		expect(r.ok).toBe(false);
	});

	it("rejects when no JSON object is present at all", () => {
		const r = parsePersonaJson("I couldn't generate that right now.");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/no JSON/i);
	});

	it("rejects malformed JSON", () => {
		const r = parsePersonaJson("{ name: 'security', stance: 'against' "); // unquoted, unterminated
		expect(r.ok).toBe(false);
	});

	it("rejects a JSON array (not an object)", () => {
		const r = parsePersonaJson('[1,2,3]');
		expect(r.ok).toBe(false);
	});
});

describe("buildGeneratePrompt", () => {
	it("embeds the user's description verbatim", () => {
		const p = buildGeneratePrompt("security vulnerabilities in auth flows");
		expect(p).toContain("security vulnerabilities in auth flows");
	});

	it("demands strict JSON output and names the three fields", () => {
		const p = buildGeneratePrompt("x");
		expect(p).toMatch(/ONLY a JSON object/i);
		expect(p).toContain('"name"');
		expect(p).toContain('"stance"');
		expect(p).toContain('"systemPrompt"');
	});

	it("states the stance-verdict invariant", () => {
		const p = buildGeneratePrompt("x");
		// The guardrail that stance biases the hunt, never the verdict.
		expect(p).toMatch(/never its verdict|never your verdict/i);
	});
});

describe("GEN_SYSTEM_PROMPT", () => {
	it("demands JSON only", () => {
		expect(GEN_SYSTEM_PROMPT).toMatch(/strict JSON/i);
		expect(GEN_SYSTEM_PROMPT).toMatch(/no markdown/i);
	});
});
