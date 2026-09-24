import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readSelectedAttachments, parseAttachmentPaths, attachmentPreview, MAX_ATTACHMENTS_BYTES } from "./attachments.js";
import { resolveAdvisor } from "./advisor.js";
import { loadConfig, type BpxConsultConfig, type ConsultMode } from "./config.js";
import { executeCouncil, resolveCouncilMembers } from "./council.js";
import { executeDebate } from "./debate.js";
import { gutCheckConfig } from "./gut-check.js";
import { consultationOrigin, isCurrentOrigin, newConsultationId, recordConsultation } from "./outcomes.js";
import { resolvePersona } from "./personas.js";
import { resolveSeatRoute } from "./route.js";
import { executeSolo } from "./solo.js";

const MODES = ["solo", "gut-check", "council", "debate"] as const;
export const SHARE_RESULT_TYPE = "bpx-consult-share-result";

/** Resolve actual configured recipients before asking the user to share file bytes. */
function recipientLabels(mode: ConsultMode, config: BpxConsultConfig, ctx: ExtensionCommandContext): string[] {
	const lookup = (key: string | undefined) => resolveAdvisor(ctx, key);
	const label = (seat: Parameters<typeof resolveSeatRoute>[1]): string => {
		const route = resolveSeatRoute(config, seat, lookup);
		if (route.kind === "error") throw new Error(route.message);
		if (route.kind === "cli") throw new Error("Selected-file sharing requires inline advisor routes; CLI seats can read beyond selected files.");
		return route.label;
	};
	if (mode === "solo" || mode === "gut-check") {
		const effective = mode === "gut-check" ? gutCheckConfig(config) : config;
		const solo = effective.modes?.solo;
		const route = resolveSeatRoute(effective, { ...solo, model: solo?.model }, lookup);
		if (route.kind === "error") throw new Error(route.message);
		if (route.kind === "cli") throw new Error("Selected-file sharing requires inline advisor routes; CLI seats can read beyond selected files.");
		return [route.label];
	}
	if (mode === "council") {
		const names = config.modes?.council?.members ?? [];
		if (!names.length) throw new Error("No council members configured.");
		const personas = names.map((name) => {
			const persona = resolvePersona(name, config.personas as never);
			if (!persona) throw new Error(`Unknown council persona: ${name}`);
			return persona;
		});
		const members = resolveCouncilMembers(personas, config, lookup);
		if (members.resolved.some((member) => member.kind === "cli")) throw new Error("Selected-file sharing requires inline advisor routes; CLI seats can read beyond selected files.");
		if (!members.resolved.length) throw new Error("No council members can receive selected files.");
		const synth = label({ ...config.modes?.council?.synthesizer, model: config.modes?.council?.synthesizer?.model });
		return [...members.resolved.map((m) => `${m.persona.name}: ${m.modelLabel} (file contents)`), `synthesizer: ${synth} (member answers, which may quote files)`];
	}
	const advocatePersona = resolvePersona(config.modes?.debate?.advocate ?? "architect", config.personas as never);
	const criticPersona = resolvePersona(config.modes?.debate?.critic ?? "critic", config.personas as never);
	if (!advocatePersona || !criticPersona) throw new Error("Debate persona not configured.");
	const soloModel = config.modes?.solo?.model;
	return [
		`advocate: ${label({ ...config.personas?.[advocatePersona.name], model: advocatePersona.defaultModel ?? soloModel })} (file contents)`,
		`critic: ${label({ ...config.personas?.[criticPersona.name], model: criticPersona.defaultModel ?? soloModel })} (file contents)`,
		`synthesizer: ${label({ ...config.modes?.council?.synthesizer, model: config.modes?.council?.synthesizer?.model ?? soloModel })} (debate transcript, which may quote files)`,
	];
}

/** User-only sharing flow: exact local selection, preview, affirmative consent, dispatch. */
export async function runShareCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, requestedMode: string): Promise<void> {
	if (!ctx.hasUI || !ctx.isProjectTrusted()) {
		ctx.ui.notify("/consult share requires a trusted project and interactive or RPC confirmation.", "error");
		return;
	}
	const config = loadConfig({ cwd: ctx.cwd, projectTrusted: true });
	if (!config.enabled) {
		ctx.ui.notify("Consult is disabled.", "error");
		return;
	}
	const origin = consultationOrigin(ctx);
	const selectedMode = requestedMode || await ctx.ui.select("Share files with which advisor mode?", [...MODES]);
	if (!selectedMode || !isCurrentOrigin(ctx, origin)) return;
	if (!MODES.includes(selectedMode as ConsultMode)) {
		ctx.ui.notify("Usage: /consult share [solo|gut-check|council|debate]", "error");
		return;
	}
	const mode = selectedMode as ConsultMode;
	try {
		const recipients = recipientLabels(mode, config, ctx);
		const question = await ctx.ui.input("Question for advisor (empty for general review)");
		if (question === undefined || !isCurrentOrigin(ctx, origin)) return;
		const selection = await ctx.ui.editor("Exact file paths, one per line (including .diff/.patch files)", "");
		if (selection === undefined || !isCurrentOrigin(ctx, origin)) return;
		// Entering paths explicitly authorizes a bounded local read for preview.
		const files = await readSelectedAttachments(ctx.cwd, parseAttachmentPaths(selection));
		if (!isCurrentOrigin(ctx, origin)) return;
		const preview = attachmentPreview(files);
		const approved = await ctx.ui.confirm(
			"Send selected files to advisor?",
			`Mode: ${mode}\nReceivers: ${recipients.join(", ")}\nTotal: ${files.reduce((n, f) => n + f.bytes, 0)} / ${MAX_ATTACHMENTS_BYTES} bytes\n\n${preview}\n\nFull selected contents (not only preview) will be sent. No secret scan; previous session context may also be shared.`,
		);
		if (!approved || !isCurrentOrigin(ctx, origin) || !ctx.isProjectTrusted()) return;
		const input = { ctx, config, signal: ctx.signal, onUpdate: undefined, question: question.trim() || undefined, attachments: files };
		const result = mode === "council" ? await executeCouncil(input)
			: mode === "debate" ? await executeDebate(input)
			: await executeSolo({ ...input, config: mode === "gut-check" ? gutCheckConfig(config) : config });
		if (!isCurrentOrigin(ctx, origin)) return;
		const id = newConsultationId();
		const failure = result.details?.errorMessage ||
			(result.details?.stopReason === "error" || result.details?.stopReason === "aborted"
				? `Advisor ${result.details.stopReason}.` : undefined);
		const text = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim() || failure || "Advisor returned no text.";
		// Custom entries are stored locally but excluded from Pi's model context.
		// sendMessage(show) would reintroduce quoted file contents on a later turn.
		if (failure) {
			pi.appendEntry(SHARE_RESULT_TYPE, { id, text, errorMessage: failure });
			ctx.ui.notify(`Selected-file consult failed (${id}): ${failure}${text === failure ? "" : `\n\n${text}`}`, "error");
			return;
		}
		recordConsultation(pi, id, mode, "share");
		pi.appendEntry(SHARE_RESULT_TYPE, { id, text });
		ctx.ui.notify(`Selected-file consult ${id}:\n\n${text}`, "info");
	} catch (error) {
		if (!isCurrentOrigin(ctx, origin)) return;
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}
