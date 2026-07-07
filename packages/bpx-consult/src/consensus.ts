/**
 * consensus — stance validation + confidence scoring.
 *
 * The two mechanics that give "no fake consensus" actual teeth:
 *
 *   - stance validation: did a member actually hold its assigned stance, or did
 *     it return mush? A `critic` that agrees with everything is theater.
 *   - confidence score: 0.4·success + 0.35·agreement + 0.25·avg_alignment,
 *     surfaced with the synthesis so you can see how solid the read is.
 *
 * Cheap and heuristic by design — these are signals, not verdicts. The
 * synthesizer model still does the real merging; we just give it (and you)
 * honest metadata about what the members actually did.
 */

import type { Stance } from "./personas.js";

// ---------------------------------------------------------------------------
// Member result shape
// ---------------------------------------------------------------------------

export interface MemberResult {
	persona: string;
	stance: Stance;
	model: string;
	/** "ok" if the member replied with usable text, "error" otherwise. */
	status: "ok" | "error";
	text: string;
	errorMessage?: string;
	/** 0..1 — did the reply actually reflect the assigned stance? */
	alignment: number;
	usage?: { input: number; output: number; total: number };
}

// ---------------------------------------------------------------------------
// Stance validation
// ---------------------------------------------------------------------------

/**
 * Heuristic stance-alignment check. Returns a 0..1 score indicating how well
 * the reply reflects the assigned stance.
 *
 * Not an LLM judge — that's another model call per member, too expensive for
 * v1. Keyword + signal based:
 *   - `against`: looks for critique signals (flaw, risk, won't, breaks, wrong,
 *     assumption, failure). A reply with none of them from a critic is suspect.
 *   - `for`: looks for advocacy signals (sound, works, solid, agree, good).
 *   - `neutral`: neutral by construction — alignment is whether it weighed both
 *     sides (any of either signal set counts).
 *
 * Deliberately permissive on the high end (1.0) and strict on the low end:
 * a low score flags "this member didn't do its job," which is the only signal
 * that actually matters. Borderline cases default to 0.6 (trust the reply).
 */
export function validateStance(text: string, stance: Stance): number {
	const t = text.toLowerCase();
	if (!t.trim()) return 0;

	const critiqueSignals = [
		"flaw", "risk", "won't", "won’t", "breaks", "broken", "wrong", "assumption",
		"failure", "fail", "missing", "edge case", "fragile", "beware", "problem",
		"issue", "concern", "gap", "unclear", "danger", "unhandled",
	];
	const advocacySignals = [
		"sound", "works", "solid", "agree", "good", "correct", "appropriate",
		"reasonable", "holds up", "make sense", "fits", "right call",
	];

	const hasCritique = critiqueSignals.some((s) => t.includes(s));
	const hasAdvocacy = advocacySignals.some((s) => t.includes(s));

	if (stance === "against") {
		if (hasCritique) return 1;
		if (hasAdvocacy && !hasCritique) return 0.3; // critic that only praised — suspect
		return 0.6;
	}
	if (stance === "for") {
		if (hasAdvocacy) return 1;
		if (hasCritique && !hasAdvocacy) return 0.5; // advocate that only attacked — forgot its job
		return 0.6;
	}
	// neutral: weighing both sides is the win
	if (hasCritique && hasAdvocacy) return 1;
	if (hasCritique || hasAdvocacy) return 0.7;
	return 0.6;
}

// ---------------------------------------------------------------------------
// Confidence score
// ---------------------------------------------------------------------------

export interface ConfidenceBreakdown {
	successRatio: number;
	agreementRatio: number;
	avgAlignment: number;
	/** 0..1 weighted: 0.4·success + 0.35·agreement + 0.25·avgAlignment */
	confidence: number;
}

/**
 * Compute the consensus confidence over member results.
 *
 * - successRatio: fraction of members that returned usable text.
 * - agreementRatio: the largest stance group / successful members. High when
 *   most members land on the same stance regardless of persona.
 * - avgAlignment: mean of per-member stance-alignment scores.
 *
 * A council where the `critic` secretly agreed, the `architect` attacked, and
 * the `simplifier` said nothing useful will score low on agreement and
 * alignment — which is the honest signal, even though the stances differ by
 * design. The synthesizer explains the substance; this just flags the shape.
 */
export function computeConfidence(results: MemberResult[]): ConfidenceBreakdown {
	const total = results.length;
	if (total === 0) {
		return { successRatio: 0, agreementRatio: 0, avgAlignment: 0, confidence: 0 };
	}

	const successful = results.filter((r) => r.status === "ok");
	const successCount = successful.length;
	if (successCount === 0) {
		return { successRatio: 0, agreementRatio: 0, avgAlignment: 0, confidence: 0 };
	}

	const successRatio = successCount / total;

	const stanceCounts: Record<Stance, number> = { for: 0, against: 0, neutral: 0 };
	for (const r of successful) stanceCounts[r.stance]++;
	const maxStanceCount = Math.max(...Object.values(stanceCounts));
	const agreementRatio = maxStanceCount / successCount;

	const alignmentScores = successful.map((r) => r.alignment);
	const avgAlignment = alignmentScores.reduce((a, b) => a + b, 0) / alignmentScores.length;

	const confidence = round2(successRatio * 0.4 + agreementRatio * 0.35 + avgAlignment * 0.25);

	return {
		successRatio: round2(successRatio),
		agreementRatio: round2(agreementRatio),
		avgAlignment: round2(avgAlignment),
		confidence,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Disagreement detection — surface it, don't paper over it
// ---------------------------------------------------------------------------

/**
 * Detect whether the council materially disagreed. Returns a short human-readable
 * note for the synthesizer prompt, or undefined if members were broadly aligned.
 *
 * "Material disagreement" = at least one `for` and one `against` member both
 * held their stance (alignment ≥ 0.7). Neutral members don't count toward the
 * split — they're expected to weigh both sides.
 */
export function detectDisagreement(results: MemberResult[]): string | undefined {
	const heldFor = results.filter((r) => r.stance === "for" && r.alignment >= 0.7 && r.status === "ok");
	const heldAgainst = results.filter((r) => r.stance === "against" && r.alignment >= 0.7 && r.status === "ok");

	if (heldFor.length > 0 && heldAgainst.length > 0) {
		return `The council split: ${heldFor.map((r) => r.persona).join(", ")} advocated FOR; ${heldAgainst
			.map((r) => r.persona)
			.join(", ")} pushed BACK. Surface this disagreement honestly in your synthesis — do not manufacture a false consensus.`;
	}
	return undefined;
}
