/**
 * consult-ui — the interactive /consult configurator.
 *
 * A two-level menu built on the filterable-picker primitive (picker.ts):
 *
 *   /consult  →  main menu (one row per editable setting, current value shown)
 *             →  sub-picker (model list / effort list / mode list / on-off)
 *             →  persist immediately, then re-open the menu
 *
 * Loop-back means a user can set mode + solo model + council seats + triggers
 * in one session without re-typing /consult. Persist-after-every-change
 * (saveConfig) means a crash mid-session never loses a pick — same
 * persist-before-mutate discipline rpiv-advisor uses.
 *
 * What's exposed: default mode, solo + gut-check model/effort, each council
 * persona's model (iterated dynamically so user-defined personas show), the
 * synthesizer model, both triggers, and enable/disable. Advanced settings
 * (contextBudget char caps, timeouts, backends, disabledForModels) stay in the
 * config file — they're rarely touched and a TUI for them would be tedious.
 */

import { existsSync } from "node:fs";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "@juicesharp/rpiv-config";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { BpxConsultConfig } from "./config.js";
import { loadConfig, projectConfigPath, resolvePersonaBackend, resolveSeatBackend, saveConfig, type LoadConfigOptions } from "./config.js";
import { callAdvisor, clampThinkingLevel, resolveAdvisor } from "./advisor.js";
import { callCliAdvisor, cliContextWindow, type CliBackendConfig } from "./cli-backend.js";
import type { CodexModel } from "./codex-models.js";
import { listCliModels } from "./cli-models.js";
import { resolveSeatRoute } from "./route.js";
import { ADVISOR_SYSTEM_PROMPT } from "./solo.js";
import { gutCheckConfig } from "./gut-check.js";
import { SYNTHESIZER_SYSTEM_PROMPT } from "./council.js";
import { withTimeout } from "./timeout.js";
import { personaSystemPrompt, resolvePersona, type Persona } from "./personas.js";
import { buildGeneratePrompt, GEN_SYSTEM_PROMPT, parsePersonaJson, sanitizeName } from "./persona-gen.js";
import { showFilterablePicker } from "./picker.js";

const CHECKMARK = " ✓";
const MENU_DONE = "__done__";
const MENU_BACK = "__back__";

const MODES = ["solo", "council", "debate", "gut-check"] as const;
const BASE_EFFORT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const WHEN_STUCK_CHOICES = [0, 2, 3, 5, 8];

const MSG_REQUIRES_UI = "/consult needs an interactive terminal. Edit ~/.pi/agent/bpx-consult.json instead.";
const MSG_NO_MODELS = "No models are available. Run /login to auth a provider, then /consult again.";
const MSG_PERSIST_FAILED = "Couldn't save ~/.pi/agent/bpx-consult.json. Your change wasn't kept.";
const MSG_SAVED = (what: string) => `Saved — ${what}`;

// ---------------------------------------------------------------------------
// Item builders (pure — exported for testing)
// ---------------------------------------------------------------------------

/** Model picker items: one per available model, current marked, plus a clear. */
export function buildModelItems(available: Model<Api>[], currentKey: string | undefined): SelectItem[] {
	if (available.length === 0) {
		return [{ value: "__none__", label: "(no models available — run /login)" }];
	}
	const items: SelectItem[] = available.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
	return items;
}

/** CLI model choices never borrow Pi's registry; preserve saved unlisted IDs. */
export function buildCliModelItems(command: string, available: CodexModel[], current: string | undefined): SelectItem[] {
	const items: SelectItem[] = [
		{ value: "__codex_default__", label: `Use ${command} configured default${current ? "" : CHECKMARK}` },
	];
	if (current && !available.some((model) => model.id === current)) {
		items.push({ value: current, label: `${current} (saved, not listed)${CHECKMARK}` });
	}
	for (const model of available) {
		items.push({ value: model.id, label: `${model.displayName}  (${model.id}${model.contextWindow ? `, ${model.contextWindow} tokens` : ""})${model.id === current ? CHECKMARK : ""}` });
	}
	items.push({ value: "__codex_manual__", label: "Enter model ID manually…" });
	if (command !== "claude") items.push({ value: "__codex_refresh__", label: `Refresh ${command} models…` });
	return items;
}

/** Backwards-compatible Codex picker item builder. */
export function buildCodexModelItems(available: CodexModel[], current: string | undefined): SelectItem[] {
	return buildCliModelItems("codex", available, current);
}

/** Effort picker items, gated on the model's supported levels (xhigh only if supported). */
export function buildEffortItems(picked: Model<Api> | undefined, current: ThinkingLevel | undefined): SelectItem[] {
	const supported = picked ? getSupportedThinkingLevels(picked) : BASE_EFFORT_LEVELS;
	const levels = supported.includes("xhigh") ? [...BASE_EFFORT_LEVELS, "xhigh"] : BASE_EFFORT_LEVELS;
	return levels.map((level) => ({
		value: level,
		label: level === current ? `${level}${CHECKMARK}` : level,
	}));
}

/** Mode picker items. */
export function buildModeItems(current: string | undefined): SelectItem[] {
	return MODES.map((mode) => ({
		value: mode,
		label: mode === current ? `${mode}${CHECKMARK}` : mode,
	}));
}

/** Boolean toggle items. */
export function buildToggleItems(current: boolean): SelectItem[] {
	return [
		{ value: "true", label: current === true ? `on${CHECKMARK}` : "on" },
		{ value: "false", label: current === false ? `off${CHECKMARK}` : "off" },
	];
}

/** whenStuck count items (0 = off). */
export function buildWhenStuckItems(current: number | undefined): SelectItem[] {
	return WHEN_STUCK_CHOICES.map((n) => {
		const label = n === 0 ? "off" : String(n);
		return { value: String(n), label: n === current ? `${label}${CHECKMARK}` : label };
	});
}

/** Debate rounds items (schema caps at 4). */
export function buildRoundsItems(current: number | undefined): SelectItem[] {
	return [1, 2, 3, 4].map((n) => ({ value: String(n), label: n === current ? `${n}${CHECKMARK}` : String(n) }));
}

/** Persona-name items for role assignment (debate advocate/critic). */
export function buildPersonaItems(names: string[], current: string | undefined): SelectItem[] {
	return names.map((name) => ({ value: name, label: name === current ? `${name}${CHECKMARK}` : name }));
}

/** Stance picker items (for/against/neutral — biases what a persona hunts for). */
export function buildStanceItems(current: string | undefined): SelectItem[] {
	return (["for", "against", "neutral"] as const).map((stance) => ({
		value: stance,
		label: stance === current ? `${stance}${CHECKMARK}` : stance,
	}));
}

/**
 * Council submenu items: seated members, roster management, synthesizer, back.
 * Members come from `council.members` (the roster); re-enable candidates are
 * personas that exist but aren't seated.
 */
export function buildCouncilMenu(config: BpxConsultConfig): SelectItem[] {
	const members = config.modes?.council?.members ?? [];
	const synth = config.modes?.council?.synthesizer;
	const items: SelectItem[] = [];
	for (const name of members) {
		const p = config.personas?.[name] ?? {};
		// Route visibility (council §4): show the effective backend next to the model
		// so a user can see at a glance who's inline vs CLI-routed.
		const route = describePersonaBackend(config, p);
		items.push({ value: `member.${name}`, label: `${name} — model: ${describeMemberModel(config, p)}  [${route}]` });
	}
	// Four fixed rows instead of seven: seat/unseat merged into one toggle,
	// the two add flows merged behind one entry, synthesizer model+effort
	// collapsed into a detail submenu.
	items.push({ value: "testAll", label: members.length ? `Test all seated members… (${members.length})` : "(no members seated to test)" });
	items.push({ value: "seats", label: "Seat or unseat personas…" });
	items.push({ value: "add", label: "Add persona…" });
	items.push({ value: "council.synth", label: `Synthesizer — ${describeSeatRoute(config, synth ?? {})}, thinking ${synth?.thinkingLevel ?? "default"}` });
	items.push({ value: MENU_BACK, label: "Back" });
	return items;
}

