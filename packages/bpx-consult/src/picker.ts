/**
 * picker — the framed, type-to-filter list primitive /consult is built on.
 *
 * showFilterablePicker renders a solid card (the bpx-endpoints family look:
 * ┌─┐ frame in the theme border color, every row filled with the theme's
 * floating-card background, a full-width selectedBg bar on the highlighted
 * row) as a centered floating overlay, holding a title, optional prose, a
 * live "Filter:" line, the filtered list and a nav hint. It resolves to the
 * selected value, or null on cancel.
 * The same primitive backs the main menu and every sub-picker (model, effort,
 * mode, on/off) — it's just a list of SelectItems with a fuzzy filter.
 *
 * The list is rendered by hand instead of composing pi-tui's SelectList so the
 * selection bar can span the full card width and share the card's background
 * math. That math is hardened by bpx-endpoints: truncateToWidth APPENDS an
 * ellipsis when it clips, so padLine pads to width-4 (content area) while the
 * frame sits at width-2 — if padding eats the frame margin, every full row
 * grows '...' tails.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type OverlayOptions, type SelectItem } from "@earendil-works/pi-tui";
import { filterItems, isBackspace, isPrintable } from "./fuzzy.js";

const MAX_VISIBLE_ROWS = 10;
const NAV_HINT = "type to filter • ↑↓ navigate • enter select • esc cancel";

/**
 * The slice of pi's theme the card paints with. Pi's Theme.bg resets only the
 * background (49m) and fg spans reset only the foreground (39m), so whole-line
 * background fills compose cleanly with inner styling.
 */
