import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { DiscoveryCache, DoctorReport, ManagedConfig, ModelPolicy, ParameterSourceCandidate } from "./types.js";

/**
 * Structural color functions so tui.ts only depends on pi-tui.
 * Adapt Pi's Theme via overlayThemeFromPi; tests use plainOverlayTheme.
 */
export interface OverlayTheme {
  accent(text: string): string;
  border(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  bold(text: string): string;
  /** Background fill for the floating panel body (Pi: customMessageBg). */
  panelBg(text: string): string;
  /** Background fill for the highlighted row (Pi: selectedBg). */
  selectionBg(text: string): string;
}

export const plainOverlayTheme: OverlayTheme = {
  accent: (text) => text,
  border: (text) => text,
  muted: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  error: (text) => text,
  bold: (text) => text,
  panelBg: (text) => text,
  selectionBg: (text) => text,
};

type PiThemeColor = "accent" | "border" | "muted" | "dim" | "success" | "warning" | "error";
type PiThemeBg = "customMessageBg" | "selectedBg";

export function overlayThemeFromPi(theme: {
  fg(color: PiThemeColor, text: string): string;
  bold(text: string): string;
  bg?(color: PiThemeBg, text: string): string;
}): OverlayTheme {
  const bg = typeof theme.bg === "function" ? theme.bg.bind(theme) : undefined;
  return {
    accent: (text) => theme.fg("accent", text),
    border: (text) => theme.fg("border", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
    bold: (text) => theme.bold(text),
    // Pi's Theme.bg resets only the background (49m) and fg styles reset only
    // the foreground (39m), so wrapping whole lines composes cleanly.
    panelBg: bg ? (text) => bg("customMessageBg", text) : (text) => text,
    selectionBg: bg ? (text) => bg("selectedBg", text) : (text) => text,
  };
}

export interface ModelOverlayState {
  selected: number;
  query: string;
  filter: "all" | "included" | "excluded" | "unsourced";
}

export interface ModelOverlayChanges {
  policy: ModelPolicy;
  sources: Record<string, string>;
}

export type ModelOverlayAction =
  | { type: "back"; state: ModelOverlayState }
  | { type: "save"; changes: ModelOverlayChanges; state: ModelOverlayState }
  | { type: "editFields"; modelId: string; state: ModelOverlayState }
  | { type: "testModel"; modelId: string; state: ModelOverlayState }
  | { type: "probeReasoning"; modelId: string; state: ModelOverlayState };

interface ListNavigationInput {
  keybindings?: KeybindingsManager;
}

export class DoctorReportOverlay implements Component {
  private scroll = 0;

  constructor(
    private readonly report: DoctorReport,
    private readonly done: () => void,
    private readonly theme: OverlayTheme = plainOverlayTheme,
  ) {}

  render(width: number): string[] {
    const t = this.theme;
    const maxRows = listCapacity(6);
    const issues = this.report.issues;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, issues.length - maxRows)));
    const visible = issues.slice(this.scroll, this.scroll + maxRows);
    const lines: string[] = [];
    lines.push(padLine(t.accent(t.bold("Doctor Report")), width));
    lines.push(padLine(t.muted(this.report.configDir), width));
    lines.push(padLine("", width));
    for (const issue of visible) {
      lines.push(padLine(`${statusColor(t, issue.level)(fitCell(issue.level.toUpperCase(), 7))} ${issue.code}: ${issue.message}`, width));
    }
    if (visible.length === 0) lines.push(padLine(t.muted("No issues recorded."), width));
    const scroll = scrollInfo(issues.length, this.scroll, this.scroll + visible.length);
    lines.push(padLine("", width));
    lines.push(padLine(t.dim(scroll ? `${scroll} · ↑↓ scroll · esc close` : "↑↓ scroll · esc close"), width));
    return [boxTop(width, t), ...lines.map((line) => frameLine(line, width, t)), boxBottom(width, t)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") this.done();
    else if (isUp(data, {}) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (isDown(data, {}) || data === "j") this.scroll += 1;
  }

  invalidate(): void {}
}

export class ReadOnlyTextOverlay implements Component {
  private scroll = 0;
  private readonly lines: string[];

