/**
 * debate-cli-dispatch — integration test for callStep's CLI branch.
 *
 * debate-cli.test.ts proves resolveSide returns the right ResolvedSide for a
 * CLI-backed persona; this file proves callStep actually DISPATCHES on kind
 * and calls callCliAdvisor instead of callAdvisor when the side is CLI.
 *
 * Without this, a refactor that silently drops the `if (side.kind === "cli")`
 * branch (or breaks the CliCallResult → ConsultCallResult normalisation in
 * the `.then()`) would leave the suite green: resolveSide would still return
 * the right kind, and callAdvisor would be mocked. The bug would only
 * surface when a real user hits it — exactly the class of bug the original
 * "no api key resolved" regression was.
 *
 * Test design note: the synthesizer in debate mode is inline-only (matches
 * council mode; see debate.ts comment). So the callAdvisor mock can only
 * succeed for the synthesizer. Both tests below route advocate + critic
 * through CLI backends so the CLI dispatch is exercised before the debate
 * reaches the inline synthesizer (where the throw-mock bails the debate).
 * The bail-at-synth boundary is intentional: it proves the CLI dispatch
 * happened first AND the inline synthesizer failure surfaces.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockCliEntry {
	text: string;
	errorMessage?: string;
}

let cliCallSequence: MockCliEntry[] = [];

/** Records each callCliAdvisor invocation so the test can assert what was
 * passed through the dispatch boundary. */
let cliCalls: Array<{ systemPrompt: string; messages: unknown[]; backend: { command: string } }> = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
	buildSessionContext: () => ({ messages: [] }),
	convertToLlm: () => [],
}));

vi.mock("../src/advisor.js", () => ({
	// The synthesizer stays inline-only in debate mode; it resolves through
	// resolveAdvisor and invokes callAdvisor. Return a valid inline advisor
	// for the synth so the debate gets past the resolve check.
	resolveAdvisor: () => ({
		label: "test/inline-synth",
		model: { contextWindow: 200_000 } as never,
	}),
	// The advocate + critic are CLI in these tests so callAdvisor SHOULD NOT
	// be called for them — if it is, that's a regression. The synth's
	// callAdvisor call is the only legitimate one, and it throws to keep the
	// debate bounded inside this test (the bail-at-synth boundary is exactly
	// what these tests assert against).
	callAdvisor: async () => {
		throw new Error("callAdvisor should not be invoked when a persona has a CLI backend configured");
	},
}));

vi.mock("../src/cli-backend.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cli-backend.js")>();
	return {
		...actual,
		callCliAdvisor: async (input: { systemPrompt: string; messages: unknown[]; backend: { command: string } }) => {
			cliCalls.push(input);
			const next = cliCallSequence.shift();
			if (!next) {
				return { text: "", timedOut: false, exitCode: null, errorMessage: "no more mock CLI responses" };
			}
			return {
				text: next.text,
				timedOut: false,
				exitCode: 0,
				errorMessage: next.errorMessage,
			};
		},
	};
});

const { executeDebate } = await import("../src/debate.js");
const { DEFAULT_CONFIG } = await import("../src/config.js");
import type { BpxConsultConfig } from "../src/config.js";

function makeCtx(): never {
	return {
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => "leaf-1",
			getSessionId: () => "session-1",
		},
	} as never;
}

function cliOnlyConfig(): BpxConsultConfig {
	return {
		...DEFAULT_CONFIG,
		modes: {
			...DEFAULT_CONFIG.modes,
			debate: { advocate: "architect", critic: "critic", rounds: 1, timeoutMs: 180000 },
		},
		personas: {
			architect: { backend: { type: "cli", command: "claude" } },
			critic: { backend: { type: "cli", command: "codex" } },
		},
		backends: {},
	} as BpxConsultConfig;
}

beforeEach(() => {
	cliCallSequence = [];
	cliCalls = [];
});

describe("executeDebate — CLI dispatch through callStep", () => {
	it("routes CLI-backed advocate + critic through callCliAdvisor, never callAdvisor", async () => {
		cliCallSequence = [
			{ text: "Advocate CLI output." },
			{ text: "Critic CLI output." },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: cliOnlyConfig(),
			signal: undefined,
			onUpdate: undefined,
			question: "Should the architect + critic both run via CLI?",
		});

		const text = result.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("");

		// Both CLI turns completed successfully and are preserved in roundLog
		// (the debate bails at the inline synthesizer, which throws via the
		// callAdvisor mock above — exactly the boundary we want to exercise).
		expect(text).toContain("Advocate CLI output.");
		expect(text).toContain("Critic CLI output.");
		expect(text).toContain("Debate incomplete");
		expect(text).toContain("callAdvisor should not be invoked");

		// Two CLI invocations: one for the advocate, one for the critic.
		expect(cliCalls.length).toBe(2);

		// First call: advocate's CLI dispatch. The systemPrompt is the
		// stance-injected persona prompt for the architect (contains "lead
		// engineer" from the bundled architect systemPrompt).
		expect(cliCalls[0]?.backend.command).toBe("claude");
		expect(cliCalls[0]?.systemPrompt).toContain("lead engineer");

		// Second call: critic's CLI dispatch.
		expect(cliCalls[1]?.backend.command).toBe("codex");
		expect(cliCalls[1]?.systemPrompt).toContain("sharp critic");
	});

	it("normalises CliCallResult.errorMessage into callStep's failure path", async () => {
		// Regression guard for the `.then()` block in callStep. The CLI mock
		// returns `errorMessage` on a non-zero exit; without the normalisation,
		// a real CLI failure would slip through as stopReason "stop" and become
		// a bogus success. We bail at round 1 (advocate's CLI failed) so no
		// critic entry is consumed.
		cliCallSequence = [
			{ text: "", errorMessage: "CLI subprocess exited 1" },
		];

		const result = await executeDebate({
			ctx: makeCtx(),
			config: cliOnlyConfig(),
			signal: undefined,
			onUpdate: undefined,
			question: "Will the advocate's CLI failure surface?",
		});

		const text = result.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("");

		// The CLI failure errorMessage must surface in the bail output.
		expect(text).toContain("CLI subprocess exited 1");

		// The failed advocate's empty text must NOT appear as a successful turn.
		expect(text).not.toContain("Advocate CLI output.");

		// No completed rounds → bail returns the bare error, not the partial
		// preservation wrapper.
		expect(text).not.toContain("The rounds that completed");

		// Exactly one CLI invocation — the advocate's failed call. The critic's
		// CLI was never reached because bail fired.
		expect(cliCalls.length).toBe(1);
		expect(cliCalls[0]?.backend.command).toBe("claude");
	});
});
