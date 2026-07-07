/**
 * bpx-consult — Pi extension entry point.
 *
 * Registers the `consult()` tool and the `/consult` command. When the executor
 * calls consult() with no args, solo runs (one advisor model, context-fitted).
 * mode: "council" | "debate" | "gut-check" select the other modes.
 *
 * Config persists at ~/.pi/agent/bpx-consult.json.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isDisabledForModel, loadConfig } from "./src/config.js";
import { runConsultConfigurator } from "./src/consult-ui.js";
import { executeSolo } from "./src/solo.js";
import { executeCouncil } from "./src/council.js";
import { executeDebate } from "./src/debate.js";
import { registerTriggers } from "./src/triggers.js";
import { registerConsultRenderer } from "./src/deliver.js";
import { createTurnBudget, incrementTurnBudget, isCapReached, resetTurnBudget } from "./src/turn-budget.js";
import {
	CONSULT_DESCRIPTION,
	CONSULT_TOOL_NAME,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	TOOL_LABEL,
} from "./src/messages.js";

const ConsultParams = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("solo"), Type.Literal("council"), Type.Literal("debate"), Type.Literal("gut-check")]),
	),
	persona: Type.Optional(Type.String({ description: "Persona name (council mode), e.g. architect, critic." })),
	question: Type.Optional(Type.String({ description: "Optional specific question to focus the advisor." })),
});

export default function bpxConsult(pi: ExtensionAPI): void {
	// One per-turn consult budget for the whole extension instance (≈ per session).
	// Shared between the tool handler (which counts + caps the model's calls) and
	// the reset hooks below. Phrase/auto-triggers never touch it — the cap guards
	// only the model's own consult() spend.
	const budget = createTurnBudget();

	// Reset the counter at the same points triggers.ts resets its state: at the
	// start of each turn, and on a genuine user input (interactive/rpc). A user
	// stepping in resets the model's per-turn allowance.
	pi.on("before_agent_start", () => resetTurnBudget(budget));
	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") resetTurnBudget(budget);
		return { action: "continue" };
	});

	registerConsultRenderer(pi);
	registerConsultTool(pi, budget);
	registerConsultCommand(pi);
	registerTriggers(pi);
}

function registerConsultTool(pi: ExtensionAPI, budget: ReturnType<typeof createTurnBudget>): void {
	pi.registerTool({
		name: CONSULT_TOOL_NAME,
		label: TOOL_LABEL,
		description: CONSULT_DESCRIPTION,
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: ConsultParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });

			// Disabled for this executor model? Bail with a short explanation so
			// the executor knows consult is intentionally off, not broken.
			if (ctx.model) {
				const executorLabel = `${ctx.model.provider}/${ctx.model.id}`;
				const tl = pi.getThinkingLevel();
				// getThinkingLevel() returns ModelThinkingLevel (includes "off"); narrow it.
				const thinkingLevel = tl === "off" ? undefined : tl;
				if (isDisabledForModel(config.disabledForModels as never, executorLabel, thinkingLevel)) {
					return {
						content: [{ type: "text", text: `consult is disabled for ${executorLabel}.` }],
						details: { mode: "disabled", advisorModel: "(disabled)" },
					};
				}
			}

			// Soft per-turn cap on the MODEL's own consult() calls. If the model has
			// already spent its allowance this turn, return a CHEAP result — no
			// advisor call — telling it to proceed or raise the cap. Auto-triggers
			// and phrase-triggers are separate paths and never reach this handler,
			// so they're unaffected. Count the call only when we're actually going
			// to run it, so a capped turn doesn't inflate the counter further.
			const cap = config.maxConsultsPerTurn ?? 0;
			if (isCapReached(budget, cap)) {
				return {
					content: [
						{
							type: "text",
							text: `consult cap reached — ${budget.used}/${cap} this turn. Proceed on your own judgment, or raise maxConsultsPerTurn in /consult.`,
						},
					],
					details: { mode: "capped", advisorModel: "(capped)" },
				};
			}
			incrementTurnBudget(budget);

			const mode = params.mode ?? config.defaultMode ?? "solo";

			if (mode === "council") {
				return executeCouncil({ ctx, config, signal, onUpdate, question: params.question });
			}
			if (mode === "debate") {
				return executeDebate({ ctx, config, signal, onUpdate, question: params.question });
			}
			if (mode === "gut-check") {
				// Gut-check = solo run against the cheap model in modes.gutCheck.
				// Override modes.solo so executeSolo uses the gutCheck model + effort.
				const gutCheck = config.modes?.gutCheck;
				if (gutCheck?.model) {
					const gutConfig = { ...config, modes: { ...config.modes, solo: { ...config.modes?.solo, ...gutCheck } } };
					return executeSolo({ ctx, config: gutConfig, signal, onUpdate, question: params.question });
				}
				return executeSolo({ ctx, config, signal, onUpdate, question: params.question });
			}

			return executeSolo({ ctx, config, signal, onUpdate, question: params.question });
		},
	});
}

function registerConsultCommand(pi: ExtensionAPI): void {
	pi.registerCommand("consult", {
		description: "Configure bpx-consult interactively (model, mode, effort, personas, triggers), or /consult status.",
		async handler(args, ctx) {
			// `/consult status` keeps the old read-out for a quick glance / non-interactive.
			// Everything else (no arg, or any other arg) opens the interactive menu.
			if (args.trim() === "status") {
				showStatusReadout(ctx);
				return;
			}
			await runConsultConfigurator(ctx, { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		},
	});
}

function showStatusReadout(ctx: ExtensionContext): void {
	const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	const solo = config.modes?.solo;
	const lines = [
		`bpx-consult status`,
		`  enabled    : ${config.enabled ?? true}`,
		`  defaultMode: ${config.defaultMode}`,
		`  solo model : ${solo?.model ?? "(none)"}`,
		`  effort     : ${solo?.thinkingLevel ?? "(default)"}`,
		`  triggers   : onDone=${config.triggers?.onDone ?? false}, whenStuck=${config.triggers?.whenStuck ?? 0}`,
		`  maxConsults: ${config.maxConsultsPerTurn ?? 0} per turn (0 = unlimited)`,
		`  feedback   : ${config.feedbackMode ?? "steer"}`,
		``,
		`Run /consult (no args) to edit settings interactively.`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