  constructor(
    private readonly title: string,
    content: string,
    private readonly done: () => void,
    private readonly theme: OverlayTheme = plainOverlayTheme,
  ) {
    this.lines = content.split("\n");
  }

  render(width: number): string[] {
    const t = this.theme;
    const maxRows = listCapacity(5);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.lines.length - maxRows)));
    const visible = this.lines.slice(this.scroll, this.scroll + maxRows);
    const output: string[] = [];
    output.push(padLine(t.accent(t.bold(this.title)), width));
    output.push(padLine("", width));
    for (const line of visible) output.push(padLine(line, width));
    const scroll = scrollInfo(this.lines.length, this.scroll, this.scroll + visible.length);
    output.push(padLine("", width));
    output.push(padLine(t.dim(scroll ? `${scroll} · ↑↓ scroll · esc close` : "↑↓ scroll · esc close"), width));
    return [boxTop(width, t), ...output.map((line) => frameLine(line, width, t)), boxBottom(width, t)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") this.done();
    else if (isUp(data, {}) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (isDown(data, {}) || data === "j") this.scroll += 1;
  }

  invalidate(): void {}
}

type CachedProfileModels = NonNullable<DiscoveryCache["profiles"][string]>["models"];

/**
 * Buffered model manager: edits (include/exclude, policy, parameter source)
 * accumulate in memory and only persist on ctrl+s, mirroring Pi's scoped
 * models selector. Esc with unsaved changes asks once before discarding.
 */
export class ModelManagerOverlay implements Component {
  private selected: number;
  private query: string;
  private filter: ModelOverlayState["filter"];
  private view: "list" | "source" = "list";
  private sourceSelected = 0;
  private dirty = false;
  private confirmDiscard = false;
  private notice: string | undefined;

  private pendingPolicy: ModelPolicy;
  private pendingSources: Record<string, string>;
  private clearedSources = new Set<string>();

  constructor(
    private readonly input: {
      profile: ManagedConfig["profiles"][string];
      cache: NonNullable<DiscoveryCache["profiles"][string]>;
      initialState?: Partial<ModelOverlayState>;
      theme?: OverlayTheme;
      keybindings?: KeybindingsManager;
      onAction: (action: ModelOverlayAction) => void;
    },
  ) {
    this.selected = input.initialState?.selected ?? 0;
    this.query = input.initialState?.query ?? "";
    this.filter = input.initialState?.filter ?? "all";
    this.pendingPolicy = {
      mode: input.profile.modelPolicy.mode,
      include: input.profile.modelPolicy.include ? [...input.profile.modelPolicy.include] : [],
      exclude: input.profile.modelPolicy.exclude ? [...input.profile.modelPolicy.exclude] : [],
    };
    this.pendingSources = {};
    for (const [modelId, sourceId] of Object.entries(input.profile.parameterSourceSelections ?? {})) {
      if (input.cache.models[modelId]?.candidates.some((candidate) => candidate.sourceId === sourceId)) this.pendingSources[modelId] = sourceId;
    }
  }

  render(width: number): string[] {
    return this.view === "source" ? this.renderSourceView(width) : this.renderListView(width);
  }

