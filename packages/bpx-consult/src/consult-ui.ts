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

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "@juicesharp/rpiv-config";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { BpxConsultConfig } from "./config.js";
import { loadConfig, resolvePersonaBackend, saveConfig, type LoadConfigOptions } from "./config.js";
import { callAdvisor, resolveAdvisor } from "./advisor.js";
import { callCliAdvisor, cliContextWindow, type CliBackendConfig } from "./cli-backend.js";
import { withTimeout } from "./timeout.js";
import { personaSystemPrompt, resolvePersona, type Persona } from "./personas.js";
import { buildGeneratePrompt, GEN_SYSTEM_PROMPT, parsePersonaJson } from "./persona-gen.js";
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
	const personas = config.personas ?? {};
	const unseated = Object.keys(personas).filter((n) => !members.includes(n));
	const items: SelectItem[] = [];
	for (const name of members) {
		const p = personas[name] ?? {};
		// Route visibility (council §4): show the effective backend next to the model
		// so a user can see at a glance who's inline vs CLI-routed.
		const route = describePersonaBackend(config, p);
		items.push({ value: `member.${name}`, label: `${name} — model: ${describeModel(p.defaultModel)}  [${route}]` });
	}
	items.push({ value: "disable", label: members.length ? "Disable a member…" : "(no members seated)" });
	items.push({
		value: "enable",
		label: unseated.length ? `Enable a persona… (${unseated.length} available)` : "Enable a persona… (none available)",
	});
	items.push({ value: "add", label: "Add a new persona…" });
	items.push({ value: "add.ai", label: "Add a persona (AI-generated)…" });
	items.push({ value: "council.synth", label: `Synthesizer model: ${describeModel(config.modes?.council?.synthesizer?.model)}` });
	items.push({ value: MENU_BACK, label: "Back" });
	return items;
}

/** The narrow CLI presets the menu offers (council §2). Custom commands stay JSON-only. */
const CLI_PRESETS = ["codex", "claude", "opencode"] as const;