/** The narrow CLI presets the menu offers (council §2). Custom commands stay JSON-only. */
const CLI_PRESETS = ["codex", "claude", "opencode"] as const;

/** Council falls back to solo.model when a persona has no explicit model. */
function effectiveMemberBackend(config: BpxConsultConfig, persona: { backend?: unknown; defaultModel?: string; codexModel?: string; cliModels?: Record<string, string>; cliWindows?: Record<string, number> }) {
	return resolvePersonaBackend(config, { ...persona, defaultModel: persona.defaultModel ?? config.modes?.solo?.model });
}

/** Human label for a persona's effective route, including the solo-model fallback. */
export function describePersonaBackend(config: BpxConsultConfig, persona: { backend?: unknown; defaultModel?: string; codexModel?: string; cliModels?: Record<string, string>; cliWindows?: Record<string, number> }): string {
	const b = effectiveMemberBackend(config, persona);
	if (b?.type === "cli") return `cli:${b.command}`;
	return "inline";
}

/** Show the model the effective route will use, not an inactive inline choice. */
function describeMemberModel(config: BpxConsultConfig, persona: { backend?: unknown; defaultModel?: string; codexModel?: string; cliModels?: Record<string, string>; cliWindows?: Record<string, number> }): string {
	const backend = effectiveMemberBackend(config, persona);
	if (backend?.type !== "cli") return describeModel(persona.defaultModel ?? config.modes?.solo?.model);
	if ((CLI_PRESETS as readonly string[]).includes(backend.command) && !backend.args?.length) return backend.model ?? `${backend.command === "codex" ? "Codex" : backend.command} configured default`;
	return "CLI-managed";
}

/** Parse a comma-separated args string into a structured argv array (never a shell
 * string — spawn uses argv, so this is injection-safe by construction). Empty/
 * blank entries dropped. */
export function parseCliArgs(input: string | undefined): string[] | undefined {
	if (!input || !input.trim()) return undefined;
	const args = input.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
	return args.length > 0 ? args : undefined;
}

/** Parse a required positive-integer context window. Returns null when absent or
 * not a positive int — the caller must reject (no silent fallback, per the
 * window-safety rule). */