  private renderListView(width: number): string[] {
    const t = this.input.theme ?? plainOverlayTheme;
    const inner = Math.max(20, width - 4);
    const models = this.filteredModels();
    this.clampSelected(models.length);
    const allModels = Object.values(this.input.cache.models);
    const included = allModels.filter((model) => this.isIncluded(model.id)).length;

    const lines: string[] = [];
    const title = t.accent(t.bold(`Models · ${this.input.profile.id}`));
    const dirtyHint = this.dirty ? t.warning("● unsaved — ctrl+s to save") : "";
    lines.push(padLine(titleWithHint(title, dirtyHint, inner), width));
    const summary = [`policy ${this.pendingPolicy.mode}`, `${included}/${allModels.length} included`, `filter ${this.filter}`];
    lines.push(padLine(t.muted(summary.join(" · ")), width));
    if (this.input.profile.api === "openai-completions") lines.push(padLine(this.reasoningStatusLine(), width));
    lines.push(padLine(this.query ? `search: ${this.query}${t.accent("▌")}` : t.dim("type to search"), width));
    lines.push(padLine("", width));

    const maxRows = listCapacity(11);
    const { start, end } = visibleWindow(models.length, this.selected, maxRows);
    const idWidth = Math.max(14, Math.min(34, Math.floor((inner - 20) * 0.42)));
    const sourceWidth = Math.max(12, inner - 4 - idWidth - 1 - 12 - 2);
    let selectedRowLine = -1;
    for (let index = start; index < end; index += 1) {
      const model = models[index]!;
      const isSelected = index === this.selected;
      const marker = isSelected ? t.accent("→ ") : "  ";
      const includedHere = this.isIncluded(model.id);
      const inc = includedHere ? t.success("✓ ") : t.dim("✗ ");
      const id = fitCell(model.id, idWidth);
      const source = this.describeSource(model.id);
      const sourceCell = fitCell(source.label, sourceWidth);
      const match = this.matchFor(model.id);
      const cells = [
        isSelected ? t.accent(id) : includedHere ? id : t.dim(id),
        source.pending ? t.warning(sourceCell) : source.explicit ? sourceCell : t.muted(sourceCell),
        matchColor(t, match)(fitCell(match, 10)),
      ];
      lines.push(padLine(`${marker}${inc}${cells.join(" ")}`, width));
      if (isSelected) selectedRowLine = lines.length - 1;
    }
    if (models.length === 0) lines.push(padLine(t.muted("No models match the current filter/search."), width));
    const scroll = scrollInfo(models.length, start, end);
    if (scroll) lines.push(padLine(t.muted(`  ${scroll}`), width));

    lines.push(padLine("", width));
    if (this.confirmDiscard) {
      lines.push(padLine(t.warning("Unsaved changes — esc again to discard, ctrl+s to save."), width));
    } else if (this.notice) {
      lines.push(padLine(t.warning(this.notice), width));
    }
    const toggleWord = this.pendingPolicy.mode === "includeAll" ? "enter exclude/restore" : "enter include/remove";
    const hintParts = [toggleWord, "tab source", "ctrl+e edit fields", "ctrl+t test model", "ctrl+p policy", "ctrl+f filter", "ctrl+s save", "esc back"];
    if (this.input.profile.api === "openai-completions") hintParts.splice(4, 0, "ctrl+r probe reasoning");
    for (const hintLine of flowHints(hintParts, inner)) {
      lines.push(padLine(t.dim(hintLine), width));
    }
    return [
      boxTop(width, t),
      ...lines.map((line, lineIndex) => frameLine(line, width, t, lineIndex === selectedRowLine ? t.selectionBg : t.panelBg)),
      boxBottom(width, t),
    ];
  }

  /** One-line reasoning_effort status: manual override, probe outcome, or pending. */
  private reasoningStatusLine(): string {
    const t = this.input.theme ?? plainOverlayTheme;
    const profile = this.input.profile;
    const probe = this.input.cache.reasoning;
    if (profile.reasoningEfforts && profile.reasoningEfforts.length > 0) {
      return t.accent(`reasoning efforts: manual [${profile.reasoningEfforts.join(", ")}] — wins over probe`);
    }
    if (probe?.error) return t.warning(`reasoning probe failed: ${probe.error}`);
    if (probe) {
      const accepted = probe.accepted.length > 0 ? probe.accepted.join(", ") : "none";
      const rejectedHint = probe.accepted.length === 0 && probe.rejected.some((item) => !item.effortRelated) ? " (inconclusive)" : "";
      return t.accent(`reasoning efforts: accepted [${accepted}]${rejectedHint} · ctrl+r re-probe`);
    }
    if (profile.discovery.reasoningProbe) return t.dim("reasoning probe pending — refresh or ctrl+r");
    return t.dim("reasoning: canonical low/medium/high — enable discovery.reasoningProbe or set reasoning efforts");
  }

