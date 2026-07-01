/**
 * bpx-consult — Pi extension entry point.
 *
 * Registers the `consult()` tool and the `/consult` command. When the executor
 * calls consult() with no args, solo runs (one advisor model, context-fitted).
 * mode: "council" | "debate" | "gut-check" select the other modes.
 *
 * Config persists at ~/.pi/agent/bpx-consult.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isDisabledForModel, loadConfig } from "./src/config.js";
import { executeSolo } from "./src/solo.js";
import { executeCouncil } from "./src/council.js";
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
	registerConsultTool(pi);
	registerConsultCommand(pi);
}

function registerConsultTool(pi: ExtensionAPI): void {
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

			const mode = params.mode ?? config.defaultMode ?? "solo";

			if (mode === "council") {
				return executeCouncil({ ctx, config, signal, onUpdate, question: params.question });
			}

			// solo/gut-check/debate: solo wired; debate fast-follow. Gut-check is a
			// cheap solo entry once modes.gutCheck is honored — for now it routes to
			// solo (still useful, just not terse-tagged yet).
			return executeSolo({ ctx, config, signal, onUpdate, question: params.question });
		},
	});
}

function registerConsultCommand(pi: ExtensionAPI): void {
	pi.registerCommand("consult", {
		description: "Configure bpx-consult: status, model, mode, or toggle on/off.",
		async handler(_args, ctx) {
			// Minimal v1: status read-out. The full fuzzy model-picker (lifted from
			// rpiv-advisor/advisor-ui.ts + fuzzy.ts) lands with the picker step.
			const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const solo = config.modes?.solo;
			const lines = [
				`bpx-consult status`,
				`  enabled    : ${config.enabled ?? true}`,
				`  defaultMode: ${config.defaultMode}`,
				`  solo model : ${solo?.model ?? "(none)"}`,
				`  effort     : ${solo?.thinkingLevel ?? "(default)"}`,
				`  triggers   : onDone=${config.triggers?.onDone ?? false}, whenStuck=${config.triggers?.whenStuck ?? 3}`,
				``,
				`Edit ~/.pi/agent/bpx-consult.json to change settings.`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