/** Human label for a persona's effective backend (route visibility, council §4). */
export function describePersonaBackend(config: BpxConsultConfig, persona: { backend?: unknown; defaultModel?: string }): string {
	const b = resolvePersonaBackend(config, persona);
	if (b?.type === "cli") return `cli:${b.command}`;
	return "inline";
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
export function buildBackendItems(config: BpxConsultConfig, persona: { backend?: unknown; defaultModel?: string }): SelectItem[] {
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
	// Council member editing lives entirely behind one entry → its submenu, where
	// each member gets the full detail (model / backend / test-before-assign /
	// enable-disable / add). Surfacing bare member rows here gave a dead-end
	// "basic" path with no test; collapsing to one entry removes that split.
	const items: SelectItem[] = [
		{ value: "defaultMode", label: `Default mode: ${config.defaultMode ?? "solo"}` },
		{ value: "solo.model", label: `Solo model: ${describeModel(solo?.model)}` },
		{ value: "solo.effort", label: `Solo effort: ${solo?.thinkingLevel ?? "(default)"}` },
		{ value: "gutCheck.model", label: `Gut-check model: ${describeModel(gut?.model)}` },
		{ value: "gutCheck.effort", label: `Gut-check effort: ${gut?.thinkingLevel ?? "(default)"}` },
		{ value: "council.manage", label: "Council members…" },
		{ value: "triggers.onDone", label: `Trigger — onDone: ${config.triggers?.onDone ? "on" : "off"}` },
		{ value: "triggers.whenStuck", label: `Trigger — whenStuck: ${config.triggers?.whenStuck ?? 0}` },
		{ value: "enabled", label: `Enabled: ${config.enabled === false ? "off" : "on"}` },
		{ value: MENU_DONE, label: "Done" },
	];
	return items;
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
	let config = options.config ?? loadConfig(options);

	for (;;) {
		const choice = await showFilterablePicker(ctx, {
			title: "bpx-consult",
			proseLines: ["Edit a setting. Changes save immediately; the menu reopens so you can set several in one go."],
			items: buildMainMenu(config),
		});

		if (choice === null || choice === MENU_DONE) return;

		// Council roster management is a sub-loop that persists its own changes.
		if (choice === "council.manage") {
			await runCouncilSubmenu(ctx, options, available);
			config = loadConfig(options);
			continue;
		}

		const handled = await dispatch(ctx, choice, config, available);
		if (!handled) continue; // user cancelled the sub-picker — back to menu, no save

		if (!saveConfig(config)) {
			ctx.ui.notify(MSG_PERSIST_FAILED, "error");
			return;
		}
		// Reload so the next menu render reflects exactly what's on disk (mergeDefaults re-applies).
		config = loadConfig(options);
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

		case "solo.model":
		case "gutCheck.model": {
			const isGut = choice === "gutCheck.model";
			const title = isGut ? "Gut-check model" : "Solo model";
			const currentKey = isGut ? config.modes.gutCheck?.model : config.modes.solo?.model;
			const picked = await pickModel(ctx, available, currentKey, title);
			if (picked === null) return null;
			if (isGut) config.modes.gutCheck.model = picked;
			else config.modes.solo.model = picked;
			return `${title} → ${describeModel(picked)}`;
		}

		case "solo.effort":
		case "gutCheck.effort": {
			const isGut = choice === "gutCheck.effort";
			const cfg = isGut ? config.modes.gutCheck : config.modes.solo;
			const referenced = resolveReferencedModel(available, cfg.model);
			const picked = await showFilterablePicker(ctx, {
				title: `${isGut ? "Gut-check" : "Solo"} effort`,
				items: buildEffortItems(referenced, cfg.thinkingLevel),
				preferredValue: cfg.thinkingLevel,
			});
			if (picked === null) return null;
			cfg.thinkingLevel = picked as ThinkingLevel;
			return `${isGut ? "gutCheck" : "solo"} effort → ${picked}`;
		}

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
		const result = await callAdvisor({
			ctx,
			advisor,
			systemPrompt: GEN_SYSTEM_PROMPT,
			messages: [{ role: "user", content: buildGeneratePrompt(description), timestamp: Date.now() }],
			thinkingLevel: "medium",
			signal: undefined,
		});

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

		// Disable a member — remove from roster (persona def kept for re-enable)
		if (choice === "disable") {
			if (members.length === 0) continue;
			const picked = await showFilterablePicker(ctx, {
				title: "Disable a member (unseat)",
				proseLines: ["The persona definition is kept, so you can re-enable it later with its model intact."],
				items: members.map((n) => ({ value: n, label: n })),
			});
			if (picked === null) continue;
			config.modes.council!.members = members.filter((n) => n !== picked);
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`Unseated ${picked}`, "info");
			continue;
		}

		// Enable a persona — re-seat one that exists but isn't in the roster
		if (choice === "enable") {
			const unseated = Object.keys(personas).filter((n) => !members.includes(n));
			if (unseated.length === 0) {
				ctx.ui.notify("No personas available to enable. Add one first.", "info");
				continue;
			}
			const picked = await showFilterablePicker(ctx, {
				title: "Enable a persona (seat it)",
				items: unseated.map((n) => ({ value: n, label: `${n} — ${describeModel(personas[n]?.defaultModel)}` })),
			});
			if (picked === null) continue;
			config.modes.council!.members = [...members, picked];
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`Seated ${picked}`, "info");
			continue;
		}

		// Add a new persona — name (text input) → stance → model → create + seat
		if (choice === "add") {
			const name = (await ctx.ui.input("New persona name", "e.g. security, qa, reviewer"))?.trim();
			if (!name) continue;
			if (personas[name]) {
				ctx.ui.notify(`"${name}" already exists. Enable it instead, or pick a different name.`, "warning");
				continue;
			}
			const stance = await showFilterablePicker(ctx, {
				title: `Stance for ${name}`,
				proseLines: ["Stance biases what the persona hunts for — never its verdict. A 'for' stance can still say don't do this."],
				items: buildStanceItems(undefined),
				preferredValue: "neutral",
			});
			if (stance === null) continue;
			const modelPicked = await pickModel(ctx, available, undefined, `${name} model`);
			if (modelPicked === null) continue;
			personas[name] = {
				name,
				stance: stance as "for" | "against" | "neutral",
				defaultModel: modelPicked,
				systemPrompt: defaultPersonaPrompt(name),
			};
			config.modes.council!.members = [...members, name];
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			ctx.ui.notify(`Added + seated ${name} (${stance}, ${describeModel(modelPicked)})`, "info");
			continue;
		}

		// Add a persona (AI-generated) — describe focus → pick generator model →
		// model drafts {name, stance, systemPrompt} → confirm/regenerate → seat.
		if (choice === "add.ai") {
			const created = await runGeneratePersona(ctx, config, available);
			if (created) {
				if (!persist(ctx, config, options)) return;
				config = loadConfig(options);
			}
			continue;
		}

		// Synthesizer model
		if (choice === "council.synth") {
			config.modes.council!.synthesizer ??= {};
			const picked = await pickModel(ctx, available, config.modes.council!.synthesizer.model, "Council synthesizer");
			if (picked === null) continue;
			config.modes.council!.synthesizer = { ...config.modes.council!.synthesizer, model: picked };
			if (!persist(ctx, config, options)) return;
			config = loadConfig(options);
			continue;
		}
	}
}

/**
 * One member's detail submenu: set model, set backend (inline / CLI preset /
 * remove), and test a CLI backend with a probe (council §2 + §4). Persists each
 * change immediately and reloads so the menu reflects what's on disk.
 */
