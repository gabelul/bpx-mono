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
import { loadConfig, saveConfig, type LoadConfigOptions } from "./config.js";
import { showFilterablePicker } from "./picker.js";

const CHECKMARK = " ✓";
const MENU_DONE = "__done__";

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
	const council = config.modes?.council;
	const personas = config.personas ?? {};
	const items: SelectItem[] = [
		{ value: "defaultMode", label: `Default mode: ${config.defaultMode ?? "solo"}` },
		{ value: "solo.model", label: `Solo model: ${describeModel(solo?.model)}` },
		{ value: "solo.effort", label: `Solo effort: ${solo?.thinkingLevel ?? "(default)"}` },
		{ value: "gutCheck.model", label: `Gut-check model: ${describeModel(gut?.model)}` },
		{ value: "gutCheck.effort", label: `Gut-check effort: ${gut?.thinkingLevel ?? "(default)"}` },
	];

	// One row per persona (dynamic — user-defined personas show too).
	for (const [name, persona] of Object.entries(personas)) {
		items.push({ value: `persona.${name}`, label: `Council — ${name} model: ${describeModel(persona.defaultModel)}` });
	}

	if (council?.synthesizer) {
		items.push({ value: "council.synth", label: `Council — synthesizer model: ${describeModel(council.synthesizer.model)}` });
	}

	items.push({ value: "triggers.onDone", label: `Trigger — onDone: ${config.triggers?.onDone ? "on" : "off"}` });
	items.push({ value: "triggers.whenStuck", label: `Trigger — whenStuck: ${config.triggers?.whenStuck ?? 3}` });
	items.push({ value: "enabled", label: `Enabled: ${config.enabled === false ? "off" : "on"}` });
	items.push({ value: MENU_DONE, label: "Done" });
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
		case "gutCheck.model":
		case "council.synth": {
			let title: string;
			let currentKey: string | undefined;
			if (choice === "council.synth") {
				title = "Council synthesizer";
				currentKey = config.modes.council?.synthesizer?.model;
			} else if (choice === "gutCheck.model") {
				title = "Gut-check model";
				currentKey = config.modes.gutCheck?.model;
			} else {
				title = "Solo model";
				currentKey = config.modes.solo?.model;
			}
			const picked = await pickModel(ctx, available, currentKey, title);
			if (picked === null) return null;
			if (choice === "council.synth") {
				config.modes.council.synthesizer = { ...config.modes.council?.synthesizer, model: picked };
			} else if (choice === "gutCheck.model") {
				config.modes.gutCheck.model = picked;
			} else {
				config.modes.solo.model = picked;
			}
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

		default: {
			// persona.<name>
			if (choice.startsWith("persona.")) {
				const name = choice.slice("persona.".length);
				config.personas ??= {};
				const persona = config.personas[name] ?? {};
				const current = persona.defaultModel;
				const picked = await pickModel(ctx, available, current, `Council — ${name} model`);
				if (picked === null) return null;
				config.personas[name] = { ...persona, defaultModel: picked };
				return `${name} model → ${describeModel(picked)}`;
			}
			return null;
		}
	}
}
