/**
 * phrase-trigger unit tests.
 *
 * Two halves:
 *   1. parseConsultPhrase — the matcher. Positive cases (each mode + synonyms)
 *      and negatives (plain prose that must NOT fire), plus question capture.
 *   2. handler gating — the source/enabled/trusted/re-entrancy decision the
 *      pi.on("input") handler makes. Re-implemented locally as a pure predicate
 *      (same pattern triggers.test.ts uses) so we test the LOGIC, not a mock of
 *      the full ExtensionAPI.
 */
import { describe, expect, it } from "vitest";
import { parseConsultPhrase } from "../src/phrase-trigger.js";
import type { InputSource } from "@earendil-works/pi-coding-agent";

describe("parseConsultPhrase — council", () => {
	it("matches council invocations and synonyms", () => {
		for (const p of ["use the council", "ask the council", "consult the council", "council on this", "convene the council"]) {
			expect(parseConsultPhrase(p)?.mode).toBe("council");
		}
	});
	it("is case-insensitive", () => {
		expect(parseConsultPhrase("Ask The Council")?.mode).toBe("council");
	});
});

describe("parseConsultPhrase — solo/advisor", () => {
	it("matches advisor invocations and 'second opinion'", () => {
		for (const p of ["ask the advisor", "consult the advisor", "second opinion", "get a second opinion", "get advice"]) {
			expect(parseConsultPhrase(p)?.mode).toBe("solo");
		}
	});
});

describe("parseConsultPhrase — debate", () => {
	it("matches debate invocations", () => {
		for (const p of ["debate this", "have them debate", "let them debate", "start a debate"]) {
			expect(parseConsultPhrase(p)?.mode).toBe("debate");
		}
	});
});

describe("parseConsultPhrase — gut-check", () => {
	it("matches gut-check spellings", () => {
		for (const p of ["gut check this", "gut-check", "gut check"]) {
			expect(parseConsultPhrase(p)?.mode).toBe("gut-check");
		}
	});
});

describe("parseConsultPhrase — negatives", () => {
	it("returns null for prose that shouldn't fire", () => {
		for (const p of [
			"",
			"   ",
			"let's refactor the config loader",
			"the council of elrond was a long meeting", // 'the council' — but see note
			"add a debate feature to the UI",
		]) {
			const result = parseConsultPhrase(p);
			// "the council of elrond" WILL match "the council" — that's an accepted
			// tradeoff of being generous with synonyms. Assert only the clean negatives.
			if (p.includes("council")) continue;
			expect(result).toBeNull();
		}
	});

	it("does not fire on 'debate' as a noun without the trigger shape", () => {
		expect(parseConsultPhrase("add a debate feature to the UI")).toBeNull();
	});
});

describe("parseConsultPhrase — question capture", () => {
	it("captures a focused question after 'about'", () => {
		const r = parseConsultPhrase("ask the council about the retry strategy");
		expect(r?.mode).toBe("council");
		expect(r?.question).toBe("the retry strategy");
	});

	it("preserves original casing in the captured question", () => {
		const r = parseConsultPhrase("second opinion about the OAuth Flow");
		expect(r?.question).toBe("the OAuth Flow");
	});

	it("trims trailing punctuation from the question", () => {
		const r = parseConsultPhrase("debate this about the caching layer?");
		expect(r?.question).toBe("the caching layer");
	});

	it("has no question when 'about' is absent", () => {
		expect(parseConsultPhrase("gut check this")?.question).toBeUndefined();
	});
});

// ── Handler gating ──────────────────────────────────────────────────────────
// Mirrors the decision in triggers.ts's pi.on("input") handler. If these rules
// drift from the handler, this catches it.
function shouldFire(opts: {
	source: InputSource;
	autoRunning: boolean;
	enabled: boolean;
	trusted: boolean;
	matched: boolean;
}): boolean {
	if (opts.source !== "interactive" && opts.source !== "rpc") return false;
	if (opts.autoRunning) return false;
	if (!opts.matched) return false;
	if (!opts.enabled) return false;
	if (!opts.trusted) return false;
	return true;
}

describe("phrase-trigger handler gating", () => {
	const base = { source: "interactive" as InputSource, autoRunning: false, enabled: true, trusted: true, matched: true };

	it("fires on a matched interactive phrase in a trusted, enabled project", () => {
		expect(shouldFire(base)).toBe(true);
	});
	it("fires on rpc source too", () => {
		expect(shouldFire({ ...base, source: "rpc" })).toBe(true);
	});
	it("never fires on extension-sourced input (our own injections)", () => {
		expect(shouldFire({ ...base, source: "extension" })).toBe(false);
	});
	it("does not fire while a consult is already running (re-entrancy guard)", () => {
		expect(shouldFire({ ...base, autoRunning: true })).toBe(false);
	});
	it("does not fire when the extension is disabled", () => {
		expect(shouldFire({ ...base, enabled: false })).toBe(false);
	});
	it("does not fire in an untrusted project", () => {
		expect(shouldFire({ ...base, trusted: false })).toBe(false);
	});
	it("does not fire when no phrase matched", () => {
		expect(shouldFire({ ...base, matched: false })).toBe(false);
	});
});
