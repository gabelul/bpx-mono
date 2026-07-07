/**
 * phrase-trigger — natural-language invocation of consult.
 *
 * Lets a user fire a consult by typing a phrase instead of calling the tool or
 * running /consult: "ask the council", "second opinion", "debate this",
 * "gut check this". Ported in spirit from pi-caveman's modeFromNaturalLanguage
 * regex matcher.
 *
 * parseConsultPhrase is pure and side-effect-free so it's cheap to unit-test.
 * The registrar (registerPhraseTrigger, in triggers.ts's neighbourhood) is what
 * wires it to pi.on("input") and applies the gating (enabled, trusted,
 * interactive source, re-entrancy).
 *
 * Matching is case-insensitive and word-boundaried. Order matters: more specific
 * modes (debate, gut-check) are checked before the broad council/solo verbs so
 * "have them debate" doesn't get swallowed by a generic "consult" match.
 */

import type { ConsultMode } from "./config.js";

/** What a matched phrase resolves to: the mode plus an optional focused question. */
export interface ParsedConsultPhrase {
	mode: ConsultMode;
	/** A focused question captured from the phrase (e.g. text after "about"), if any. */
	question?: string;
}

// Verb group shared by the council/solo/gut-check patterns: "ask/use/consult".
const VERB = "(?:ask|use|consult)";

// Ordered most-specific-first. Each entry's regex is tested against the trimmed,
// lowercased input; the first hit wins.
const PATTERNS: Array<{ mode: ConsultMode; re: RegExp }> = [
	// debate: "debate this", "have them debate", "let them debate"
	{ mode: "debate", re: /\b(?:debate\s+this|(?:have|let)\s+(?:them|the\s+advisors?)\s+debate|start\s+a\s+debate)\b/ },
	// gut-check: "gut check this", "gut-check", "gut check"
	{ mode: "gut-check", re: /\bgut[-\s]?check\b/ },
	// council: "use/ask/consult the council", "council on this", "convene/run the council".
	// NOTE: no bare "the council" — that fires on casual mentions ("what did the council
	// say?", "the council of Elrond…") and a false positive here spends real money. A verb
	// or the "on this" shape is required so it only triggers on an actual request.
	{ mode: "council", re: new RegExp(`\\b(?:${VERB}\\s+the\\s+council|council\\s+on\\s+this|(?:convene|run)\\s+the\\s+council)\\b`) },
	// solo/advisor: "ask/use/consult the advisor", "second opinion", "get advice"
	{ mode: "solo", re: new RegExp(`\\b(?:${VERB}\\s+the\\s+advisor|second\\s+opinion|get\\s+(?:a\\s+)?second\\s+opinion|get\\s+advice)\\b`) },
];

// Capture a focused question after "about …" (to end of line). Kept simple: the
// tail is whatever the user wrote after "about", trimmed of trailing punctuation.
const ABOUT_RE = /\babout\s+(.+?)\s*[.?!]*\s*$/i;

/**
 * Parse a user input string into a consult mode + optional question, or null if
 * no phrase matches.
 *
 * @param text - the raw user input
 * @returns the matched mode (and captured question), or null when nothing fires
 */
export function parseConsultPhrase(text: string): ParsedConsultPhrase | null {
	const prompt = text.trim().toLowerCase();
	if (!prompt) return null;

	for (const { mode, re } of PATTERNS) {
		if (!re.test(prompt)) continue;
		// Pull a focused question from the ORIGINAL casing so the advisor sees it
		// the way the user wrote it, not lowercased.
		const aboutMatch = text.trim().match(ABOUT_RE);
		const question = aboutMatch?.[1]?.trim() || undefined;
		return question ? { mode, question } : { mode };
	}

	return null;
}
