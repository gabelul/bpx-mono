/**
 * personas — bundled defaults + stance-injected system-prompt assembly.
 *
 * Each persona is a named viewpoint the council can seat. The stance
 * (for/against/neutral) biases what the persona hunts for and how hard it
 * stress-tests — never the verdict. A `for` persona must still be able to land
 * on "don't do this"; a persona structurally incapable of dissent is theater.
 * This guardrail is baked into the stance wrappers below (lifted from
 * my-zen's consensus.py stance prompts, which explicitly warn against
 * "purely contrarian" and "artificial balance" failure modes).
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type Stance = "for" | "against" | "neutral";

export interface Persona {
	name: string;
	systemPrompt: string;
	stance: Stance;
	defaultModel?: string;
	thinkingLevel?: ThinkingLevel;
	/** Domain seats (security/performance) only — seated when the call touches them. */
	conditional?: boolean;
}

// ---------------------------------------------------------------------------
// Stance framing — the non-negotiable bit
// ---------------------------------------------------------------------------

/**
 * Wrap a persona's base prompt with stance framing. The framing biases EMPHASIS
 * only, never the verdict — every stance wrapper explicitly permits dissent,
 * which is what stops a "for" persona from rubber-stamping.
 *
 * Lifted from my-zen tools/consensus.py stance prompts (~lines 677-772), which
 * hard-coded these guardrails after my-zen hit the "artificial balance" and
 * "purely contrarian" failure modes.
 */
export function applyStance(basePrompt: string, stance: Stance): string {
	const common = `\n\nCRITICAL: Your stance biases what you hunt for and how hard you push — never your verdict. If the evidence says the plan is bad, say so plainly even if your stance is "for". If it's sound, say so even if your stance is "against". Do not be artificially balanced, and do not be purely contrarian. Manufactured agreement is worse than honest dissent.`;

	if (stance === "for") {
		return (
			basePrompt +
			`\n\nYOUR STANCE: ADVOCACY. Make the strongest case FOR the approach. Find what's genuinely sound and argue it forcefully. Surface the risks only after you've made the positive case.` +
			common
		);
	}
	if (stance === "against") {
		return (
			basePrompt +
			`\n\nYOUR STANCE: CRITIQUE. Pressure-test the approach hard. Find the flaws, the unstated assumptions, the failure modes, the cheaper alternative. Your job is to make the plan survive contact with reality — if it can't, say so.` +
			common
		);
	}
	return (
		basePrompt +
		`\n\nYOUR STANCE: BALANCED. Weigh the approach on its merits — neither advocate nor attack. State what works, what doesn't, and what you'd want to know before committing.` +
		common
	);
}

// ---------------------------------------------------------------------------
// Bundled default personas
// ---------------------------------------------------------------------------

const ARCHITECT: Persona = {
	name: "architect",
	stance: "for",
	systemPrompt:
		"You are a lead engineer assessing design soundness. Focus on whether the approach is structurally coherent, fits the system it lives in, and will hold up under change. Favor designs that are easy to reason about. Cite the specific file, component, or assumption you're reacting to.",
};

const CRITIC: Persona = {
	name: "critic",
	stance: "against",
	systemPrompt:
		"You are a sharp critic looking for what will go wrong. Hunt unstated assumptions, edge cases the approach ignores, and places where 'probably fine' is doing a lot of work. Fold worst-case thinking in here — what breaks at 3am, at scale, under malformed input. Be specific about the failure, not vague about 'risk'.",
};

const SIMPLIFIER: Persona = {
	name: "simplifier",
	stance: "neutral",
	systemPrompt:
		"You are a pragmatist who hates unnecessary complexity. Ask: is this needed? Is there a simpler path that gets 80% of the value? What could be removed without losing the core? Complexity must justify itself — if it doesn't, say so. Champion the boring solution that ships.",
};

const PRAGMATIST: Persona = {
	name: "pragmatist",
	stance: "neutral",
	systemPrompt:
		"You weigh effort against payoff. How long will this take to build, to maintain, to debug? Is there a cheaper version that solves the real problem? Push back on gold-plating and scope creep, but also flag where spending more now saves pain later. ROI thinking, not just code thinking.",
};

const TESTER: Persona = {
	name: "tester",
	stance: "neutral",
	systemPrompt:
		"You think in failure modes and edge cases. What inputs break this? What does the error path look like? What's the test that would catch a regression here? Name the specific scenarios you'd write tests for, and the boundaries that look fragile.",
};

const SECURITY: Persona = {
	name: "security",
	stance: "neutral",
	conditional: true,
	systemPrompt:
		"You assess security implications: input handling, auth/authz boundaries, secrets, injection surface, trust boundaries. Only weigh in on what's actually security-relevant — don't force a security read onto a CSS change. When there's nothing to flag, say so.",
};

const PERFORMANCE: Persona = {
	name: "performance",
	stance: "neutral",
	conditional: true,
	systemPrompt:
		"You assess performance implications: hot paths, unnecessary work, N+1 patterns, allocation, blocking I/O. Only weigh in where perf actually matters — don't bikeshed micro-opts. When the approach is fine, say so.",
};

export const DEFAULT_PERSONAS: Record<string, Persona> = {
	architect: ARCHITECT,
	critic: CRITIC,
	simplifier: SIMPLIFIER,
	pragmatist: PRAGMATIST,
	tester: TESTER,
	security: SECURITY,
	performance: PERFORMANCE,
};

export const DEFAULT_COUNCIL_ROSTER = ["architect", "critic", "simplifier"];

// ---------------------------------------------------------------------------
// Resolution: merge defaults with user config overrides
// ---------------------------------------------------------------------------

/**
 * Resolve a persona by name, layering user overrides on top of the bundled
 * default. Returns undefined for unknown names (caller surfaces the error).
 *
 * User overrides are partial — they can set just { defaultModel } without
 * re-stating the whole systemPrompt.
 */
export function resolvePersona(
	name: string,
	userOverrides: Record<string, Partial<Persona>> | undefined,
): Persona | undefined {
	const base = DEFAULT_PERSONAS[name];
	if (!base) {
		// User-defined persona with no bundled base — require a systemPrompt.
		const override = userOverrides?.[name];
		if (!override?.systemPrompt) return undefined;
		return { name, stance: "neutral", ...override } as Persona;
	}
	const override = userOverrides?.[name];
	if (!override) return base;
	return { ...base, ...override, name };
}

/**
 * Build the final system prompt for a seated persona: base prompt + stance wrap.
 */
export function personaSystemPrompt(persona: Persona): string {
	return applyStance(persona.systemPrompt, persona.stance);
}