export function parseContextWindow(input: string | undefined): number | null {
	if (!input || !input.trim()) return null;
	const n = Number(input.trim());
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

/** Backend picker items: inline, the three CLI presets, custom, remove route. */
export function buildBackendItems(config: BpxConsultConfig, persona: { backend?: unknown; defaultModel?: string; codexModel?: string }): SelectItem[] {
	const current = describePersonaBackend(config, persona);
	const items: SelectItem[] = [{ value: "inline", label: current === "inline" ? `inline${CHECKMARK}` : "inline" }];
	for (const cmd of CLI_PRESETS) {
		const route = `cli:${cmd}`;
		items.push({ value: route, label: current === route ? `${route}${CHECKMARK}` : route });
	}
	items.push({ value: "__custom__", label: "Custom CLI… (command + args + context window)" });
	items.push({ value: "__remove__", label: "remove route (fall back to inline / legacy config)" });
	return items;
}

// ---------------------------------------------------------------------------
// Main menu (one row per setting, current value surfaced in the label)
// ---------------------------------------------------------------------------

function describeModel(key: string | undefined): string {
	if (!key) return "(default)";
	const parsed = parseModelKey(key);
	return parsed ? parsed.modelId : key;
}

export function buildMainMenu(config: BpxConsultConfig): SelectItem[] {
	const solo = config.modes?.solo;
	const gut = config.modes?.gutCheck;
	const debate = config.modes?.debate;
	const rounds = debate?.rounds ?? 2;
	// One summary line per mode — progressive disclosure without hiding anything.
	// Each line opens a detail submenu (model/effort for solo+gut, roles+rounds
	// for debate), the same pattern as Council members…. Every mode's settings
	// stay reachable regardless of which mode is the default, because explicit
	// mode requests still use them.
	const items: SelectItem[] = [
		{ value: "defaultMode", label: `Default mode: ${config.defaultMode ?? "solo"}` },
		{ value: "solo.detail", label: `Solo — ${describeSeatRoute(config, solo ?? {})}${resolveSeatBackend(config, solo ?? {})?.type === "cli" ? "" : `, thinking ${solo?.thinkingLevel ?? "default"}`}` },
		{ value: "gutCheck.detail", label: `Gut-check — ${describeSeatRoute(config, gutCheckConfig(config).modes?.solo ?? {})}${resolveSeatBackend(config, gutCheckConfig(config).modes?.solo ?? {})?.type === "cli" ? "" : `, thinking ${gut?.thinkingLevel ?? "default"}`}` },
		{
			value: "debate.detail",
			label: `Debate — ${debate?.advocate ?? "(unassigned)"} vs ${debate?.critic ?? "(unassigned)"}, ${rounds} round${rounds === 1 ? "" : "s"}`,
		},
		{ value: "council.manage", label: "Council members…" },
		{ value: "triggers.onDone", label: `Trigger — onDone: ${config.triggers?.onDone ? "on" : "off"}` },
		{ value: "triggers.whenStuck", label: `Trigger — whenStuck: ${!config.triggers?.whenStuck ? "off" : `${config.triggers.whenStuck} attempts`}` },
		{ value: "enabled", label: `Enabled: ${config.enabled === false ? "off" : "on"}` },
		{ value: MENU_DONE, label: "Done" },
	];
	return items;
}

/**
 * Detail submenu for a single-model mode (solo or gut-check): model + thinking
 * level. Loops until Back, persisting + reloading after each change so labels
 * and the parent menu always reflect disk.
 */
async function runModeDetail(
	ctx: ExtensionContext,
	options: RunOptions,
	available: Model<Api>[],
	mode: "solo" | "gutCheck",
): Promise<void> {
	const label = mode === "solo" ? "Solo" : "Gut-check";
	await runSeatDetail(ctx, options, available, label, ADVISOR_SYSTEM_PROMPT,
		(config) => mode === "gutCheck" ? gutCheckConfig(config).modes?.solo ?? {} : config.modes?.solo ?? {},
		(config, seat) => {
			config.modes ??= {};
			if (mode === "gutCheck" && !config.modes.gutCheck?.model && seat.model === config.modes.solo?.model) {
				const { model: _inherited, ...rest } = seat;
				config.modes.gutCheck = rest;
			} else config.modes[mode] = seat;
		});
}

type EditableSeat = NonNullable<NonNullable<BpxConsultConfig["modes"]>["solo"]> & { codexModel?: string };

/** Probe an unsaved seat using the same route resolver as live calls. */
async function probeEditableSeat(ctx: ExtensionContext, config: BpxConsultConfig, seat: EditableSeat, label: string, prompt: string) {
	const route = resolveSeatRoute(config, seat, (key) => resolveAdvisor(ctx, key));
	if (route.kind === "error") return { ok: false, detail: route.message };
	const persona: Persona = { name: label, systemPrompt: prompt, stance: "neutral", defaultModel: seat.model, thinkingLevel: seat.thinkingLevel };
	return route.kind === "cli" ? probeCliBackend(ctx, route.backend, persona) : probeInlineModel(ctx, seat.model, persona);
}

/** Offer a route-accurate candidate probe before writing a model or backend. */
async function confirmEditableSeat(ctx: ExtensionContext, config: BpxConsultConfig, seat: EditableSeat, label: string, prompt: string): Promise<boolean> {
	const action = await showFilterablePicker(ctx, {
		title: `Assign ${label} route?`,
		proseLines: [`Prospective route: ${describeSeatRoute(config, seat)}`],
		items: [{ value: "assign", label: "Assign now" }, { value: "test", label: "Test this route first" }, { value: "cancel", label: "Cancel" }],
	});
	if (action === null || action === "cancel") return false;
	if (action === "assign") return true;
	const result = await probeEditableSeat(ctx, config, seat, label, prompt);
	ctx.ui.notify(`${result.ok ? "✓" : "✗"} ${label}: ${result.detail}`, result.ok ? "info" : "error");
	if (!result.ok) return false;
	return await showFilterablePicker(ctx, {
		title: `${label}: ${result.detail}`,
		items: [{ value: "assign", label: "Assign this route" }, { value: "back", label: "Back" }],
	}) === "assign";
}

/** Human label for a mode seat, not an inactive Pi model. */
function describeSeatRoute(config: BpxConsultConfig, seat: EditableSeat): string {
	const backend = resolveSeatBackend(config, seat);
	if (backend?.type !== "cli") return `inline/${describeModel(seat.model)}`;
	if (backend.args?.length || !(CLI_PRESETS as readonly string[]).includes(backend.command)) return `cli:${backend.command} (args/config-managed)`;
	return backend.model ? `cli:${backend.command}/${backend.model}` : `cli:${backend.command} (configured default)`;
}

/** Shared backend-first editor for Solo, gut-check, and synthesizer seats. */
async function runSeatDetail(
	ctx: ExtensionContext,
	options: RunOptions,
	available: Model<Api>[],
	label: string,
	prompt: string,
	getSeat: (config: BpxConsultConfig) => EditableSeat,
	setSeat: (config: BpxConsultConfig, seat: EditableSeat) => void,
): Promise<void> {
	let config = options.config ?? loadConfig(options);
	for (;;) {
		const seat = getSeat(config);
		const backend = resolveSeatBackend(config, seat);
		const inline = backend?.type !== "cli";
		const selectable = backend?.type === "cli" && (CLI_PRESETS as readonly string[]).includes(backend.command) && !backend.args?.length;
		const choice = await showFilterablePicker(ctx, {
			title: `${label} mode`,
			proseLines: [`Route: ${describeSeatRoute(config, seat)}`],
			items: [
				{ value: "backend", label: `Set backend… (${backend?.type === "cli" ? `cli:${backend.command}` : "inline"})` },
				...(inline || selectable ? [{ value: "model", label: "Set model…" }] : []),
				...(inline ? [{ value: "effort", label: `Thinking level: ${seat.thinkingLevel ?? "(default)"}` }] : []),
				...(backend?.type === "cli" ? [{ value: "window", label: `Context window: ${cliContextWindow(backend) ?? "unknown"} tokens…` }] : []),
				{ value: "test", label: "Test this route…" },
				{ value: MENU_BACK, label: "Back" },
			],
		});
		if (choice === null || choice === MENU_BACK) return;
		if (choice === "test") {
			const result = await probeEditableSeat(ctx, config, seat, label, prompt);
			ctx.ui.notify(`${result.ok ? "✓" : "✗"} ${label}: ${result.detail}`, result.ok ? "info" : "error");
			continue;
		}
		let candidate: EditableSeat | undefined;
		if (choice === "backend") {
			const picked = await showFilterablePicker(ctx, {
				title: `Backend for ${label}`,
				items: buildBackendItems(config, { ...seat, defaultModel: seat.model }),
			});
			if (picked === null) continue;
			if (picked === "__custom__") {
				const custom = await runCustomCliFlow(ctx, { name: label, systemPrompt: prompt, stance: "neutral" });
				if (!custom) continue;
				candidate = { ...seat, backend: custom };
			} else if (picked === "__remove__") {
				const { backend: _removed, ...rest } = seat;
				candidate = rest;
			} else {
				candidate = { ...seat, backend: picked === "inline" ? { type: "inline" } : { type: "cli", command: picked.slice(4) } };
				if (picked === "cli:opencode") {
					candidate = await selectCliSeatModel(ctx, candidate, { type: "cli", command: "opencode" }) ?? undefined;
				}
			}
		} else if (choice === "model") {
			if (selectable && backend?.type === "cli") {
				candidate = await selectCliSeatModel(ctx, seat, backend) ?? undefined;
			} else {
				const picked = await pickModel(ctx, available, seat.model, `${label} model`);
				if (picked === null) continue;
				candidate = { ...seat, model: picked };
			}
		} else if (choice === "effort") {
			const picked = await showFilterablePicker(ctx, {
				title: `${label} thinking level`,
				items: buildEffortItems(resolveReferencedModel(available, seat.model), seat.thinkingLevel),
				preferredValue: seat.thinkingLevel,
			});
			if (picked === null) continue;
			candidate = { ...seat, thinkingLevel: picked as ThinkingLevel };
		} else if (choice === "window" && backend?.type === "cli") {
			const raw = await ctx.ui.input("CLI context window in tokens", String(cliContextWindow(backend) ?? ""));
			const window = parseContextWindow(raw ?? undefined);
			if (window === null) { ctx.ui.notify("Enter a positive-integer context window.", "error"); continue; }
			candidate = { ...seat, backend: { ...backend, contextWindow: window } };
		}
		if (!candidate || !await confirmEditableSeat(ctx, config, candidate, label, prompt)) continue;
		setSeat(config, candidate);
		if (!persist(ctx, config, options)) return;
		config = loadConfig(options);
	}
}

/** Prose for a debate-role picker: what the role does + whose model does the work. */
export function debateRoleProse(config: BpxConsultConfig, role: "advocate" | "critic"): string[] {
	const name = role === "advocate" ? config.modes?.debate?.advocate : config.modes?.debate?.critic;
	const roleLine =
		role === "advocate"
			? "The advocate argues FOR the change — it can still conclude don't, but its job is the strongest case."
			: "The critic hunts for flaws, missing requirements, and cheap objections in the advocate's case.";
	if (!name) {
		return [roleLine, "No persona assigned yet — pick one below."];
	}
	const persona = (config.personas ?? {})[name] ?? {};
	return [
		roleLine,
		`Picking a persona assigns the role — ${name} runs ${describeMemberModel(config, persona)} through ${describePersonaBackend(config, persona)}. Edit that seat under Council members.`,
	];
}

/**
 * Detail submenu for debate mode: advocate persona, critic persona, rounds.
 * Role pickers explain the role + name the model that will run it, so the
 * silent role-save is never a surprise.
 */
async function runDebateDetail(ctx: ExtensionContext, options: RunOptions, available: Model<Api>[]): Promise<void> {
	let config = options.config ?? loadConfig(options);
	for (;;) {
		config.modes ??= {};
		config.modes.debate ??= {};
		const d = config.modes.debate;
		const choice = await showFilterablePicker(ctx, {
			title: "Debate mode",
			proseLines: ["Two personas argue the question, then the synthesizer merges. Each round is one advocate turn plus one critic turn."],
			items: [
				{ value: "advocate", label: `Advocate: ${d.advocate ?? "(unassigned)"}${d.advocate ? ` [${describePersonaBackend(config, config.personas?.[d.advocate] ?? {})}]` : ""}` },
				{ value: "critic", label: `Critic: ${d.critic ?? "(unassigned)"}${d.critic ? ` [${describePersonaBackend(config, config.personas?.[d.critic] ?? {})}]` : ""}` },
				...(d.advocate ? [{ value: "advocate.route", label: `Edit ${d.advocate} backend/model…` }] : []),
				...(d.critic ? [{ value: "critic.route", label: `Edit ${d.critic} backend/model…` }] : []),
				{ value: "rounds", label: `Rounds: ${d.rounds ?? 2}` },
				{ value: MENU_BACK, label: "Back" },
			],
		});
		if (choice === null || choice === MENU_BACK) return;
		if (choice === "advocate.route" || choice === "critic.route") {
			const name = choice === "advocate.route" ? d.advocate : d.critic;
			if (name) await runMemberDetail(ctx, config, name, available, options);
			config = loadConfig(options);
			continue;
		}

		if (choice === "advocate" || choice === "critic") {
			const isAdvocate = choice === "advocate";
			const currentRole = isAdvocate ? d.advocate : d.critic;
			const picked = await showFilterablePicker(ctx, {
				title: isAdvocate ? "Debate advocate" : "Debate critic",
				proseLines: debateRoleProse(config, choice === "advocate" ? "advocate" : "critic"),
				items: buildPersonaItems(Object.keys(config.personas ?? {}), currentRole),
				preferredValue: currentRole,
			});
			if (picked === null) continue;
			if (isAdvocate) d.advocate = picked;
			else d.critic = picked;
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`${isAdvocate ? "debate advocate" : "debate critic"} → ${picked}`, "info");
			continue;
		}

		// rounds
		const picked = await showFilterablePicker(ctx, {
			title: "Debate rounds",
			proseLines: ["Each round is one advocate turn plus one critic turn, then synthesis. More rounds = slower, deeper.", "Budget note: the debate-wide timeout (default 180s) still caps the whole run."],
			items: buildRoundsItems(d.rounds),
			preferredValue: String(d.rounds ?? 2),
		});
		if (picked === null) continue;
		d.rounds = Number(picked);
		if (!persist(ctx, config, options)) return;
		config = loadConfig(options);
	}
}