  private renderSourceView(width: number): string[] {
    const t = this.input.theme ?? plainOverlayTheme;
    const inner = Math.max(20, width - 4);
    const model = this.filteredModels()[this.selected];
    const candidates = model?.candidates ?? [];
    const sourceRows = ["(auto)", ...candidates.map((candidate) => candidate.sourceId)];
    this.sourceSelected = Math.max(0, Math.min(this.sourceSelected, Math.max(0, sourceRows.length - 1)));
    const currentSourceId = model ? this.resolveSourceId(model.id) : undefined;

    const lines: string[] = [];
    lines.push(padLine(t.accent(t.bold(`Parameter Source · ${model?.id ?? ""}`)), width));
    lines.push(padLine(t.muted("choose where this model's parameters come from"), width));
    lines.push(padLine(t.muted("exact = same id · normalized = id variant · fuzzy = similar id — verify before trusting"), width));
    lines.push(padLine("", width));

    const maxRows = listCapacity(8);
    const { start, end } = visibleWindow(sourceRows.length, this.sourceSelected, maxRows);
    const infoWidth = 26;
    const sourceWidth = Math.max(16, inner - 2 - 1 - 10 - 1 - infoWidth - 1 - 9);
    let selectedRowLine = -1;
    for (let index = start; index < end; index += 1) {
      const candidate = index === 0 ? undefined : candidates[index - 1]!;
      const isSelected = index === this.sourceSelected;
      const marker = isSelected ? t.accent("→ ") : "  ";
      const sourceCell = fitCell(candidate?.sourceId ?? "(auto)", sourceWidth);
      const cells = [
        isSelected ? t.accent(sourceCell) : sourceCell,
        candidate ? matchColor(t, candidate.match)(fitCell(candidate.match, 10)) : t.muted(fitCell("auto", 10)),
        t.muted(fitCell(candidate ? describeCandidate(candidate) : "candidates[0]", infoWidth)),
        (candidate ? candidate.sourceId === currentSourceId : !currentSourceId) ? t.muted("(current)") : "         ",
      ];
      lines.push(padLine(`${marker}${cells.join(" ")}`, width));
      if (isSelected) selectedRowLine = lines.length - 1;
    }
    const scroll = scrollInfo(sourceRows.length, start, end);
    if (scroll) lines.push(padLine(t.muted(`  ${scroll}`), width));
    lines.push(padLine("", width));
    lines.push(padLine(t.dim("enter select · esc back"), width));
    return [
      boxTop(width, t),
      ...lines.map((line, lineIndex) => frameLine(line, width, t, lineIndex === selectedRowLine ? t.selectionBg : t.panelBg)),
      boxBottom(width, t),
    ];
  }