interface PanelTheme {
	accent(text: string): string;
	border(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
	bold(text: string): string;
	panelBg(text: string): string;
	selectionBg(text: string): string;
}

function panelThemeFromPi(theme: Theme): PanelTheme {
	const bg = typeof theme.bg === "function" ? theme.bg.bind(theme) : undefined;
	return {
		accent: (t) => theme.fg("accent", t),
		border: (t) => theme.fg("border", t),
		dim: (t) => theme.fg("dim", t),
		muted: (t) => theme.fg("muted", t),
		warning: (t) => theme.fg("warning", t),
		bold: (t) => theme.bold(t),
		panelBg: bg ? (t) => bg("customMessageBg", t) : (t) => t,
		selectionBg: bg ? (t) => bg("selectedBg", t) : (t) => t,
	};
}

// --- frame helpers (ported from bpx-endpoints src/tui.ts) ---

function padVisible(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/** ┌───┐ top edge of the card, painted with the panel background. */
function boxTop(width: number, t: PanelTheme): string {
	return t.panelBg(t.border(`┌${"─".repeat(Math.max(0, width - 2))}┐`));
}

/** └───┘ bottom edge of the card, painted with the panel background. */
function boxBottom(width: number, t: PanelTheme): string {
	return t.panelBg(t.border(`└${"─".repeat(Math.max(0, width - 2))}┘`));
}

/** One frame row: │ content │, the whole row painted with `bg`. */
function frameLine(content: string, width: number, t: PanelTheme, bg: (text: string) => string): string {
	const inner = Math.max(0, width - 2);
	const singleLine = content.replace(/[\r\n]+/g, " ");
	return bg(`${t.border("│")}${padVisible(truncateToWidth(singleLine, inner), inner)}${t.border("│")}`);
}

/** Pad raw text to width - 4 so frameLine can wrap it in "│ " and " " borders. */
function padLine(content: string, width: number): string {
	const inner = Math.max(0, width - 4);
	const singleLine = content.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
	return ` ${padVisible(truncateToWidth(singleLine, inner), inner)} `;
}

export interface FilterablePickerOptions {
	title: string;
	proseLines?: string[];
	items: SelectItem[];
	/** Value to preselect while the query is empty (e.g. the current setting). */
	preferredValue?: string;
}

/**
 * Endpoints-family overlay geometry: a centered card capped at 104 columns
 * (90% of narrow terminals), minimum 80, at most 85% of the terminal height.
 */
function pickerOverlay(): { overlay: true; overlayOptions: OverlayOptions } {
	return {
		overlay: true,
		overlayOptions: {
			width: Math.min(104, Math.floor((process.stdout.columns || 104) * 0.9)),
			minWidth: 80,
			maxHeight: "85%",
		},
	};
}

/**
 * Show the framed, filterable card as a centered overlay (the bpx-endpoints
 * container: overlays reclaim focus, so pi dialogs opened around the picker
 * can never evict it — the editor-slot eviction bug can't happen here).
 * Resolves to the chosen value, or null if the user cancels (esc). The filter
 * matches subsequence against `label value`, ranked so contiguous and
 * word-boundary hits win.
 */
export function showFilterablePicker(ctx: ExtensionContext, opts: FilterablePickerOptions): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const t = panelThemeFromPi(theme);
		let query = "";
		let filtered: SelectItem[] = [];
		let selected = 0;
		let scroll = 0;

		const visibleRows = () => Math.min(Math.max(filtered.length, 1), MAX_VISIBLE_ROWS);

		const refilter = () => {
			filtered = filterItems(opts.items, query);
			selected = 0;
			scroll = 0;
			if (query.length === 0 && opts.preferredValue) {
				const idx = filtered.findIndex((item) => item.value === opts.preferredValue);
				if (idx >= 0) {
					selected = idx;
					scroll = Math.max(0, idx - visibleRows() + 1);
				}
			}
		};
		refilter();

		const move = (delta: number) => {
			if (filtered.length === 0) return;
			selected = (selected + delta + filtered.length) % filtered.length;
			const rows = visibleRows();
			if (selected < scroll) scroll = selected;
			if (selected >= scroll + rows) scroll = selected - rows + 1;
		};

		const renderRow = (item: SelectItem, isSelected: boolean, width: number): string => {
			const text = `${isSelected ? "❯ " : "  "}${item.label}`;
			return frameLine(padLine(isSelected ? t.accent(t.bold(text)) : text, width), width, t, isSelected ? t.selectionBg : t.panelBg);
		};

		return {
			render: (width: number): string[] => {
				const lines: string[] = [
					boxTop(width, t),
					frameLine(padLine(t.accent(t.bold(opts.title)), width), width, t, t.panelBg),
					frameLine(padLine("", width), width, t, t.panelBg),
				];
				for (const prose of opts.proseLines ?? []) {
					lines.push(frameLine(padLine(t.muted(prose), width), width, t, t.panelBg));
				}
				const filterText = query.length > 0 ? `Filter: ${query}` : "Type to filter…";
				lines.push(frameLine(padLine(query.length > 0 ? t.accent(filterText) : t.dim(filterText), width), width, t, t.panelBg));
				lines.push(frameLine(padLine("", width), width, t, t.panelBg));

				if (filtered.length === 0) {
					lines.push(frameLine(padLine(t.warning("no matches"), width), width, t, t.panelBg));
				} else {
					const rows = visibleRows();
					const end = Math.min(scroll + rows, filtered.length);
					for (let i = scroll; i < end; i++) {
						lines.push(renderRow(filtered[i], i === selected, width));
					}
					if (filtered.length > rows) {
						lines.push(frameLine(padLine(t.dim(`showing ${scroll + 1}–${end} of ${filtered.length} — type to narrow`), width), width, t, t.panelBg));
					}
				}

				lines.push(frameLine(padLine(t.dim(NAV_HINT), width), width, t, t.panelBg), boxBottom(width, t));
				return lines;
			},
			invalidate: () => {},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (isBackspace(data)) {
					if (query.length > 0) {
						query = query.slice(0, -1);
						refilter();
					}
				} else if (isPrintable(data)) {
					query += data;
					refilter();
				} else if (matchesKey(data, Key.up)) {
					move(-1);
				} else if (matchesKey(data, Key.down)) {
					move(1);
				} else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
					if (filtered.length > 0) done(filtered[selected].value);
				}
				tui.requestRender();
			},
		};
	}, pickerOverlay());
}