/**
 * Detail submenu for the council synthesizer: model + thinking level in one
 * place (previously two flat menu rows). Called once per consult to merge
 * member/debate output into the final verdict.
 */
async function runSynthDetail(ctx: ExtensionContext, options: LoadConfigOptions, available: Model<Api>[]): Promise<void> {
	await runSeatDetail(ctx, options, available, "Council synthesizer", SYNTHESIZER_SYSTEM_PROMPT,
		(config) => config.modes?.council?.synthesizer ?? {},
		(config, seat) => {
			config.modes ??= {};
			config.modes.council ??= {};
			config.modes.council.synthesizer = seat;
		});
}

// ---------------------------------------------------------------------------
// Model resolution + setters (mutate a config clone, return it for persist)
// ---------------------------------------------------------------------------

function findModel(available: Model<Api>[], key: string | undefined): Model<Api> | undefined {
	if (!key) return undefined;
	return available.find((m) => modelKey(m) === key);
}

/** Resolve the model a given setting currently points at, for effort gating. */
function resolveReferencedModel(available: Model<Api>[], key: string | undefined): Model<Api> | undefined {
	const found = findModel(available, key);
	if (found) return found;
	if (!key) return undefined;
	const parsed = parseModelKey(key);
	if (!parsed) return undefined;
	return available.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
}

async function pickModel(
	ctx: ExtensionContext,
	available: Model<Api>[],
	currentKey: string | undefined,
	title: string,
): Promise<string | null> {
	const choice = await showFilterablePicker(ctx, {
		title,
		proseLines: ["Pick the model for this seat. Type to filter by name or provider."],
		items: buildModelItems(available, currentKey),
		preferredValue: currentKey,
	});
	if (choice === null || choice === "__none__") return null;
	return choice;
}

// ---------------------------------------------------------------------------
// The configurator loop
// ---------------------------------------------------------------------------

export interface RunOptions extends LoadConfigOptions {
	/** Override the config source (testing). If omitted, loadConfig runs. */
	config?: BpxConsultConfig;
}

/**
 * Open the /consult configurator. Loops on the main menu until the user picks
 * Done or cancels (esc). Each setting change is persisted immediately.
 */
export async function runConsultConfigurator(ctx: ExtensionContext, options: RunOptions = {}): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_UI, "error");
		return;
	}

	const available = ctx.modelRegistry.getAvailable();
	// saveConfig writes the global file. Never copy merged project overrides into it.
	const editOptions: RunOptions = { ...options, projectTrusted: false };
	const projectOverridesActive = (options.projectTrusted ?? true) && options.cwd
		? existsSync(projectConfigPath(options.cwd)) : false;
	let config = options.config ?? loadConfig(editOptions);

	for (;;) {
		const choice = await showFilterablePicker(ctx, {
			title: "bpx-consult",
			proseLines: ["Edit global settings. Changes save immediately.",
				...(projectOverridesActive ? ["This project's .pi/bpx-consult.json may override these values at runtime."] : [])],
			items: buildMainMenu(config),
		});

		if (choice === null || choice === MENU_DONE) return;

		// Council roster management is a sub-loop that persists its own changes.
		if (choice === "council.manage") {
			await runCouncilSubmenu(ctx, editOptions, available);
			config = loadConfig(editOptions);
			continue;
		}

		// Mode detail submenus (same pattern — self-persisting loops).
		if (choice === "solo.detail" || choice === "gutCheck.detail") {
			await runModeDetail(ctx, editOptions, available, choice === "solo.detail" ? "solo" : "gutCheck");
			config = loadConfig(editOptions);
			continue;
		}
		if (choice === "debate.detail") {
			await runDebateDetail(ctx, editOptions, available);
			config = loadConfig(editOptions);
			continue;
		}

		const handled = await dispatch(ctx, choice, config, available);
		if (!handled) continue; // user cancelled the sub-picker — back to menu, no save

		if (!saveConfig(config)) {
			ctx.ui.notify(MSG_PERSIST_FAILED, "error");
			return;
		}
		// Reload global settings only; project overrides remain runtime-only here.
		config = loadConfig(editOptions);
		ctx.ui.notify(MSG_SAVED(handled), "info");
	}
}

/**
 * Dispatch a main-menu choice to its sub-picker, mutating `config` in place.
 * Returns a human label if the setting changed (→ caller persists + notifies),
 * or null if the user cancelled the sub-picker (→ no save, back to menu).
 */