  handleInput(data: string): void {
    const wasConfirmingDiscard = this.confirmDiscard;
    this.notice = undefined;
    if (this.view === "source") return this.handleSourceInput(data);

    const models = this.filteredModels();
    this.clampSelected(models.length);
    const selectedModel = models[this.selected];

    if (matchesKey(data, Key.escape)) {
      if (wasConfirmingDiscard) return this.input.onAction({ type: "back", state: this.state() });
      if (this.query) {
        this.query = "";
        this.selected = 0;
        return;
      }
      if (this.dirty) {
        this.confirmDiscard = true;
        return;
      }
      return this.input.onAction({ type: "back", state: this.state() });
    }
    this.confirmDiscard = false;

    if (matchesKey(data, Key.ctrl("s"))) {
      if (!this.dirty) {
        this.notice = "Nothing to save.";
        return;
      }
      return this.input.onAction({ type: "save", changes: { policy: activePolicy(this.pendingPolicy), sources: { ...this.pendingSources } }, state: this.state() });
    }
    if (selectedModel && matchesKey(data, Key.ctrl("e"))) return this.input.onAction({ type: "editFields", modelId: selectedModel.id, state: this.state() });
    if (selectedModel && matchesKey(data, Key.ctrl("t"))) return this.input.onAction({ type: "testModel", modelId: selectedModel.id, state: this.state() });
    if (this.input.profile.api === "openai-completions" && selectedModel && matchesKey(data, Key.ctrl("r"))) {
      return this.input.onAction({ type: "probeReasoning", modelId: selectedModel.id, state: this.state() });
    }
    if (isUp(data, this.input)) this.selected = Math.max(0, this.selected - 1);
    else if (isDown(data, this.input)) this.selected = Math.min(Math.max(0, models.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.ctrl("p"))) this.cyclePolicy();
    else if (matchesKey(data, Key.ctrl("f"))) this.cycleFilter();
    else if (matchesKey(data, Key.tab)) {
      if (!selectedModel) return;
      if (selectedModel.candidates.length === 0) {
        this.notice = `${selectedModel.id} has no Parameter Source candidates — refresh or add overrides.`;
        return;
      }
      const currentId = this.resolveSourceId(selectedModel.id);
      const currentIndex = currentId ? selectedModel.candidates.findIndex((candidate) => candidate.sourceId === currentId) + 1 : 0;
      this.sourceSelected = Math.max(0, currentIndex);
      this.view = "source";
    } else if (selectedModel && (isConfirm(data, this.input) || data === " ")) this.toggleModel(selectedModel.id);
    else if (matchesKey(data, Key.backspace)) {
      this.query = this.query.slice(0, -1);
      this.selected = 0;
    } else if (data.length === 1 && data > " ") {
      this.query += data;
      this.selected = 0;
    }
  }

  private handleSourceInput(data: string): void {
    const model = this.filteredModels()[this.selected];
    const candidates = model?.candidates ?? [];
    const sourceRows = ["(auto)", ...candidates.map((candidate) => candidate.sourceId)];
    if (matchesKey(data, Key.escape)) {
      this.view = "list";
      return;
    }
    if (isUp(data, this.input)) this.sourceSelected = Math.max(0, this.sourceSelected - 1);
    else if (isDown(data, this.input)) this.sourceSelected = Math.min(Math.max(0, sourceRows.length - 1), this.sourceSelected + 1);
    else if (model && isConfirm(data, this.input)) {
      if (this.sourceSelected === 0) {
        delete this.pendingSources[model.id];
        this.clearedSources.add(model.id);
        this.dirty = true;
      } else {
        const candidate = candidates[this.sourceSelected - 1];
        if (!candidate) return;
        this.pendingSources[model.id] = candidate.sourceId;
        this.clearedSources.delete(model.id);
        this.dirty = true;
      }
      this.view = "list";
    }
  }

  invalidate(): void {}

  private toggleModel(modelId: string): void {
    if (this.pendingPolicy.mode === "includeOnly") {
      const set = new Set(this.pendingPolicy.include ?? []);
      set.has(modelId) ? set.delete(modelId) : set.add(modelId);
      this.pendingPolicy.include = [...set].sort();
    } else {
      const set = new Set(this.pendingPolicy.exclude ?? []);
      set.has(modelId) ? set.delete(modelId) : set.add(modelId);
      this.pendingPolicy.exclude = [...set].sort();
    }
    this.dirty = true;
  }

  private cyclePolicy(): void {
    this.pendingPolicy = { ...this.pendingPolicy, mode: this.pendingPolicy.mode === "includeAll" ? "includeOnly" : "includeAll" };
    this.dirty = true;
  }

