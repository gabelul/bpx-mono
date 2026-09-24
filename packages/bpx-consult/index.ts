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
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isDisabledForModel, loadConfig } from "./src/config.js";
import { runConsultConfigurator } from "./src/consult-ui.js";
import { executeSolo } from "./src/solo.js";
import { gutCheckConfig } from "./src/gut-check.js";
import { executeCouncil } from "./src/council.js";
import { executeDebate } from "./src/debate.js";
import { registerTriggers } from "./src/triggers.js";
import { CONSULT_LOCAL_RESULT_TYPE, registerConsultRenderer, withoutLegacyShowMessages } from "./src/deliver.js";
import { renderConsultCall, renderConsultResult } from "./src/result-ui.js";
import { listConsultations, newConsultationId, parseLabels, registerConsultationNavigation, recordLabels } from "./src/outcomes.js";
import { runShareCommand, SHARE_RESULT_TYPE } from "./src/share.js";
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

	registerConsultationNavigation(pi);
	registerConsultRenderer(pi);
	// Older show messages were custom messages, which Pi turns into user context.
	// Keep them in session history but exclude them from future executor requests.
	pi.on("context", (event) => {
		const messages = withoutLegacyShowMessages(event.messages);
		return messages.length === event.messages.length ? undefined : { messages };
	});
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
		renderCall(args, theme) { return renderConsultCall(args, theme); },
		renderResult(result, options, theme, context) {
			return renderConsultResult(result, options, theme, context.args.mode);
		},

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
			const consultationId = newConsultationId();
			const result = mode === "council"
				? await executeCouncil({ ctx, config, signal, onUpdate, question: params.question })
				: mode === "debate"
					? await executeDebate({ ctx, config, signal, onUpdate, question: params.question })
					: await executeSolo({ ctx, config: mode === "gut-check" ? gutCheckConfig(config) : config, signal, onUpdate, question: params.question });
			// Pi's TUI renderer receives content/details, not top-level usage. Mirror
			// known aggregate usage for display without adding another accounting entry.
			const reportedUsage = (result as typeof result & { usage?: Usage }).usage;
			return { ...result, details: { ...result.details, consultationId, requestedMode: mode,
				...(reportedUsage ? { reportedUsage } : {}) } };
		},
	});
}

function registerConsultCommand(pi: ExtensionAPI): void {
	pi.registerCommand("consult", {
		description: "Configure advisor, label outcomes, or share explicitly selected files.",
		async handler(args, ctx) {
			const command = args.trim();
			if (command === "status") {
				showStatusReadout(ctx);
				return;
			}
			if (command === "recent") {
				const records = listConsultations(ctx.sessionManager.getBranch());
				ctx.ui.notify(records.length ? records.slice(-10).reverse().map((r) =>
					`${r.id}  ${r.mode} (${r.source})  used: ${formatLabel(r.used)}  helped: ${formatLabel(r.helped)}`,
				).join("\n") : "No consultations on this session branch.", "info");
				return;
			}
			if (command === "result" || command.startsWith("result ")) {
				const id = command.slice("result".length).trim();
				const entry = ctx.sessionManager.getBranch().find((item) => item.type === "custom" &&
					(item.customType === SHARE_RESULT_TYPE || item.customType === CONSULT_LOCAL_RESULT_TYPE) &&
					(item.data as { id?: unknown } | undefined)?.id === id);
				if (!id || !entry || entry.type !== "custom") {
					ctx.ui.notify("Consult result not found on this session branch. Run /consult recent.", "error");
					return;
				}
				const data = entry.data as { text: string; errorMessage?: string };
				const text = data.errorMessage && !data.text.includes(data.errorMessage)
					? `${data.errorMessage}\n\n${data.text}` : data.text;
				ctx.ui.notify(text, data.errorMessage ? "error" : "info");
				return;
			}
			if (command === "share" || command.startsWith("share ")) {
				await runShareCommand(pi, ctx, command.slice("share".length).trim());
				return;
			}
			if (command === "label" || command.startsWith("label ")) {
				const parsed = parseLabels(command.slice("label".length));
				if (!parsed) {
					ctx.ui.notify("Usage: /consult label <id> used yes|no|unknown [helped yes|no|unknown] (either field first)", "error");
					return;
				}
				if (!listConsultations(ctx.sessionManager.getBranch()).some((r) => r.id === parsed.id)) {
					ctx.ui.notify("Consultation ID not found on this session branch. Run /consult recent.", "error");
					return;
				}
				recordLabels(pi, parsed.id, parsed.labels);
				ctx.ui.notify(`Saved outcome for ${parsed.id}.`, "info");
				return;
			}
			await runConsultConfigurator(ctx, { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		},
	});
}

function formatLabel(value: boolean | null | undefined): string {
	return value === undefined || value === null ? "unknown" : value ? "yes" : "no";
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
		`Run /consult (no args) to edit settings; /consult recent to view IDs and labels.`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
