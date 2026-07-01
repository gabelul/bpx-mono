import { describe, expect, it } from "vitest";
import {
	computeConfidence,
	detectDisagreement,
	validateStance,
	type MemberResult,
} from "../src/consensus.js";
import { applyStance, resolvePersona, personaSystemPrompt, DEFAULT_COUNCIL_ROSTER, DEFAULT_PERSONAS } from "../src/personas.js";

// ---------------------------------------------------------------------------
// validateStance
// ---------------------------------------------------------------------------

describe("validateStance", () => {
	it("scores an empty reply 0", () => {
		expect(validateStance("", "against")).toBe(0);
		expect(validateStance("   ", "for")).toBe(0);
	});

	it("rewards a critic that actually critiques", () => {
		const text = "The flaw here is the unhandled null case — it breaks when input is empty. Real risk.";
		expect(validateStance(text, "against")).toBe(1);
	});

	it("flags a critic that only praises (suspect — didn't do its job)", () => {
		const text = "This looks solid, sound, and correct. Great work.";
		expect(validateStance(text, "against")).toBeLessThan(0.5);
	});

	it("rewards an advocate that advocates", () => {
		const text = "The approach is sound and works well. Solid design, correct call.";
		expect(validateStance(text, "for")).toBe(1);
	});

	it("rewards neutral members that weigh both sides", () => {
		const text = "The design is sound but there's a real risk in the edge case. Works mostly, missing one path.";
		expect(validateStance(text, "neutral")).toBe(1);
	});

	it("defaults borderline (no signals) to 0.6 — trust the reply", () => {
		expect(validateStance("just some neutral statement with no signals", "neutral")).toBe(0.6);
	});
});

// ---------------------------------------------------------------------------
// computeConfidence
// ---------------------------------------------------------------------------

function member(over: Partial<MemberResult>): MemberResult {
	return {
		persona: "x",
		stance: "neutral",
		model: "m",
		status: "ok",
		text: "ok",
		alignment: 1,
		...over,
	};
}

describe("computeConfidence", () => {
	it("returns 0 for no members", () => {
		expect(computeConfidence([]).confidence).toBe(0);
	});

	it("returns 0 when all members errored", () => {
		const c = computeConfidence([member({ status: "error", alignment: 0 }), member({ status: "error", alignment: 0 })]);
		expect(c.confidence).toBe(0);
		expect(c.successRatio).toBe(0);
	});

	it("weights success 40%, agreement 35%, alignment 25%", () => {
		// 2 of 2 ok (success 1.0), all neutral (agreement 1.0), alignment avg 1.0
		const c = computeConfidence([member({ alignment: 1 }), member({ alignment: 1 })]);
		// 1.0*0.4 + 1.0*0.35 + 1.0*0.25 = 1.0
		expect(c.confidence).toBe(1.0);
	});

	it("penalizes partial failure in the success ratio", () => {
		// 1 of 2 ok → success 0.5; the successful set is size 1 so agreement 1.0;
		// avgAlignment is over successful only = 1.0.
		// 0.5*0.4 + 1.0*0.35 + 1.0*0.25 = 0.2 + 0.35 + 0.25 = 0.8
		const c = computeConfidence([member({ status: "ok", alignment: 1 }), member({ status: "error", alignment: 0 })]);
		expect(c.successRatio).toBe(0.5);
		expect(c.avgAlignment).toBe(1.0); // avg over successful only
		expect(c.confidence).toBe(0.8);
	});

	it("penalizes stance disagreement in the agreement ratio", () => {
		// one for, one against, both held → agreement = 1/2 = 0.5
		const c = computeConfidence([
			member({ stance: "for", alignment: 1 }),
			member({ stance: "against", alignment: 1 }),
		]);
		expect(c.agreementRatio).toBe(0.5);
		// 1.0*0.4 + 0.5*0.35 + 1.0*0.25 = 0.4+0.175+0.25 = 0.825 → 0.83
		expect(c.confidence).toBe(0.83);
	});
});

// ---------------------------------------------------------------------------
// detectDisagreement
// ---------------------------------------------------------------------------