  private describeSource(modelId: string): { label: string; pending: boolean; explicit: boolean } {
    const pending = this.pendingSources[modelId];
    const saved = this.resolveSavedSourceId(modelId);
    if (pending && pending !== saved) return { label: `* ${pending}`, pending: true, explicit: true };
    if (saved) return { label: saved, pending: false, explicit: true };
    const fallback = this.fallbackSourceId(modelId);
    if (!fallback || fallback === "generated-default") return { label: "(built-in defaults — verify)", pending: false, explicit: false };
    return { label: fallback, pending: false, explicit: false };
  }

  private matchFor(modelId: string): string {
    const model = this.input.cache.models[modelId];
    const sourceId = this.resolveSourceId(modelId) ?? this.fallbackSourceId(modelId);
    return model?.candidates.find((candidate) => candidate.sourceId === sourceId)?.match ?? "—";
  }

  private resolveSourceId(modelId: string): string | undefined {
    return this.pendingSources[modelId] ?? this.resolveSavedSourceId(modelId);
  }

  private resolveSavedSourceId(modelId: string): string | undefined {
    if (this.clearedSources.has(modelId)) return undefined;
    const sourceId = this.input.profile.parameterSourceSelections?.[modelId];
    const model = this.input.cache.models[modelId];
    return sourceId && model?.candidates.some((candidate) => candidate.sourceId === sourceId) ? sourceId : undefined;
  }

  private fallbackSourceId(modelId: string): string | undefined {
    return this.input.cache.models[modelId]?.candidates[0]?.sourceId;
  }

  private filteredModels(): CachedProfileModels[string][] {
    const query = this.query.toLowerCase();
    return Object.values(this.input.cache.models).filter((model) => {
      if (query && !model.id.toLowerCase().includes(query) && !(model.name ?? "").toLowerCase().includes(query)) return false;
      if (this.filter === "included") return this.isIncluded(model.id);
      if (this.filter === "excluded") return !this.isIncluded(model.id);
      if (this.filter === "unsourced") return !this.resolveSourceId(model.id) && this.fallbackSourceId(model.id) === "generated-default";
      return true;
    });
  }

  private isIncluded(modelId: string): boolean {
    if (this.pendingPolicy.mode === "includeOnly") return this.pendingPolicy.include?.includes(modelId) ?? false;
    return !(this.pendingPolicy.exclude?.includes(modelId) ?? false);
  }

  private cycleFilter(): void {
    const filters: Array<typeof this.filter> = ["all", "included", "excluded", "unsourced"];
    this.filter = filters[(filters.indexOf(this.filter) + 1) % filters.length]!;
    this.selected = 0;
  }

  private clampSelected(total: number): void {
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, total - 1)));
  }

  private state(): ModelOverlayState {
    return { selected: this.selected, query: this.query, filter: this.filter };
  }
}

function activePolicy(policy: ModelPolicy): ModelPolicy {
  return policy.mode === "includeOnly" ? { mode: "includeOnly", include: policy.include ?? [] } : { mode: "includeAll", exclude: policy.exclude ?? [] };
}

