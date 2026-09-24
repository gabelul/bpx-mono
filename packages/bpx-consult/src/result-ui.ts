import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

interface UiDetails {
	mode?: string;
	requestedMode?: string;
	advisorModel?: string;
	members?: Array<{ persona: string; model: string; status: string }>;
	synthesizer?: string;
	advocate?: string;
	critic?: string;
	rounds?: number;
	steps?: Array<{ round: number; role: string; status: string }>;
	phase?: string;
	disagreement?: string;
	consultationId?: string;
	errorMessage?: string;
	fittedTokens?: number;
	omitted?: number;
	reportedUsage?: ReportedUsage;
}

interface ReportedUsage {
	input: number;
	output: number;
	cost?: { total?: number };
}

/** Keep display identity separate from Solo's gut-check execution details. */
function displayMode(details: UiDetails, requested?: string): string {
	return details.requestedMode ?? (details.mode === "disabled" || details.mode === "capped"
		? requested ?? "configured mode" : requested === "gut-check" ? requested : details.mode ?? requested ?? "default");
}

/** Show concrete route and progress, not an uncalibrated confidence badge. */
function routeSummary(details: UiDetails, mode: string): string {
	if (mode === "solo" || mode === "gut-check") return details.advisorModel ?? "route unresolved";
	if (mode === "council") {
		const members = Array.isArray(details.members) ? details.members : [];
		const completed = members.filter((member) => member.status === "ok").length;
		return `${completed}/${members.length} members replied · synthesis: ${details.synthesizer ?? "unresolved"}`;
	}
	if (mode === "debate") return `${details.rounds ?? "?"} rounds · ${details.advocate ?? "?"} vs ${details.critic ?? "?"}`;
	return details.advisorModel ?? "no route";
}

/** Render one readable tool call; final mode may come from saved default config. */
export function renderConsultCall(args: { mode?: string; question?: string }, theme: Theme): Text {
	const mode = args.mode ?? "configured mode";
	const question = args.question?.trim();
	return new Text(`${theme.fg("accent", theme.bold("consult"))}${theme.fg("dim", ` / ${mode}`)}${question ? `\n${theme.fg("dim", question)}` : ""}`, 0, 0);
}

/** Render response and diagnostics without changing what the executor receives. */
export function renderConsultResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	requestedMode?: string,
): Container {
	const raw = result.details;
	const details: UiDetails = raw && typeof raw === "object" ? raw as UiDetails : {};
	const mode = displayMode(details, requestedMode);
	const content = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text).join("\n").trim();
	const members = Array.isArray(details.members) ? details.members : [];
	const failures = members.filter((member) => member.status === "error").length;
	const status = options.isPartial ? "working" : details.mode === "disabled" || details.mode === "capped"
		? details.mode : details.errorMessage ? "failed" : failures ? "partial" : "ready";
	const color = status === "failed" ? "error" : status === "partial" || status === "capped" ? "warning"
		: status === "working" ? "accent" : status === "disabled" ? "dim" : "success";
	const view = new Container();
	view.addChild(new Text(`${theme.fg("accent", theme.bold("consult"))}${theme.fg("dim", ` / ${mode}`)}  ${theme.fg(color, status)}`, 0, 0));
	view.addChild(new Text(theme.fg("dim", details.phase ?? routeSummary(details, mode)), 0, 0));
	if (options.isPartial) {
		if (options.expanded && members.length) {
			view.addChild(new Text(theme.fg("dim", members.map((member) =>
				`${member.persona}: ${member.status} · ${member.model}`).join("\n")), 0, 0));
		}
		return view;
	}

	if (options.expanded) {
		const receipt = [
			`To executor · tool result${details.consultationId ? ` · ${details.consultationId}` : ""}`,
			...members.map((member) => `${member.persona}: ${member.model} (${member.status})`),
			...(mode === "debate" ? [`Synthesis: ${details.synthesizer ?? "unresolved"}`] : []),
			...(details.disagreement ? [`Disagreement: ${details.disagreement}`] : []),
			...(typeof details.fittedTokens === "number" ? [`Context: ~${details.fittedTokens} tokens${details.omitted ? ` · ${details.omitted} omitted` : ""}`] : []),
		];
		const usage = details.reportedUsage;
		if (usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
			receipt.push(`Reported usage: ${usage.input} in · ${usage.output} out${typeof usage.cost?.total === "number" ? ` · $${usage.cost.total.toFixed(4)}` : ""}`);
		}
		view.addChild(new Text(theme.fg("dim", receipt.join("\n")), 0, 0));
	}
	view.addChild(new Markdown(content || "No advisor text returned.", 0, 0, getMarkdownTheme()));
	return view;
}