describe("detectDisagreement", () => {
	it("returns undefined when only one stance is held", () => {
		const r = detectDisagreement([
			member({ persona: "architect", stance: "for", alignment: 1 }),
			member({ persona: "simplifier", stance: "neutral", alignment: 1 }),
		]);
		expect(r).toBeUndefined();
	});

	it("surfaces a split when a held-for and a held-against member both present", () => {
		const r = detectDisagreement([
			member({ persona: "architect", stance: "for", alignment: 0.9 }),
			member({ persona: "critic", stance: "against", alignment: 0.9 }),
		]);
		expect(r).toBeDefined();
		expect(r).toContain("architect");
		expect(r).toContain("critic");
		expect(r).toContain("FOR");
		expect(r).toContain("do not manufacture");
	});

	it("ignores low-alignment members (they didn't hold their stance)", () => {
		const r = detectDisagreement([
			member({ persona: "architect", stance: "for", alignment: 0.4 }),
			member({ persona: "critic", stance: "against", alignment: 0.9 }),
		]);
		expect(r).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// applyStance / persona system prompts
// ---------------------------------------------------------------------------

describe("applyStance", () => {
	it("wraps with advocacy framing for 'for' and permits dissent", () => {
		const out = applyStance("base prompt", "for");
		expect(out).toContain("ADVOCACY");
		expect(out).toContain("say so plainly even if your stance is \"for\"");
	});

	it("wraps with critique framing for 'against'", () => {
		const out = applyStance("base prompt", "against");
		expect(out).toContain("CRITIQUE");
		expect(out).toContain("failure modes");
	});

	it("always includes the no-manufactured-agreement guardrail", () => {
		for (const stance of ["for", "against", "neutral"] as const) {
			const out = applyStance("p", stance);
			expect(out).toContain("Manufactured agreement is worse than honest dissent");
		}
	});
});

// ---------------------------------------------------------------------------
// resolvePersona + defaults
// ---------------------------------------------------------------------------

describe("resolvePersona", () => {
	it("returns the bundled default for a known name", () => {
		const p = resolvePersona("architect", undefined);
		expect(p?.stance).toBe("for");
		expect(p?.systemPrompt).toContain("lead engineer");
	});

	it("layers user overrides on top of the default", () => {
		const p = resolvePersona("architect", { architect: { defaultModel: "anthropic/claude-opus-4-8" } });
		expect(p?.defaultModel).toBe("anthropic/claude-opus-4-8");
		expect(p?.stance).toBe("for"); // inherited from default
	});

	it("accepts a fully user-defined persona with no bundled base", () => {
		const p = resolvePersona("my-custom", {
			"my-custom": { systemPrompt: "custom viewpoint", stance: "neutral" },
		});
		expect(p?.systemPrompt).toBe("custom viewpoint");
		expect(p?.stance).toBe("neutral");
	});

	it("returns undefined for an unknown name with no override", () => {
		expect(resolvePersona("nope", undefined)).toBeUndefined();
	});

	it("returns undefined for a user persona missing systemPrompt", () => {
		expect(resolvePersona("incomplete", { incomplete: { stance: "for" } })).toBeUndefined();
	});
});

describe("DEFAULT_COUNCIL_ROSTER", () => {
	it("is architect + critic + simplifier (per SPEC §V)", () => {
		expect(DEFAULT_COUNCIL_ROSTER).toEqual(["architect", "critic", "simplifier"]);
	});

	it("every roster name resolves to a bundled persona", () => {
		for (const name of DEFAULT_COUNCIL_ROSTER) {
			expect(DEFAULT_PERSONAS[name]).toBeDefined();
		}
	});

	it("security and performance are conditional", () => {
		expect(DEFAULT_PERSONAS.security.conditional).toBe(true);
		expect(DEFAULT_PERSONAS.performance.conditional).toBe(true);
		expect(DEFAULT_PERSONAS.architect.conditional).toBeUndefined();
	});
});

describe("personaSystemPrompt", () => {
	it("combines base prompt + stance framing", () => {
		const p = resolvePersona("critic", undefined)!;
		const out = personaSystemPrompt(p);
		expect(out).toContain("sharp critic");
		expect(out).toContain("CRITIQUE");
	});
});