async function dispatch(
	ctx: ExtensionContext,
	choice: string,
	config: BpxConsultConfig,
	available: Model<Api>[],
): Promise<string | null> {
	config.modes ??= {};
	config.modes.solo ??= {};
	config.modes.gutCheck ??= {};
	config.modes.council ??= {};
	config.modes.debate ??= {};
	config.triggers ??= {};

	switch (choice) {
		case "defaultMode": {
			const picked = await showFilterablePicker(ctx, {
				title: "Default mode",
				items: buildModeItems(config.defaultMode),
				preferredValue: config.defaultMode,
			});
			if (picked === null) return null;
			config.defaultMode = picked as BpxConsultConfig["defaultMode"];
			return `default mode → ${picked}`;
		}

		case "debate.advocate": // legacy value names — details moved to runDebateDetail
		case "debate.critic":
		case "debate.rounds":
		case "solo.model":
		case "solo.effort":
		case "gutCheck.model":
		case "gutCheck.effort":
			return null;

		case "triggers.onDone": {
			const picked = await showFilterablePicker(ctx, {
				title: "Trigger — onDone (review each finished turn)",
				items: buildToggleItems(config.triggers.onDone ?? false),
				preferredValue: String(config.triggers.onDone ?? false),
			});
			if (picked === null) return null;
			config.triggers.onDone = picked === "true";
			return `onDone → ${picked === "true" ? "on" : "off"}`;
		}

		case "triggers.whenStuck": {
			const picked = await showFilterablePicker(ctx, {
				title: "Trigger — whenStuck (loop/error count that fires a consult; off disables)",
				items: buildWhenStuckItems(config.triggers.whenStuck),
				preferredValue: String(config.triggers.whenStuck),
			});
			if (picked === null) return null;
			config.triggers.whenStuck = Number(picked);
			return `whenStuck → ${picked === "0" ? "off" : picked}`;
		}

		case "enabled": {
			const picked = await showFilterablePicker(ctx, {
				title: "Enable bpx-consult",
				items: buildToggleItems(config.enabled !== false),
				preferredValue: String(config.enabled !== false),
			});
			if (picked === null) return null;
			config.enabled = picked === "true";
			return `bpx-consult ${picked === "true" ? "on" : "off"}`;
		}

		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Council roster management submenu (enable / disable / add / assign)
// ---------------------------------------------------------------------------

/** Default system prompt for a freshly-created persona. applyStance layers the
 * stance framing on top, so the base just names the lens. */
function defaultPersonaPrompt(name: string): string {
	return `You are the ${name} advisor on the bpx-consult council. Bring your specific lens to the question, argue from evidence, and give a clear call.`;
}

/**
 * AI-generated persona flow: describe focus → pick generator model → model
 * drafts {name, stance, systemPrompt} → confirm or regenerate → create + seat
 * on the generator model. Returns true if a persona was created (caller
 * persists + reloads), false otherwise (cancel / parse failure).
 */
async function runGeneratePersona(
	ctx: ExtensionContext,
	config: BpxConsultConfig,
	available: Model<Api>[],
): Promise<boolean> {
	const description = (await ctx.ui.input("Describe this advisor's focus", "e.g. security vulnerabilities, cost and ROI, API design"))?.trim();
	if (!description) return false;

	const defaultGen = config.modes?.solo?.model;
	const genKey = await pickModel(ctx, available, defaultGen, "Model to draft the persona");
	if (genKey === null) return false;

	const advisor = resolveAdvisor(ctx, genKey);
	if (!advisor) {
		ctx.ui.notify(`Couldn't resolve ${genKey}. Pick a model you have authed.`, "error");
		return false;
	}

	config.personas ??= {};
	config.modes ??= {};
	config.modes.council ??= {};
	const personas = config.personas;
	let members = config.modes.council.members ?? [];

	// Regenerate loop: draft → confirm → (regen | create | cancel).
	for (;;) {
		ctx.ui.notify(`Generating persona with ${describeModel(genKey)}…`, "info");
		// Wall-clock cap: a hung generator model otherwise bricks the configurator
		// ("Generating persona…" forever — esc can't cancel a bare await).
		const outcome = await withTimeout(GEN_TIMEOUT_MS, undefined, (signal) =>
			callAdvisor({
				ctx,
				advisor,
				systemPrompt: GEN_SYSTEM_PROMPT,
				messages: [{ role: "user", content: buildGeneratePrompt(description), timestamp: Date.now() }],
				thinkingLevel: "medium",
				signal,
			}),
		);
		if (outcome.timedOut) {
			ctx.ui.notify(`Generation timed out after ${GEN_TIMEOUT_MS / 1000}s — ${describeModel(genKey)} hung. Try a faster generator model.`, "error");
			return false;
		}
		if (!outcome.ok) {
			ctx.ui.notify(`Generation failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`, "error");
			return false;
		}
		const result = outcome.value;

		if (result.stopReason === "error" || !result.text) {
			ctx.ui.notify(`Generation failed: ${result.errorMessage ?? result.stopReason}`, "error");
			return false;
		}

		const parsed = parsePersonaJson(result.text);
		if (!parsed.ok) {
			const retry = await showFilterablePicker(ctx, {
				title: "Couldn't parse the draft",
				proseLines: [parsed.error, "The model's reply wasn't valid persona JSON. Regenerate or cancel."],
				items: [
					{ value: "regen", label: "Regenerate" },
					{ value: "cancel", label: "Cancel" },
				],
			});
			if (retry === "regen") continue;
			return false;
		}

		const { name, stance, systemPrompt } = parsed.persona;
		const nameClash = !!personas[name];
		const confirm = await showFilterablePicker(ctx, {
			title: `Create "${name}"?`,
			proseLines: [
				`Stance: ${stance}`,
				`Model: ${describeModel(genKey)}`,
				`Prompt: ${systemPrompt}`,
				...(nameClash ? [`Note: a persona named "${name}" already exists — creating will overwrite it.`] : []),
			],
			items: [
				{ value: "create", label: nameClash ? `Overwrite + seat ${name}` : `Create + seat ${name}` },
				{ value: "regen", label: "Regenerate" },
				{ value: "cancel", label: "Cancel" },
			],
		});

		if (confirm === "regen") continue;
		if (confirm !== "create") return false;

		personas[name] = { name, stance, defaultModel: genKey, systemPrompt };
		if (!members.includes(name)) {
			members = [...members, name];
			config.modes.council!.members = members;
		}
		ctx.ui.notify(`Added + seated ${name} (${stance}, ${describeModel(genKey)})`, "info");
		return true;
	}
}

/**
 * Council roster submenu. enable/disable = membership in `council.members`
 * (the persona definition persists, so re-enabling keeps its model). Adding a
 * persona creates the definition + seats it. Each change persists immediately
 * and the submenu reopens. Exits on Back or cancel.
 */
export async function runCouncilSubmenu(
	ctx: ExtensionContext,
	options: LoadConfigOptions,
	available: Model<Api>[],
): Promise<void> {
	let config = loadConfig(options);

	for (;;) {
		config.modes ??= {};
		config.modes.council ??= {};
		config.personas ??= {};

		const choice = await showFilterablePicker(ctx, {
			title: "Council members",
			proseLines: ["Seat or unseat personas, assign each a model, or add a new one. Changes save immediately."],
			items: buildCouncilMenu(config),
		});
		if (choice === null || choice === MENU_BACK) return;

		const members = config.modes.council!.members ?? [];
		const personas = config.personas!;

		// member.<name> — assign model
		if (choice.startsWith("member.")) {
			const name = choice.slice("member.".length);
			await runMemberDetail(ctx, config, name, available, options);
			config = loadConfig(options); // reload — model/backend/test may have changed config
			continue;
		}

		// Probe every seated member's effective route in one sweep — pre-flight
		// check before a real council instead of walking each member. Sequential so
		// results read in roster order. Probes are real (tiny) API calls. The menu
		// closes while the sweep runs (pickers resolve on pick); SAY SO up front so
		// the close reads as progress, not a crash, and results land in chat.
		if (choice === "testAll") {
			if (members.length === 0) continue;
			ctx.ui.notify(
				`Probing ${members.length} seated member${members.length === 1 ? "" : "s"} — real API calls, one-word replies. This can take a while; results print here and the menu reopens when the sweep finishes.`,
				"info",
			);
			for (const n of members) {
				await testMemberRoute(ctx, config, n);
			}
			continue;
		}

		// Seat/unseat toggle: one picker over ALL personas. Picking a seated member
		// unseats it; picking an unseated persona seats it. Persona definitions are
		// always kept (unseat ≠ delete), so this replaces the old disable/enable pair.
		if (choice === "seats") {
			const names = Object.keys(personas);
			if (names.length === 0) {
				ctx.ui.notify("No personas yet — add one first.", "info");
				continue;
			}
			const picked = await showFilterablePicker(ctx, {
				title: "Seat or unseat personas",
				proseLines: ["✓ marks a seated member. Pick a seated member to unseat it; pick an unseated persona to seat it. Definitions are kept either way."],
				items: names.map((n) => ({
					value: n,
					label: members.includes(n) ? `${n}${CHECKMARK}` : n,
				})),
			});
			if (picked === null) continue;
			if (members.includes(picked)) {
				config.modes.council!.members = members.filter((n) => n !== picked);
				ctx.ui.notify(`Unseated ${picked} (persona kept)`, "info");
			} else {
				config.modes.council!.members = [...members, picked];
				ctx.ui.notify(`Seated ${picked}`, "info");
			}
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			continue;
		}

		// Add a persona — one entry, two routes: manual (name → stance → backend → model) or
		// AI-generated (describe focus → draft → confirm). Both land here so the
		// menu row count stays flat.
		if (choice === "add") {
			const route = await showFilterablePicker(ctx, {
				title: "Add persona",
				proseLines: ["Manual: pick name, stance, backend, then its model. AI-generated: an inline model drafts the persona for review."],
				items: [
					{ value: "manual", label: "Manual (name → stance → backend)" },
					{ value: "ai", label: "AI-generated (describe the focus)" },
				],
			});
			if (route === null) continue;
			if (route === "ai") {
				const created = await runGeneratePersona(ctx, config, available);
				if (created) {
					if (!persist(ctx, config, options)) return;
					config = loadConfig(options);
				}
				continue;
			}
			const raw = (await ctx.ui.input("New persona name", "e.g. security, qa, reviewer"))?.trim();
			if (!raw) continue;
			// Same slug convention as AI-generated personas (lowercase, a-z0-9-).
			const name = sanitizeName(raw);
			if (!name) {
				ctx.ui.notify("Name needs at least one letter or digit.", "error");
				continue;
			}
			if (name !== raw) ctx.ui.notify(`Cleaned to "${name}" — personas use lowercase slugs.`, "info");
			if (personas[name]) {
				ctx.ui.notify(`"${name}" already exists. Seat it via “Seat or unseat personas…”, or pick a different name.`, "warning");
				continue;
			}
			const stance = await showFilterablePicker(ctx, {
				title: `Stance for ${name}`,
				proseLines: ["Stance biases what the persona hunts for — never its verdict. A 'for' stance can still say don't do this."],
				items: buildStanceItems(undefined),
				preferredValue: "neutral",
			});
			if (stance === null) continue;
			const backendChoice = await showFilterablePicker(ctx, {
				title: `Backend for ${name}`,
				items: buildBackendItems(config, {}),
			});
			if (backendChoice === null) continue;
			const candidate: NonNullable<BpxConsultConfig["personas"]>[string] = {
				name, stance: stance as "for" | "against" | "neutral", systemPrompt: defaultPersonaPrompt(name),
			};
			if (backendChoice === "inline" || backendChoice === "__remove__") {
				const picked = await pickModel(ctx, available, undefined, `${name} model`);
				if (picked === null) continue;
				candidate.defaultModel = picked;
				candidate.backend = { type: "inline" };
			} else if (backendChoice === "__custom__") {
				const custom = await runCustomCliFlow(ctx, { name, stance: candidate.stance ?? "neutral", systemPrompt: candidate.systemPrompt! });
				if (!custom) continue;
				candidate.backend = custom;
			} else {
				const command = backendChoice.slice("cli:".length);
				candidate.backend = { type: "cli", command };
				const chosen = await selectCliSeatModel(ctx, candidate, { type: "cli", command });
				if (!chosen) continue;
				Object.assign(candidate, chosen);
			}
			if (!await confirmMemberModel(ctx, config, name, candidate, `route ${describePersonaBackend(config, candidate)}`)) continue;
			personas[name] = candidate;
			config.modes.council!.members = [...members, name];
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`Added + seated ${name} (${stance}, ${describePersonaBackend(config, candidate)})`, "info");
			continue;
		}

		// Synthesizer model + thinking level behind one detail submenu.
		if (choice === "council.synth") {
			await runSynthDetail(ctx, options, available);
			config = loadConfig(options);
			continue;
		}
	}
}

/** Pick a preset CLI model, or its native default when no ID is selected. */
async function pickCliModel(ctx: ExtensionContext, command: string, current: string | undefined): Promise<{ id?: string; contextWindow?: number } | null> {
	for (;;) {
		let models: CodexModel[] = [];
		let error: string | undefined;
		try { models = await listCliModels(command, ctx.cwd); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		const picked = await showFilterablePicker(ctx, {
			title: `${command} CLI model`,
			proseLines: [
				command === "claude" ? "Claude CLI has no stable model-list command; use its default or enter an ID/alias."
					: `Models come from ${command} CLI. A listed model still needs a successful probe.`,
				...(error ? [`Discovery failed: ${error.slice(0, 180)}. Use CLI default or enter an ID.`] : []),
			],
			items: buildCliModelItems(command, models, current),
			preferredValue: current ?? "__codex_default__",
		});
		if (picked === null) return null;
		if (picked === "__codex_refresh__") continue;
		if (picked === "__codex_default__") return {};
		if (picked === "__codex_manual__") {
			const entered = (await ctx.ui.input(`${command} model ID`, current ?? "model ID or alias"))?.trim();
			if (!entered) continue;
			return { id: entered };
		}
		return { id: picked, contextWindow: models.find((model) => model.id === picked)?.contextWindow };
	}
}

/** Apply one CLI choice; OpenCode never receives a guessed context capacity. */
async function selectCliSeatModel<T extends { backend?: unknown; cliModels?: Record<string, string>; cliWindows?: Record<string, number>; codexModel?: string }>(
	ctx: ExtensionContext, seat: T, backend: CliBackendConfig,
): Promise<T | null> {
	const command = backend.command;
	const current = backend.model ?? seat.cliModels?.[command] ?? (command === "codex" ? seat.codexModel : undefined);
	const selected = await pickCliModel(ctx, command, current);
	if (selected === null) return null;
	const cliModels = { ...seat.cliModels };
	const cliWindows = { ...seat.cliWindows };
	if (command !== "codex" && seat.codexModel && !cliModels.codex) cliModels.codex = seat.codexModel;
	if (selected.id) cliModels[command] = selected.id;
	else delete cliModels[command];
	let nextBackend = seat.backend;
	if (nextBackend && typeof nextBackend === "object" && "model" in nextBackend) {
		const { model: _previous, ...withoutOverride } = nextBackend as Record<string, unknown>;
		nextBackend = withoutOverride;
	}
	if (command === "opencode") {
		let window = selected.contextWindow ?? (selected.id ? cliWindows[`opencode:${selected.id}`] : undefined);
		if (!window) {
			const raw = await ctx.ui.input("OpenCode model context window in tokens (required)", "e.g. 64000");
			window = parseContextWindow(raw ?? undefined) ?? undefined;
			if (!window) { ctx.ui.notify("OpenCode needs a known context window. Selection not saved.", "error"); return null; }
		}
		const { model: _override, ...backendSettings } = backend;
		if (selected.id) {
			cliWindows[`opencode:${selected.id}`] = window;
			// A window declared for the prior model must not override this model's metadata.
			nextBackend = { ...backendSettings, contextWindow: undefined };
		} else nextBackend = { ...backendSettings, contextWindow: window };
	}
	const result = { ...seat, backend: nextBackend, cliModels, cliWindows } as T;
	if (command === "codex") delete result.codexModel;
	return result;
}

/** Confirm a model candidate, probing its prospective backend before saving. */
export async function confirmMemberModel(
	ctx: ExtensionContext,
	config: BpxConsultConfig,
	name: string,
	candidate: NonNullable<BpxConsultConfig["personas"]>[string],
	label: string,
	routeNote: string[] = [],
): Promise<boolean> {
	const action = await showFilterablePicker(ctx, {
		title: `Assign ${label} to ${name}?`,
		proseLines: routeNote,
		items: [
			{ value: "assign", label: "Assign now" },
			{ value: "test", label: "Test with this persona first" },
			{ value: "cancel", label: "Cancel" },
		],
	});
	if (action === null || action === "cancel") return false;
	if (action === "assign") return true;

	const prospective = { ...config, personas: { ...config.personas, [name]: candidate } };
	const result = await probeMemberRoute(ctx, prospective, name);
	ctx.ui.notify(`${result.ok ? "✓" : "✗"} ${name}: ${result.detail}`, result.ok ? "info" : "error");
	if (!result.ok) return false;
	const confirm = await showFilterablePicker(ctx, {
		title: `${name}: ${result.detail}`,
		items: [
			{ value: "assign", label: "Assign this model" },
			{ value: "back", label: "Back (pick a different model)" },
		],
	});
	return confirm === "assign";
}

/**
 * One member's detail submenu: choose backend first, then its model. Persist
 * changes immediately; candidate tests use the same route as assigned tests.
 */
export async function runMemberDetail(
	ctx: ExtensionContext,
	config: BpxConsultConfig,
	name: string,
	available: Model<Api>[],
	options: LoadConfigOptions,
): Promise<void> {
	config.personas ??= {};
	const persona = () => config.personas![name] ?? {};

	for (;;) {
		const p = persona();
		const backend = effectiveMemberBackend(config, p);
		const route = describePersonaBackend(config, p);
		const inline = backend?.type !== "cli";
		const selectablePreset = backend?.type === "cli" && (CLI_PRESETS as readonly string[]).includes(backend.command) && !backend.args?.length;
		const fitWindow = backend?.type === "cli" ? String(cliContextWindow(backend) ?? "unknown — declare contextWindow") : "(registry)";
		const choice = await showFilterablePicker(ctx, {
			title: `Council — ${name}`,
			proseLines: [
				`Backend: ${route}  (fitted window: ${fitWindow})`,
				`Model: ${describeMemberModel(config, p)}`,
				...(inline ? [`Effort: ${p.thinkingLevel ?? "(default)"}`] : []),
				...(backend?.type === "cli" && !selectablePreset ? ["Model is managed by this CLI's arguments/config."] : []),
			],
			items: [
				{ value: "backend", label: `Set backend… (${route})` },
				...(inline || selectablePreset ? [{ value: "model", label: `Set model… (${describeMemberModel(config, p)})` }] : []),
				...(inline ? [{ value: "effort", label: "Set effort…" }] : []),
				...(backend?.type === "cli" ? [{ value: "window", label: `Context window: ${fitWindow} tokens…` }] : []),
				{ value: "test", label: "Test this route + persona (probe)…" },
				{ value: MENU_BACK, label: "Back" },
			],
		});
		if (choice === null || choice === MENU_BACK) return;

		if (choice === "window" && backend?.type === "cli") {
			const raw = await ctx.ui.input("CLI context window in tokens", String(cliContextWindow(backend) ?? ""));
			const window = parseContextWindow(raw ?? undefined);
			if (window === null) { ctx.ui.notify("Enter a positive-integer context window.", "error"); continue; }
			const candidate = { ...p, backend: { ...backend, contextWindow: window } };
			if (!await confirmMemberModel(ctx, config, name, candidate, `${window}-token window`)) continue;
			config.personas![name] = candidate;
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			continue;
		}

		if (choice === "effort") {
			const referenced = resolveReferencedModel(available, p.defaultModel ?? config.modes?.solo?.model);
			const picked = await showFilterablePicker(ctx, {
				title: `${name} effort`,
				proseLines: [
					route === "inline"
						? "Applied to this member's council calls."
						: "Used when this member runs inline — CLI backends ignore pi's reasoning setting.",
				],
				items: buildEffortItems(referenced, p.thinkingLevel),
				preferredValue: p.thinkingLevel,
			});
			if (picked === null) continue;
			config.personas![name] = { ...persona(), thinkingLevel: picked as ThinkingLevel };
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`${name} effort → ${picked}`, "info");
			continue;
		}

		if (choice === "model") {
			if (selectablePreset && backend?.type === "cli") {
				const command = backend.command;
				const candidate = await selectCliSeatModel(ctx, p, backend);
				if (!candidate) continue;
				const label = candidate.cliModels?.[command] ?? `${command} configured default`;
				if (!await confirmMemberModel(ctx, config, name, candidate, label)) continue;
				config.personas![name] = candidate;
				if (!persist(ctx, config, options)) return;
				config = loadConfig(options);
				ctx.ui.notify(`${name} ${command} model → ${label}`, "info");
				continue;
			}

			const picked = await pickModel(ctx, available, p.defaultModel ?? config.modes?.solo?.model, `${name} model`);
			if (picked === null) continue;
			const candidate = { ...p, defaultModel: picked };
			// Legacy model-key backends can change route in either direction.
			const routeBefore = describePersonaBackend(config, p);
			const routeAfter = describePersonaBackend(config, candidate);
			const routeNote = routeBefore === routeAfter ? [] : [
				`This choice changes ${name}'s route: ${routeBefore} → ${routeAfter}. ${routeAfter === "inline" ? "The picked pi model runs inline." : "The CLI controls execution; this pi model only selects the legacy backend mapping."}`,
			];
			if (!await confirmMemberModel(ctx, config, name, candidate, describeModel(picked), routeNote)) continue;
			config.personas![name] = candidate;
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`${name} model → ${describeModel(picked)}`, "info");
			continue;
		}

		if (choice === "backend") {
			const picked = await showFilterablePicker(ctx, {
				title: `Backend for ${name}`,
				proseLines: ["Inline routes through pi's provider. CLI presets (codex/claude/opencode) pipe the fitted context to the subprocess. Custom CLI asks for command + args + context window and probes before saving."],
				items: buildBackendItems(config, p),
			});
			if (picked === null) continue;

			// Custom CLI: command → args → required contextWindow → test-before-save.
			// Persisted only if the probe passes; a CLI that doesn't speak the stdin
			// contract (markdown transcript in, text/JSONL out) is rejected.
			if (picked === "__custom__") {
				const personaDef = resolvePersona(name, config.personas as never);
				if (!personaDef) continue;
				const candidate = await runCustomCliFlow(ctx, personaDef);
				if (candidate) {
					config.personas![name] = { ...persona(), backend: candidate };
					if (!persist(ctx, config, options)) return;
					config = loadConfig(options);
					ctx.ui.notify(`${name} backend → cli:${candidate.command}`, "info");
				}
				continue;
			}

			const cur = persona();
			let candidate: typeof cur;
			if (picked === "__remove__") {
				const { backend: _drop, ...rest } = cur;
				candidate = rest;
			} else if (picked === "inline") {
				candidate = { ...cur, backend: { type: "inline" } };
			} else {
				candidate = { ...cur, backend: { type: "cli", command: picked.slice("cli:".length) } };
			}
			if (picked === "cli:opencode") {
				const chosen = await selectCliSeatModel(ctx, candidate, { type: "cli", command: "opencode" });
				if (!chosen) continue;
				candidate = chosen;
			}
			if (!await confirmMemberModel(ctx, config, name, candidate, `backend ${describePersonaBackend(config, candidate)}`)) continue;
			config.personas![name] = candidate;
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`${name} backend → ${describePersonaBackend(config, persona())}`, "info");
			continue;
		}

		if (choice === "test") {
			await testMemberRoute(ctx, config, name);
			continue;
		}
	}
}

