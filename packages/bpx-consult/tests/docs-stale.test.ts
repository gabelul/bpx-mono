/**
 * docs-stale — CI guard against doc drift.
 *
 * The recurring failure mode isn't forgetting to update docs; it's updating the
 * feature bullet and missing a sibling section that repeats the OLD claim. This
 * test fails CI if any README or SPEC still contains a known-stale phrase, so a
 * doc lapse can't ship — it has to be fixed before the PR merges.
 *
 * This is a LIVING LIST, not a fixed one. When a capability changes (something
 * becomes menu-reachable, a fallback is removed, a v1 framing is superseded),
 * add the old phrasing here. If you're intentionally removing a phrase from the
 * stale list because it's legitimately back in use, say why in the commit.
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

// Phrases that meant something once and now signal drift. Each was a real
// shipped contradiction at some point — that's why it's here.
const STALE_PHRASES = [
	"config-file-only", // custom CLI / backends became menu-reachable
	"JSON-only", // same — used to say custom commands stay JSON-only
	"solo only", // CLI backend extended to council; "solo only" is now wrong
	"v1 wires", // legacy v1-vs-v1.1 framing, superseded by milestone labels
	"32k fallback", // the unverified CLI window fallback was removed
	"Minimal v1", // the old /consult "Minimal v1: status read-out" comment
	"whats-not-in-v1", // dead anchor (section renamed to Roadmap)
	"out of scope for v1", // legacy scoping note
];

describe("docs are not stale", () => {
	for (const { name, path } of DOCS) {
		it(`${name} contains no known-stale phrases`, () => {
			const text = readFileSync(path, "utf8");
			const hits = STALE_PHRASES.filter((p) => text.includes(p));
			expect(hits, `${name} still contains stale phrase(s): ${hits.join(", ")}. Update the doc, or — if the phrase is legitimately back in use — remove it from tests/docs-stale.test.ts with a note.`).toEqual([]);
		});
	}
});
