/**
 * persona-gen — LLM-driven persona definition generation.
 *
 * The "Add a persona (AI-generated)" flow: the user describes the advisor's
 * focus, a model drafts a {name, stance, systemPrompt} definition, we parse +
 * sanitize it, and the council submenu seats it. Mirrors the pattern
 * pi-subagents uses for agent creation, but bpx-consult doesn't spawn a
 * subagent to write a file — it calls an advisor directly and parses JSON,
 * because a persona is a small structured object, not a markdown file.
 *
 * This module holds the pure pieces (prompt builder + JSON extraction/sanitizing)
 * so they're unit-testable without a live model. The network call lives in
 * consult-ui.ts.
 */

/** What the model is asked to produce (and what we parse back). */
export interface GeneratedPersona {
	name: string;
	stance: "for" | "against" | "neutral";
	systemPrompt: string;
}

const GEN_SYSTEM_PROMPT =
	"You draft advisor personas for a multi-model council that reviews decisions before they're committed. " +
	"You output strict JSON only — no markdown fences, no prose around it.";

/**
 * Build the prompt that asks the model for a persona definition.
 * Kept here (not inlined) so the prompt is unit-testable and versioned.
 */
export function buildGeneratePrompt(description: string): string {
	return [
		`Draft one advisor persona for a council. The user wants an advisor focused on:`,
		``,
		`${description}`,
		``,
		`Reply with ONLY a JSON object (no markdown fences, no commentary) with exactly these fields:`,
		`{`,
		`  "name": "short lowercase hyphenated slug, e.g. 'security', 'api-design', 'cost', 'pragmatist'",`,
		`  "stance": "for | against | neutral — pick what fits the focus. 'against' hunts for risks and flaws (security, critic, skeptic); 'for' advocates (champion, advocate); 'neutral' weighs (analyst, pragmatist).",`,
		`  "systemPrompt": "2-4 sentences. The advisor's specific lens: what it hunts for, how it argues, what it prioritizes. Specific to the focus, not generic praise."`,
		`}`,
		``,
		`Rules:`,
		`- Stance biases what the persona hunts for, never its verdict. A 'for' advisor can still land on "don't do this" if the evidence says so.`,
		`- The systemPrompt must be specific to the focus. No generic "you are a helpful assistant".`,
		`- Output ONLY the JSON object.`,
	].join("\n");
}

export { GEN_SYSTEM_PROMPT };

/**
 * Parse the model's reply into a sanitized persona.
 *
 * Tolerates the common failure modes: markdown fences around the JSON, prose
 * before/after the object, single instead of double quotes won't be coerced
 * (JSON is strict). On any failure returns ok:false with a short reason so the
 * caller can offer regenerate.
 */
export function parsePersonaJson(raw: string): { ok: true; persona: GeneratedPersona } | { ok: false; error: string } {
	const extracted = extractJsonObject(raw);
	if (extracted === null) return { ok: false, error: "no JSON object found in the model's reply" };

	let obj: unknown;
	try {
		obj = JSON.parse(extracted);
	} catch (e) {
		return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
	}

	if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
		return { ok: false, error: "reply was not a JSON object" };
	}

	const record = obj as Record<string, unknown>;
	const name = sanitizeName(record.name);
	if (!name) return { ok: false, error: "missing or empty 'name'" };

	const stance = coerceStance(record.stance);
	if (stance === null) return { ok: false, error: `'stance' must be for/against/neutral, got ${JSON.stringify(record.stance)}` };

	const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";
	if (!systemPrompt) return { ok: false, error: "missing or empty 'systemPrompt'" };

	return { ok: true, persona: { name, stance, systemPrompt } };
}

/** Find the outermost {...} in the text, tolerating ```json fences. */
function extractJsonObject(raw: string): string | null {
	const trimmed = raw.trim();
	// Direct JSON.
	if (trimmed.startsWith("{")) return trimmed;

	// ```json\n...\n``` or ```\n...\n```
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence?.[1]) return fence[1].trim();

	// First { to last } — model sometimes adds prose around the object.
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first !== -1 && last !== -1 && last > first) return trimmed.slice(first, last + 1);

	return null;
}

/**
 * Coerce a name into a safe slug: lowercase, trim, spaces→hyphens, drop
 * anything that isn't a-z0-9-. Empty result → null (caller regenerates).
 */
function sanitizeName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const slug = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
	return slug.length > 0 ? slug : null;
}

/** Accept the three valid stances (case-insensitive); anything else → null. */
function coerceStance(value: unknown): "for" | "against" | "neutral" | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (v === "for" || v === "against" || v === "neutral") return v;
	return null;
}