/**
 * Probe a member's effective route (inline model OR CLI backend) by running the
 * counselor's ACTUAL persona prompt with a one-word reply ask, then surfacing a
 * clear result category. For inline this is the test that catches a 401 / dead
 * key / unresponsive model BEFORE you commit the seat — the thing the live
 * councils kept hitting. For CLI it catches missing-executable / timeout /
 * nonzero-exit / empty-output. Short timeout so a dead route fails fast.
 */
const PROBE_TIMEOUT_MS = 30_000;
/** Persona drafting is a real generation and reasoning models dawdle — more headroom than a probe. */
const GEN_TIMEOUT_MS = 120_000;
/**
 * Probe cap scales with the persona's thinking level: probes run at the level
 * the real council call will use, and a healthy high/xhigh reasoning model can
 * legitimately spend 30s+ thinking before it emits "OK". A flat cap would
 * mislabel working deep-thinkers as "hung or unreachable".
 */
function probeTimeoutMs(level: ThinkingLevel | undefined): number {
	switch (level) {
		case "xhigh":
			return 90_000;
		case "high":
			return 60_000;
		default:
			return PROBE_TIMEOUT_MS;
	}
}
const PROBE_MESSAGE = { role: "user" as const, content: "Reply with the single word OK and nothing else.", timestamp: 0 };