export function formatAge(refreshedAtIso: string, now = new Date()): string {
  const refreshedAt = new Date(refreshedAtIso);
  const ageMs = now.getTime() - refreshedAt.getTime();
  if (!Number.isFinite(ageMs)) return "unknown";
  if (ageMs < 60 * 1000) return "just now";
  const minutes = Math.floor(ageMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function describeCandidate(candidate: ParameterSourceCandidate): string {
  const ctx = `${Math.round(candidate.model.contextWindow / 1000)}k ctx`;
  const cost = `$${trimNumber(candidate.model.cost.input)}/$${trimNumber(candidate.model.cost.output)}`;
  return `${ctx} · ${cost}`;
}

function trimNumber(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "") || "0";
}

function statusColor(t: OverlayTheme, status: string): (text: string) => string {
  if (status === "error") return t.error;
  if (status === "warning") return t.warning;
  if (status === "healthy") return t.success;
  if (status === "info") return t.muted;
  return t.dim;
}

function matchColor(t: OverlayTheme, match: string): (text: string) => string {
  if (match === "exact") return t.success;
  if (match === "fuzzy") return t.warning;
  if (match === "normalized") return t.muted;
  return t.dim;
}

function isUp(data: string, input: ListNavigationInput): boolean {
  return input.keybindings?.matches(data, "tui.select.up") ?? matchesKey(data, "up");
}

function isDown(data: string, input: ListNavigationInput): boolean {
  return input.keybindings?.matches(data, "tui.select.down") ?? matchesKey(data, "down");
}

function isConfirm(data: string, input: ListNavigationInput): boolean {
  return input.keybindings?.matches(data, "tui.select.confirm") ?? (data === "\r" || data === "\n");
}

/** ┌───┐ top edge of a boxed overlay panel, filled with the panel background. */
export function boxTop(width: number, t: OverlayTheme): string {
  return t.panelBg(t.border(`┌${"─".repeat(Math.max(0, width - 2))}┐`));
}

/** └───┘ bottom edge of a boxed overlay panel, filled with the panel background. */
export function boxBottom(width: number, t: OverlayTheme): string {
  return t.panelBg(t.border(`└${"─".repeat(Math.max(0, width - 2))}┘`));
}

/**
 * One frame row: │ content │. Content is clipped/padded to width - 2 and
 * callers keep one space of padding inside each border via padLine. The whole
 * row (borders included) is painted with the panel background so the panel
 * reads as a solid card; pass t.selectionBg for the highlighted row.
 */
export function frameLine(content: string, width: number, t: OverlayTheme, bg: (text: string) => string = t.panelBg): string {
  const inner = Math.max(0, width - 2);
  const singleLine = content.replace(/[\r\n]+/g, " ");
  const clipped = truncateToWidth(singleLine, inner);
  return bg(`${t.border("│")}${padVisible(clipped, inner)}${t.border("│")}`);
}

/** Pad to width - 4 so frameLine can wrap the line in "│ " and " " borders. */
function padLine(content: string, width: number): string {
  const inner = Math.max(0, width - 4);
  const singleLine = content.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
  const clipped = truncateToWidth(singleLine, inner);
  return ` ${padVisible(clipped, inner)} `;
}

function titleWithHint(title: string, hint: string, innerWidth: number): string {
  if (!hint) return title;
  const gap = innerWidth - visibleWidth(title) - visibleWidth(hint);
  if (gap < 2) return `${title}  ${hint}`;
  return `${title}${" ".repeat(gap)}${hint}`;
}

/** Flow hint fragments into lines separated by " · ", wrapping at width. */
function flowHints(hints: string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const hint of hints) {
    const candidate = current ? `${current} · ${hint}` : hint;
    if (current && visibleWidth(candidate) > width) {
      lines.push(current);
      current = hint;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Overlay maxHeight clips from the bottom, which would eat the footer, so
 * cap list rows from the terminal height ourselves.
 */
export function listCapacity(chromeLines: number): number {
  const rows = process.stdout.rows || 40;
  return Math.max(0, Math.min(16, Math.floor(rows * 0.8) - chromeLines));
}

function padVisible(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function fitCell(value: string, width: number): string {
  return padVisible(truncateToWidth(value, width), width);
}

function visibleWindow(total: number, selected: number, maxRows: number): { start: number; end: number } {
  if (total <= 0 || maxRows <= 0) return { start: 0, end: 0 };
  const half = Math.floor(maxRows / 2);
  const start = Math.max(0, Math.min(selected - half, total - maxRows));
  return { start, end: Math.min(total, start + maxRows) };
}

function scrollInfo(total: number, start: number, end: number): string {
  const above = Math.max(0, start);
  const below = Math.max(0, total - end);
  if (above === 0 && below === 0) return "";
  const parts: string[] = [];
  if (above > 0) parts.push(`↑ ${above} more`);
  if (below > 0) parts.push(`↓ ${below} more`);
  return parts.join("  ");
}
