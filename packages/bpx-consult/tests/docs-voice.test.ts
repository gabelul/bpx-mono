/**
 * docs-voice — CI guard against AI-slop voice in signed prose.
 *
 * The persona (Gabi) and the slopbuster skill both ban a list of AI tell-words
 * and phrases. Assuming the persona at write-time is a memory step; this test
 * makes the EVIDENCE of skipping it mechanical — a banned word in a README or
 * SPEC fails CI, the same way a stale phrase does in docs-stale.test.ts.
 *
 * HONEST LIMIT — this is a floor, not a ceiling. A grep catches word-level tells
 * (delve, leverage, robust…). It cannot catch structural slop: the
 * hook→points→summary template, question headers, em-dash soup, paragraph rhythm,
 * or "this is generic with no banned word." The deeper voice audit stays a
 * write-time discipline (run slopbuster on anything signed). This test just makes
 * sure the obvious tells never reach the repo.
 *
 * LIVING LIST — synced to Gabi's persona banned-words + slopbuster's rules. Add
 * tells as they recur; if a word legitimately needs to appear, allowlist it with
 * a comment explaining why.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCS = [
	{ name: "package README", path: join(ROOT, "packages/bpx-consult/README.md") },
	{ name: "package SPEC", path: join(ROOT, "packages/bpx-consult/SPEC.md") },
	{ name: "root README", path: join(ROOT, "README.md") },
];

// High-signal, low-false-positive AI-slop tells. Sourced from Gabi's persona
// (my_persona_v3.md Anti-AI-Slop Rules) + the slopbuster skill's rules/.
// Kept to words/phrases that are near-certain slop in a technical pi-extension
// README — anything with a plausible legitimate use is left out to avoid
// false-positive CI failures.
const SLOP_TELLS = [
	"delve",
	"leverage",
	"leveraging",
	"landscape",
	"robust",
	"seamless",
	"seamlessly",
	"cutting-edge",
	"innovative",
	"innovation",
	"game-changer",
	"paradigm shift",
	"revolutionary",
	"tapestry",
	"symphony",
	"unpack",
	"unravel",
	"dive into",
	"deep dive",
	"let's dive",
	"let's unpack",
	"let's explore",
	"it's important to note",
	"it's worth noting",
	"in today's",
	"at the end of the day",
	"in conclusion",
	"to summarize",
	"in summary",
	"i'd be happy to help",
	"here's the thing",
];

describe("docs are in Gabi's voice (no AI-slop tells)", () => {
	for (const { name, path } of DOCS) {
		it(`${name} contains no banned slop words/phrases`, () => {
			const text = readFileSync(path, "utf8").toLowerCase();
			const hits = SLOP_TELLS.filter((p) => text.includes(p));
			expect(hits, `${name} contains AI-slop tell(s): ${hits.join(", ")}. Rewrite in Gabi's voice (see my_persona_v3.md + the slopbuster skill), or — if a word legitimately must appear — allowlist it in tests/docs-voice.test.ts with a note.`).toEqual([]);
		});
	}
});