/** Probe a CANDIDATE inline model with the persona's prompt — no config mutation.
 * Returns {ok, detail} so callers (test-before-assign AND the retest) decide how
 * to surface it. This is what catches a dead minimax/deepseek key before you
 * commit the seat: call it with the picked modelKey, branch on ok. */
export async function probeInlineModel(
	ctx: ExtensionContext,
	modelKey: string | undefined,
	persona: Persona,
): Promise<{ ok: boolean; detail: string }> {
	const advisor = resolveAdvisor(ctx, modelKey);
	if (!advisor) return { ok: false, detail: `model "${modelKey ?? "(none)"}" isn't in the registry` };
	// Probe budget scales with the EFFECTIVE level — an unsupported xhigh gets
	// clamped for the actual call, so it must not buy a 90s budget either.
	const effective = clampThinkingLevel(advisor.model, persona.thinkingLevel);
	const adjustedNote =
		effective !== undefined && effective !== persona.thinkingLevel ? ` [thinking ${persona.thinkingLevel} → ${effective}: model supports less]` : "";
	const cap = probeTimeoutMs(effective);
	const outcome = await withTimeout(cap, undefined, (signal) =>
		callAdvisor({
			ctx,
			advisor,
			systemPrompt: personaSystemPrompt(persona),
			messages: [{ ...PROBE_MESSAGE, timestamp: Date.now() }],
			thinkingLevel: persona.thinkingLevel,
			signal,
		}),
	);
	if (outcome.timedOut) return { ok: false, detail: `${advisor.label} timed out (${cap / 1000}s at thinking ${effective ?? "default"}) — hung or unreachable` };
	if (!outcome.ok) {
		const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return { ok: false, detail: `${advisor.label} threw: ${msg.slice(0, 140)}` };
	}
	const result = outcome.value;
	if (result.stopReason === "error" || !result.text) {
		return { ok: false, detail: `${advisor.label} failed (${result.stopReason}): ${result.errorMessage?.slice(0, 120) ?? "no response"}. Auth likely invalid — re-run /login for that provider.` };
	}
	return { ok: true, detail: `${advisor.label} responded: "${result.text.trim().slice(0, 60)}"${adjustedNote}` };
}

