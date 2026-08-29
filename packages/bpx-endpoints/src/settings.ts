/**
 * settings — consult-style settings configurator + status read-out.
 *
 * Mirrors bpx-consult's /consult surface: bare /endpoints keeps opening the
 * Endpoint Manager overlay (the richer editor for endpoint profiles), while
 * /endpoints settings opens the same filterable-picker configurator bpx-consult
 * uses, and /endpoints status prints a plain read-out. Changes persist after
 * every pick — same save-after-every-change contract as /consult.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { showFilterablePicker } from "./picker.js";
import type { ManagedConfig } from "./types.js";
import { getConfigPaths, loadManagedConfig, writeManagedConfig, ensureManagedConfig } from "./io.js";
import { loadCache, loadModelsConfig } from "./io.js";

const MENU_DONE = "__done__";

const MSG_REQUIRES_UI = "/endpoints settings requires an interactive terminal. Use /endpoints status instead.";
const MSG_PERSIST_FAILED = "Failed to save bpx-endpoints.json — check disk permissions.";
const MSG_SAVED = (label: string) => `Saved: ${label}`;

// ---------------------------------------------------------------------------
// Main configurator loop
// ---------------------------------------------------------------------------

/**
 * Open the consult-style settings configurator. One row per editable setting,
 * current value shown in the label; picking a row edits in place, persists
 * immediately, and reopens the menu. Escape or "Done" leaves.
 */
export async function runEndpointsSettings(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_UI, "error");
		return;
	}
	const paths = getConfigPaths();
	const loaded = await loadManagedConfig(paths);
	if (loaded.error) {
		// Never open the editor over a malformed config: editing one setting and
		// saving would persist the fail-soft default over the broken file and
		// destroy the recovery data /endpoints doctor is meant to protect.
		ctx.ui.notify(`bpx-endpoints.json is invalid — run /endpoints doctor to diagnose before editing. ${loaded.error}`, "error");
		return;
	}
	let config = loaded.value ?? (loaded.missing ? await ensureManagedConfig(paths) : undefined);
	if (!config) {
		ctx.ui.notify("bpx-endpoints.json could not be loaded.", "error");
		return;
	}

	for (;;) {
		const choice = await showFilterablePicker(ctx, {
			title: "bpx-endpoints settings",
			proseLines: ["Edit a setting. Changes save immediately; the menu reopens so you can set several in one go."],
			items: buildSettingsMenu(config),
		});

		if (choice === null || choice === MENU_DONE) return;

		const handled = await dispatchSetting(ctx, choice, config);
		if (!handled) continue; // user cancelled the sub-picker — back to menu, no save

		try {
			await writeManagedConfig(paths, config);
		} catch {
			ctx.ui.notify(MSG_PERSIST_FAILED, "error");
			return;
		}
		// Reload so the next menu render reflects exactly what's on disk.
		const reloaded = await loadManagedConfig(paths);
		if (reloaded.value) config = reloaded.value;
		ctx.ui.notify(MSG_SAVED(handled), "info");
	}
}

function buildSettingsMenu(config: ManagedConfig): SelectItem[] {
	const settings = config.settings;
	return [
		{
			value: "settings.staleReminder",
			label: `Stale reminder: ${settings?.staleReminder === false ? "off" : "on"}`,
		},
		{
			value: "settings.staleReminderDays",
			label: `Stale reminder days: ${settings?.staleReminderDays ?? 7}`,
		},
		{ value: MENU_DONE, label: "Done" },
	];
}

async function dispatchSetting(ctx: ExtensionContext, choice: string, config: ManagedConfig): Promise<string | null> {
	switch (choice) {
		case "settings.staleReminder": {
			const current = config.settings?.staleReminder !== false;
			const picked = await showFilterablePicker(ctx, {
				title: "Stale reminder",
				proseLines: ["Remind when an endpoint's discovery cache is older than the threshold."],
				items: [
					{ value: "on", label: `On (current: ${current ? "yes" : "no"})` },
					{ value: "off", label: `Off (current: ${current ? "no" : "yes"})` },
				],
				preferredValue: current ? "on" : "off",
			});
			if (picked === null) return null;
			config.settings ??= {};
			config.settings.staleReminder = picked === "on";
			return `stale reminder → ${picked === "on" ? "on" : "off"}`;
		}

		case "settings.staleReminderDays": {
			const current = config.settings?.staleReminderDays ?? 7;
			const picked = await showFilterablePicker(ctx, {
				title: "Stale reminder days",
				proseLines: ["Endpoints whose discovery cache is older than this many days trigger the reminder."],
				items: buildDaysItems(current),
				preferredValue: String(current),
			});
			if (picked === null) return null;
			config.settings ??= {};
			config.settings.staleReminderDays = Number(picked);
			return `stale reminder days → ${picked}`;
		}

		default:
			return null;
	}
}

function buildDaysItems(current: number): SelectItem[] {
	const options = [1, 3, 7, 14, 30];
	const items = options.map((days) => ({
		value: String(days),
		label: `${days} day${days === 1 ? "" : "s"}${days === current ? " (current)" : ""}`,
	}));
	if (!options.includes(current)) {
		items.unshift({ value: String(current), label: `${current} days (current)` });
	}
	return items;
}

// ---------------------------------------------------------------------------
// Status read-out
// ---------------------------------------------------------------------------

/**
 * /endpoints status — quick non-interactive read-out, mirroring /consult status.
 */
export async function showEndpointsStatus(ctx: ExtensionContext): Promise<void> {
	const paths = getConfigPaths();
	const [managed, cache, generated, custom] = await Promise.all([
		loadManagedConfig(paths),
		loadCache(paths),
		loadModelsConfig(paths.generated),
		loadModelsConfig(paths.custom),
	]);
	const config = managed.value ?? { version: 1, profiles: {} };
	const profiles = Object.values(config.profiles);
	const enabled = profiles.filter((profile) => profile.enabled).length;
	const settings = config.settings;

	let healthLine = "  health    : (no cache)";
	if (cache.value) {
		let ok = 0;
		let failing = 0;
		let never = 0;
		for (const cached of Object.values(cache.value.profiles)) {
			if (!cached.health?.lastTestAt) never += 1;
			else if (cached.health.lastError) failing += 1;
			else ok += 1;
		}
		healthLine = `  health    : ${ok} ok · ${failing} failing · ${never} never tested`;
	}

	const lines = [
		`bpx-endpoints status`,
		`  config    : ${paths.config}`,
		`  endpoints : ${profiles.length} configured (${enabled} enabled)`,
		`  stale     : ${settings?.staleReminder === false ? "off" : "on"}, ${settings?.staleReminderDays ?? 7} days`,
		healthLine,
		`  cache     : ${cache.value ? `${Object.keys(cache.value.profiles).length} profile(s) cached` : cache.error ?? "(empty)"}`,
		`  generated : ${generated.value ? `${Object.keys(generated.value.providers).length} provider(s)` : generated.error ?? "(empty)"}`,
		`  custom    : ${custom.value ? `${Object.keys(custom.value.providers).length} override(s)` : custom.error ?? "(none)"}`,
		``,
		`Run /endpoints to open the Endpoint Manager, /endpoints settings to edit settings.`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
