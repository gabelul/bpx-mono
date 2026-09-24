import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderConsultCall, renderConsultResult } from "../src/result-ui.js";

initTheme("dark", false);
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
const result = (text: string, details: unknown) => ({
	content: [{ type: "text", text }], details,
}) as AgentToolResult<unknown>;
const visible = (value: ReturnType<typeof renderConsultResult>, width = 100) => value.render(width).join("\n");

/** Check labels and status without requiring live providers or a TUI process. */
describe("consult result display", () => {
	it("keeps full Solo advice readable while expansion reveals ID and known usage", () => {
		const advice = "PLAN\nCheck error handling.\nDo not remove the final finding.";
		const original = result(advice, { mode: "solo", advisorModel: "inline/sonnet", consultationId: "id-1",
			reportedUsage: { input: 400, output: 90, cost: { total: 0.004 } } });
		const before = structuredClone(original);
		const normal = visible(renderConsultResult(original, { expanded: false, isPartial: false }, theme));
		expect(normal).toContain("consult / solo");
		expect(normal).toContain("inline/sonnet");
		expect(normal).toContain("Do not remove the final finding.");
		expect(normal).not.toContain("id-1");
		const expanded = visible(renderConsultResult(original, { expanded: true, isPartial: false }, theme));
		expect(expanded).toContain("id-1");
		expect(expanded).toContain("Reported usage: 400 in · 90 out · $0.0040");
		expect(original).toEqual(before);
	});

	it("identifies gut-check even though execution details say Solo", () => {
		const shown = visible(renderConsultResult(result("Short read", { mode: "solo", advisorModel: "fast/model", requestedMode: "gut-check" }),
			{ expanded: false, isPartial: false }, theme, "gut-check"));
		expect(shown).toContain("consult / gut-check");
		expect(shown).toContain("fast/model");
		expect(renderConsultCall({}, theme).render(40).join(" ")).toContain("configured mode");
	});

	it("shows Council partial failures and actual member routes without hiding advice", () => {
		const shown = visible(renderConsultResult(result("CORRECTION\nFix the retry.", {
			mode: "council", synthesizer: "synth/model", members: [
				{ persona: "architect", model: "inline/a", status: "ok" },
				{ persona: "critic", model: "cli:codex/b", status: "error" },
			], disagreement: "retry safety",
		}), { expanded: true, isPartial: false }, theme));
		expect(shown).toContain("partial");
		expect(shown).toContain("1/2 members replied");
		expect(shown).toContain("critic: cli:codex/b (error)");
		expect(shown).toContain("Fix the retry.");
		expect(shown).not.toContain("Reported usage: 0");
	});

	it("shows individual Council seats on expanded partial updates", () => {
		const partial = visible(renderConsultResult(result("Council: 1/2 seats finished", {
			mode: "council", phase: "Council: 1/2 seats finished", synthesizer: "synth/model", members: [
				{ persona: "architect", model: "inline/a", status: "pending" },
				{ persona: "critic", model: "cli/b", status: "ok" },
			],
		}), { expanded: true, isPartial: true }, theme));
		expect(partial).toContain("architect: pending");
		expect(partial).toContain("critic: ok");
	});

	it("shows Debate phase updates, then failure with retained transcript", () => {
		const partial = visible(renderConsultResult(result("Round 2/2 · critic running", {
			mode: "debate", rounds: 2, advocate: "model/a", critic: "model/b", phase: "Round 2/2 · critic running",
		}), { expanded: false, isPartial: true }, theme));
		expect(partial).toContain("working");
		expect(partial).toContain("Round 2/2 · critic running");
		const final = visible(renderConsultResult(result("Debate timed out\n### Completed argument", {
			mode: "debate", rounds: 2, advocate: "model/a", critic: "model/b", errorMessage: "timeout",
		}), { expanded: false, isPartial: false }, theme));
		expect(final).toContain("failed");
		expect(final).toContain("Completed argument");
	});

	it("wraps long model labels and advice inside a narrow terminal", () => {
		const rendered = renderConsultResult(result("A long recommendation with a concrete finding at the end of the line.", {
			mode: "solo", advisorModel: "provider/a-very-long-model-name-with-qualifier",
		}), { expanded: true, isPartial: false }, theme).render(42);
		expect(rendered.every((line) => visibleWidth(line) <= 42)).toBe(true);
		expect(rendered.join(" ")).toContain("concrete");
		expect(rendered.join(" ")).toContain("finding");
	});

	it("handles capped and malformed details without inventing a route or cost", () => {
		const capped = visible(renderConsultResult(result("consult cap reached", { mode: "capped" }), { expanded: false, isPartial: false }, theme, "council"));
		expect(capped).toContain("consult / council  capped");
		const malformed = visible(renderConsultResult(result("read me", null), { expanded: true, isPartial: false }, theme), 40);
		expect(malformed).toContain("read me");
	});
});