async function runMemberDetail(
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
		const route = describePersonaBackend(config, p);
		// Show the fitted window for a CLI route so the user sees the real cap.
		const fitWindow =
			route === "inline"
				? "(registry)"
				: (() => {
					const b = resolvePersonaBackend(config, p);
					return b?.type === "cli" ? String(cliContextWindow(b) ?? "unknown — declare contextWindow") : "(registry)";
				})();
		const choice = await showFilterablePicker(ctx, {
			title: `Council — ${name}`,
			proseLines: [
				`Model: ${describeModel(p.defaultModel)}`,
				`Backend: ${route}  (fitted window: ${fitWindow})`,
			],
			items: [
				{ value: "model", label: "Set model…" },
				{ value: "backend", label: `Set backend… (${route})` },
				{ value: "test", label: "Test this model + persona (probe)…" },
				{ value: MENU_BACK, label: "Back" },
			],
		});
		if (choice === null || choice === MENU_BACK) return;

		if (choice === "model") {
			const picked = await pickModel(ctx, available, p.defaultModel, `${name} model`);
			if (picked === null) continue;
			// Test-before-assign (the user's actual ask): don't persist yet. Offer to
			// probe the CANDIDATE with this persona's prompt first, so a dead key is
			// caught at selection time, not in a live council call.
			const action = await showFilterablePicker(ctx, {
				title: `Assign ${describeModel(picked)} to ${name}?`,
				items: [
					{ value: "assign", label: "Assign now" },
					{ value: "test", label: "Test with this persona first" },
					{ value: "cancel", label: "Cancel" },
				],
			});
			if (action === null || action === "cancel") continue;
			if (action === "test") {
				const personaDef = resolvePersona(name, config.personas as never);
				if (personaDef) {
					const r = await probeInlineModel(ctx, picked, personaDef);
					ctx.ui.notify(`${r.ok ? "✓" : "✗"} ${name}: ${r.detail}`, r.ok ? "info" : "error");
					if (r.ok) {
						const confirm = await showFilterablePicker(ctx, {
							title: `${name}: ${r.detail}`,
							items: [
								{ value: "assign", label: "Assign this model" },
								{ value: "back", label: "Back (pick a different model)" },
							],
						});
						if (confirm !== "assign") continue;
					} else {
						continue; // failed probe → back to detail, re-pick
					}
				}
			}
			config.personas![name] = { ...persona(), defaultModel: picked };
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
			if (picked === "__remove__") {
				const { backend: _drop, ...rest } = cur;
				config.personas![name] = rest;
			} else if (picked === "inline") {
				config.personas![name] = { ...cur, backend: { type: "inline" } };
			} else {
				// cli:<command> preset
				const command = picked.slice("cli:".length);
				config.personas![name] = { ...cur, backend: { type: "cli", command } };
			}
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
	const outcome = await withTimeout(PROBE_TIMEOUT_MS, undefined, (signal) =>
		callAdvisor({
			ctx,
			advisor,
			systemPrompt: personaSystemPrompt(persona),
			messages: [{ ...PROBE_MESSAGE, timestamp: Date.now() }],
			thinkingLevel: persona.thinkingLevel,
			signal,
		}),
	);
	if (outcome.timedOut) return { ok: false, detail: `${advisor.label} timed out (30s) — hung or unreachable` };
	if (!outcome.ok) {
		const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		return { ok: false, detail: `${advisor.label} threw: ${msg.slice(0, 140)}` };
	}
	const result = outcome.value;
	if (result.stopReason === "error" || !result.text) {
		return { ok: false, detail: `${advisor.label} failed (${result.stopReason}): ${result.errorMessage?.slice(0, 120) ?? "no response"}. Auth likely invalid — re-run /login for that provider.` };
	}
	return { ok: true, detail: `${advisor.label} responded: "${result.text.trim().slice(0, 60)}"` };
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
	if (r.text.trim()) return { ok: true, detail: `cli:${backend.command} responded: "${r.text.trim().slice(0, 60)}"` };
	if (r.errorMessage?.match(/failed to run|ENOENT/i)) return { ok: false, detail: `cli:${backend.command} not found on PATH` };
	if (r.timedOut) return { ok: false, detail: `cli:${backend.command} timed out (30s)` };
	if (r.exitCode !== null && r.exitCode !== 0) return { ok: false, detail: `cli:${backend.command} exited ${r.exitCode}: ${r.errorMessage?.slice(0, 120)}` };
	return { ok: false, detail: `cli:${backend.command} returned no usable output` };
}

/**
 * Retest the member's CURRENTLY ASSIGNED route (inline model or CLI backend) with
 * its persona prompt, and notify. Distinct from the pre-assign candidate test:
 * this re-checks whatever is already configured.
 */
async function testMemberRoute(ctx: ExtensionContext, config: BpxConsultConfig, name: string): Promise<void> {
	const persona = resolvePersona(name, config.personas as never);
	if (!persona) {
		ctx.ui.notify(`No persona "${name}" to test.`, "error");
		return;
	}
	const rawPersona = config.personas?.[name] ?? {};
	const modelKey = persona.defaultModel ?? config.modes?.solo?.model;
	const backend = resolvePersonaBackend(config, { backend: rawPersona.backend, defaultModel: modelKey });
	ctx.ui.notify(`Probing ${name}…`, "info");
	const result = backend?.type === "cli"
		? await probeCliBackend(ctx, backend, persona)
		: await probeInlineModel(ctx, modelKey, persona);
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