/**
 * Custom-CLI flow (council Plan A): collect command + structured args + a
 * REQUIRED context window, then probe with probeCliBackend BEFORE returning.
 * Returns the validated backend to assign, or null on cancel / invalid window /
 * failed probe. No silent window fallback; args are a structured argv (never a
 * shell string) so spawn stays injection-safe.
 */
async function runCustomCliFlow(ctx: ExtensionContext, persona: Persona): Promise<CliBackendConfig | null> {
	const command = (await ctx.ui.input("CLI executable (must be on PATH)", "e.g. gemini-cli, qwen, my-agent"))?.trim();
	if (!command) return null;
	const argsRaw = await ctx.ui.input("Arguments (comma-separated, or empty)", "e.g. exec, --read-only");
	const args = parseCliArgs(argsRaw ?? undefined);
	const winRaw = await ctx.ui.input("Context window in tokens (required — no fallback)", "e.g. 200000");
	const contextWindow = parseContextWindow(winRaw ?? undefined);
	if (contextWindow === null) {
		ctx.ui.notify("Custom CLI needs a positive-integer context window. Aborted — no fallback.", "error");
		return null;
	}
	const candidate: CliBackendConfig = { type: "cli", command, args, contextWindow };
	ctx.ui.notify(`Probing ${command} — it must accept the stdin contract (markdown transcript in, text/JSONL out)…`, "info");
	const r = await probeCliBackend(ctx, candidate, persona);
	ctx.ui.notify(`${r.ok ? "✓" : "✗"} ${command}: ${r.detail}`, r.ok ? "info" : "error");
	if (!r.ok) return null;
	return candidate;
}

/** Probe a CLI backend with the persona's prompt. Same {ok, detail} shape. */
async function probeCliBackend(
	ctx: ExtensionContext,
	backend: CliBackendConfig,
	persona: Persona,
): Promise<{ ok: boolean; detail: string }> {
	const r = await callCliAdvisor({
		systemPrompt: personaSystemPrompt(persona),
		messages: [{ ...PROBE_MESSAGE, timestamp: Date.now() }],
		backend: { ...backend, timeoutMs: Math.min(backend.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS) },
		signal: undefined,
		cwd: ctx.cwd,
	});
	const label = backend.model ? `cli:${backend.command}/${backend.model}` : `cli:${backend.command}`;
	if (r.text.trim()) return { ok: true, detail: `${label} responded: "${r.text.trim().slice(0, 60)}"` };
	if (r.errorMessage?.match(/failed to run|ENOENT/i)) return { ok: false, detail: `${label} not found on PATH` };
	if (r.timedOut) return { ok: false, detail: `${label} timed out (30s)` };
	if (r.exitCode !== null && r.exitCode !== 0) return { ok: false, detail: `${label}: ${r.errorMessage?.slice(-240) ?? `exited ${r.exitCode}`}` };
	return { ok: false, detail: `${label} returned no usable output` };
}

/** Probe the effective route in a config, including an unsaved candidate config. */
export async function probeMemberRoute(
	ctx: ExtensionContext,
	config: BpxConsultConfig,
	name: string,
): Promise<{ ok: boolean; detail: string }> {
	const persona = resolvePersona(name, config.personas as never);
	if (!persona) return { ok: false, detail: `No persona "${name}" to test.` };
	const rawPersona = config.personas?.[name] ?? {};
	const modelKey = persona.defaultModel ?? config.modes?.solo?.model;
	const route = resolveSeatRoute(config, { ...rawPersona, model: modelKey }, (key) => resolveAdvisor(ctx, key));
	if (route.kind === "error") return { ok: false, detail: route.message };
	try {
		return route.kind === "cli"
			? await probeCliBackend(ctx, route.backend, persona)
			: await probeInlineModel(ctx, modelKey, persona);
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Retest the member's assigned route; candidate tests call the same helper. */
async function testMemberRoute(ctx: ExtensionContext, config: BpxConsultConfig, name: string): Promise<void> {
	ctx.ui.notify(`Probing ${name}…`, "info");
	const result = await probeMemberRoute(ctx, config, name);
	ctx.ui.notify(`${result.ok ? "✓" : "✗"} ${name}: ${result.detail}`, result.ok ? "info" : "error");
}

/** Persist config, notify on failure. Returns false to signal the caller should abort. */
function persist(ctx: ExtensionContext, config: BpxConsultConfig, _options: LoadConfigOptions): boolean {
	if (!saveConfig(config)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return false;
	}
	return true;
}
