import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { normalizeProfile } from "./config.js";
import { ModelManagerOverlay, boxBottom, boxTop, frameLine, plainOverlayTheme, type ModelOverlayChanges, type ModelOverlayState, type OverlayTheme } from "./tui.js";
import type {
  EndpointDiscoveryResult,
  ManagedConfig,
  EndpointAuthMode,
  EndpointDraft,
  EndpointManagerData,
  EndpointManagerOperations,
  EndpointProfile,
} from "./types.js";

type SessionView = "list" | "form" | "models" | "completion";
type FormMode = "add" | "edit";
type FormSubView = "fields" | "protocol" | "auth" | "discovery";
type FormField = "name" | "id" | "api" | "baseUrl" | "auth" | "discovery" | "modelsPath" | "modelsUrl" | "probe" | "reasoningProbe" | "reasoningEfforts" | "modelIds" | "headers" | "enabled";

const FORM_FIELDS: FormField[] = ["name", "id", "api", "baseUrl", "auth", "discovery", "modelsPath", "modelsUrl", "probe", "reasoningProbe", "reasoningEfforts", "modelIds", "headers", "enabled"];
const AUTH_MODES: EndpointAuthMode[] = ["none", "environment", "literal", "command"];

interface CompletionState {
  profileId: string;
  modelCount: number;
}

export function nextEndpointId(config: ManagedConfig): string {
  if (!config.profiles["endpoint-1"]) return "endpoint-1";
  let suffix = 2;
  while (config.profiles[`endpoint-${suffix}`]) suffix += 1;
  return `endpoint-${suffix}`;
}

export function endpointDraftFromProfile(profile: EndpointProfile): EndpointDraft {
  const auth = describeAuth(profile.apiKey);
  return {
    originalId: profile.id,
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    api: profile.api,
    baseUrl: profile.baseUrl,
    authMode: auth.mode,
    authValue: auth.value,
    discoveryMode: profile.discovery.mode,
    modelsPath: profile.discovery.modelsPath,
    modelsUrl: profile.discovery.modelsUrl ?? "",
    probe: profile.discovery.probe ?? false,
    reasoningProbe: profile.discovery.reasoningProbe ?? false,
    reasoningEfforts: profile.reasoningEfforts?.join(", ") ?? "",
    modelIds: profile.discovery.modelIds?.join(", ") ?? "",
    headersJson: JSON.stringify(profile.headers ?? {}),
  };
}

export function newEndpointDraft(config: ManagedConfig): EndpointDraft {
  return {
    id: nextEndpointId(config),
    name: "Endpoint",
    enabled: true,
    api: undefined,
    baseUrl: "http://localhost:1234/v1",
    authMode: "none",
    authValue: "",
    discoveryMode: "endpoint",
    modelsPath: "/models",
    modelsUrl: "",
    probe: false,
    reasoningProbe: false,
    reasoningEfforts: "",
    modelIds: "",
    headersJson: "{}",
  };
}

export function profileFromEndpointDraft(draft: EndpointDraft): EndpointProfile {
  const headers = parseHeaders(draft.headersJson);
  const modelIds = parseModelIds(draft.modelIds);
  return normalizeProfile({
    id: draft.id.trim(),
    enabled: draft.enabled,
    name: draft.name.trim(),
    api: draft.api?.trim() ?? "",
    baseUrl: draft.baseUrl.trim(),
    apiKey: authValue(draft.authMode, draft.authValue),
    headers,
    reasoningEfforts: parseModelIds(draft.reasoningEfforts),
    discovery: draft.discoveryMode === "manual"
      ? { mode: "manual", modelsPath: draft.modelsPath.trim() || "/models", reasoningProbe: draft.reasoningProbe, modelIds }
      : { mode: "endpoint", modelsPath: draft.modelsPath.trim(), modelsUrl: draft.modelsUrl.trim() || undefined, probe: draft.probe, reasoningProbe: draft.reasoningProbe },
  });
}

export class EndpointManagerSessionOverlay implements Component, Focusable {
  private data: EndpointManagerData;
  private view: SessionView;
  private listSelected = 0;
  private formMode: FormMode = "add";
  private formSubView: FormSubView = "fields";
  private formSelected = 0;
  private optionSelected = 0;
  private draft: EndpointDraft;
  private input = new Input();
  private editingField: FormField | undefined;
  private notice: { type: "info" | "warning" | "error"; message: string } | undefined;
  private connectionResult: EndpointDiscoveryResult | undefined;
  private connectionFingerprint: string | undefined;
  private activeAbort: AbortController | undefined;
  private busyMessage: string | undefined;
  private modelState: Partial<ModelOverlayState> | undefined;
  private modelOverlay: ModelManagerOverlay | undefined;
  private completion: CompletionState | undefined;
  private closed = false;
  private _focused = false;

  constructor(
    private readonly options: {
      tui: TUI;
      data: EndpointManagerData;
      operations: EndpointManagerOperations;
      done: () => void;
      initialView?: "list" | "add";
      theme?: OverlayTheme;
    },
  ) {
    this.data = options.data;
    this.view = options.initialView === "add" ? "form" : "list";
    this.draft = newEndpointDraft(this.data.config);
    if (this.view === "form") this.beginAdd();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.editingField !== undefined;
  }

  render(width: number): string[] {
    if (this.view === "form") return this.renderForm(width);
    if (this.view === "models") return this.requireModelOverlay().render(width);
    if (this.view === "completion") return this.renderCompletion(width);
    return this.renderList(width);
  }

  handleInput(data: string): void {
    if (this.busyMessage) {
      if (matchesKey(data, Key.escape)) this.activeAbort?.abort();
      return;
    }
    if (this.view === "models") {
      this.requireModelOverlay().handleInput(data);
      this.options.tui.requestRender();
      return;
    }
    if (this.view === "completion") {
      this.handleCompletionInput(data);
      this.options.tui.requestRender();
      return;
    }
    if (this.view === "form") {
      this.handleFormInput(data);
      this.options.tui.requestRender();
      return;
    }
    this.handleListInput(data);
    this.options.tui.requestRender();
  }

  invalidate(): void {
    this.modelOverlay?.invalidate();
    this.input.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.activeAbort?.abort();
  }

  private renderList(width: number): string[] {
    const t = this.theme();
    const inner = Math.max(20, width - 4);
    const profiles = Object.values(this.data.config.profiles);
    this.listSelected = clampIndex(this.listSelected, profiles.length);
    const lines = [padLine(titleWithHint(t.accent(t.bold("Endpoints")), t.muted(`${profiles.length} profile${profiles.length === 1 ? "" : "s"}`), inner), width), padLine("", width)];
    let selectedRowLine = -1;

    if (profiles.length === 0) {
      lines.push(padLine(t.muted("No Endpoints yet."), width));
      lines.push(padLine(t.accent("Press a to add an endpoint."), width));
    } else {
      const maxRows = Math.max(1, Math.min(12, Math.floor((process.stdout.rows || 40) * 0.7) - 8));
      const { start, end } = visibleWindow(profiles.length, this.listSelected, maxRows);
      for (let index = start; index < end; index += 1) {
        const profile = profiles[index]!;
        const cache = this.data.cache?.profiles[profile.id];
        const issue = this.data.doctor.issues.find((item) => item.profileId === profile.id && item.level !== "info");
        const status = issue?.level ?? (cache ? "healthy" : "not refreshed");
        const selected = index === this.listSelected;
        const marker = selected ? t.accent("→ ") : "  ";
        const primary = `${profile.name}${profile.enabled ? "" : " (off)"}`;
        const endpoint = compactEndpoint(profile.baseUrl);
        const detail = `${profile.id} · ${profile.api} · ${endpoint} · ${cache ? `${Object.keys(cache.models).length} models` : "no cache"} · ${status}`;
        lines.push(padLine(`${marker}${selected ? t.accent(primary) : primary}`, width));
        lines.push(padLine(`    ${t.muted(detail)}`, width));
        if (selected) selectedRowLine = lines.length - 2;
      }
    }

    lines.push(padLine("", width));
    if (this.notice) lines.push(padLine(noticeColor(t, this.notice.type)(this.notice.message), width));
    lines.push(padLine(t.dim("enter models · a add · e edit · r refresh · t test · y clone · x delete · c overrides · esc close"), width));
    return [
      boxTop(width, t),
      ...lines.map((line, lineIndex) => frameLine(line, width, t, lineIndex === selectedRowLine ? t.selectionBg : t.panelBg)),
      boxBottom(width, t),
    ];
  }

  private renderForm(width: number): string[] {
    const t = this.theme();
    const inner = Math.max(20, width - 4);
    const title = this.formMode === "add" ? "Add Endpoint" : `Edit Endpoint · ${this.draft.originalId}`;
    const lines = [padLine(t.accent(t.bold(title)), width), padLine(t.muted("Choose the Pi API protocol explicitly. The extension never infers it from the URL."), width), padLine("", width)];

    if (this.formSubView !== "fields") return this.renderOptions(width);

    const visibleFields = this.visibleFormFields();
    this.formSelected = clampIndex(this.formSelected, visibleFields.length);
    let selectedFieldLine = -1;
    let selectedDescLine = -1;
    for (let index = 0; index < visibleFields.length; index += 1) {
      const field = visibleFields[index]!;
      const selected = index === this.formSelected;
      const marker = selected ? t.accent("→ ") : "  ";
      const label = fitCell(fieldLabel(field), 17);
      let value: string;
      if (selected && this.editingField === field) {
        this.input.focused = this.focused;
        value = this.input.render(Math.max(10, inner - 22))[0] ?? "";
      } else {
        value = this.displayFieldValue(field);
      }
      lines.push(padLine(`${marker}${selected ? t.accent(label) : label}${value}`, width));
      if (selected) {
        selectedFieldLine = lines.length - 1;
        lines.push(padLine(`    ${t.dim(fieldDescription(field))}`, width));
        selectedDescLine = lines.length - 1;
      }
    }

    lines.push(padLine("", width));
    if (this.busyMessage) lines.push(padLine(t.warning(`${this.busyMessage} · esc cancel`), width));
    else if (this.notice) lines.push(padLine(noticeColor(t, this.notice.type)(this.notice.message), width));
    else if (this.connectionResult && this.connectionFingerprint === this.currentConnectionFingerprint()) {
      lines.push(padLine(t.success(`Connected · ${this.connectionResult.models.length} model${this.connectionResult.models.length === 1 ? "" : "s"} discovered`), width));
    } else {
      lines.push(padLine(t.muted(this.draft.discoveryMode === "manual" ? "Manual discovery will be validated on save." : "Connection not tested."), width));
    }
    lines.push(padLine(t.dim(this.editingField ? "enter apply · esc cancel edit" : "enter edit/select · ctrl+t test connection · ctrl+s save · esc back"), width));
    return [
      boxTop(width, t),
      ...lines.map((line, lineIndex) => frameLine(line, width, t, lineIndex === selectedFieldLine || lineIndex === selectedDescLine ? t.selectionBg : t.panelBg)),
      boxBottom(width, t),
    ];
  }

  private renderOptions(width: number): string[] {
    const t = this.theme();
    const options = this.formOptionRows();
    const lines: string[] = [];
    this.optionSelected = clampIndex(this.optionSelected, options.length);
    lines.push(padLine(t.accent(t.bold(optionTitle(this.formSubView))), width));
    lines.push(padLine("", width));
    let selectedOptionLine = -1;
    for (let index = 0; index < options.length; index += 1) {
      const selected = index === this.optionSelected;
      lines.push(padLine(`${selected ? t.accent("→ ") : "  "}${selected ? t.accent(options[index]!) : options[index]!}`, width));
      if (selected) selectedOptionLine = lines.length - 1;
    }
    lines.push(padLine("", width));
    lines.push(padLine(t.dim("enter select · esc back"), width));
    return [
      boxTop(width, t),
      ...lines.map((line, lineIndex) => frameLine(line, width, t, lineIndex === selectedOptionLine ? t.selectionBg : t.panelBg)),
      boxBottom(width, t),
    ];
  }

  private renderCompletion(width: number): string[] {
    const t = this.theme();
    const completion = this.completion;
    if (!completion) throw new Error("Completion view is missing state");
    const profile = this.data.config.profiles[completion.profileId];
    if (!profile) throw new Error(`Saved profile ${completion.profileId} is missing`);
    return [
      boxTop(width, t),
      ...[
        padLine(t.success(t.bold("Endpoint Added")), width),
        padLine("", width),
        padLine(profile.name, width),
        padLine(t.muted(profile.id), width),
        padLine("", width),
        padLine(t.success(`${completion.modelCount} model${completion.modelCount === 1 ? "" : "s"} available`), width),
        padLine(t.muted("Registered in the current Pi session."), width),
        padLine("", width),
        padLine(t.dim("enter manage models · t send test message · esc done"), width),
      ].map((line) => frameLine(line, width, t)),
      boxBottom(width, t),
    ];
  }

  private handleListInput(data: string): void {
    this.notice = undefined;
    const profiles = Object.values(this.data.config.profiles);
    this.listSelected = clampIndex(this.listSelected, profiles.length);
    const selected = profiles[this.listSelected];
    if (matchesKey(data, Key.escape) || data === "q") return this.close();
    if (isUp(data)) this.listSelected = Math.max(0, this.listSelected - 1);
    else if (isDown(data)) this.listSelected = Math.min(Math.max(0, profiles.length - 1), this.listSelected + 1);
    else if (data === "a") this.beginAdd();
    else if (selected && data === "e") this.beginEdit(selected);
    else if (selected && isConfirm(data)) this.openModels(selected.id);
    else if (selected && data === "r") this.runBusy("Refreshing endpoint…", (signal) => this.options.operations.refresh(selected.id, signal), (next) => { this.data = next; });
    else if (data === "R") this.runBusy("Refreshing endpoints…", (signal) => this.options.operations.refresh(undefined, signal), (next) => { this.data = next; });
    else if (selected && data === "x") this.runBusy("Deleting endpoint…", async () => this.options.operations.deleteProfile(selected.id), (next) => { this.data = next; this.listSelected = clampIndex(this.listSelected, Object.keys(next.config.profiles).length); });
    else if (selected && data === "y") this.runBusy("Cloning endpoint…", async () => this.options.operations.cloneProfile(selected.id), (next) => { this.data = next; });
    else if (data === "c") this.runBusy("Opening custom overrides…", async () => this.options.operations.editCustomOverrides(), (next) => { this.data = next; });
    else if (selected && data === "t") this.testSelectedProfile(selected.id);
  }

  private handleFormInput(data: string): void {
    if (this.editingField) return this.handleFieldEditInput(data);
    if (this.formSubView !== "fields") return this.handleFormOptionInput(data);
    if (matchesKey(data, Key.escape)) return this.returnToList();
    if (matchesKey(data, Key.ctrl("s"))) return this.saveDraft();
    if (matchesKey(data, Key.ctrl("t"))) return this.testDraftConnection();
    const fields = this.visibleFormFields();
    this.formSelected = clampIndex(this.formSelected, fields.length);
    if (isUp(data)) this.formSelected = Math.max(0, this.formSelected - 1);
    else if (isDown(data)) this.formSelected = Math.min(fields.length - 1, this.formSelected + 1);
    else if (fields[this.formSelected] === "auth" && (matchesKey(data, Key.right) || data === "l")) this.openOptions("auth", AUTH_MODES.indexOf(this.draft.authMode));
    else if (isConfirm(data)) this.activateFormField(fields[this.formSelected]!);
  }

  private handleFieldEditInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.editingField = undefined;
      this.input.setValue("");
      return;
    }
    if (isConfirm(data)) {
      const field = this.editingField;
      if (!field) throw new Error("No form field is being edited");
      this.applyEditedValue(field, this.input.getValue());
      this.editingField = undefined;
      this.input.setValue("");
      return;
    }
    this.input.handleInput(data);
    this.markConnectionStale(this.editingField);
  }

  private handleFormOptionInput(data: string): void {
    const rows = this.formOptionRows();
    this.optionSelected = clampIndex(this.optionSelected, rows.length);
    if (matchesKey(data, Key.escape)) {
      this.formSubView = "fields";
      return;
    }
    if (isUp(data)) this.optionSelected = Math.max(0, this.optionSelected - 1);
    else if (isDown(data)) this.optionSelected = Math.min(rows.length - 1, this.optionSelected + 1);
    else if (isConfirm(data)) this.applyFormOption();
  }

  private handleCompletionInput(data: string): void {
    const completion = this.completion;
    if (!completion) throw new Error("Completion view is missing state");
    if (matchesKey(data, Key.escape) || data === "q") return this.returnToList();
    if (isConfirm(data)) return this.openModels(completion.profileId);
    if (data === "t") this.testSelectedProfile(completion.profileId);
  }

  private beginAdd(): void {
    this.view = "form";
    this.formMode = "add";
    this.formSubView = "fields";
    this.formSelected = 0;
    this.draft = newEndpointDraft(this.data.config);
    this.connectionResult = undefined;
    this.connectionFingerprint = undefined;
    this.notice = undefined;
  }

  private beginEdit(profile: EndpointProfile): void {
    this.view = "form";
    this.formMode = "edit";
    this.formSubView = "fields";
    this.formSelected = 0;
    this.draft = endpointDraftFromProfile(profile);
    this.connectionResult = undefined;
    this.connectionFingerprint = undefined;
    this.notice = undefined;
  }

  private returnToList(): void {
    this.view = "list";
    this.formSubView = "fields";
    this.editingField = undefined;
    this.modelOverlay = undefined;
    this.completion = undefined;
    this.notice = undefined;
  }

  private activateFormField(field: FormField): void {
    if (field === "api") {
      const runtimeIndex = this.draft.api ? this.data.runtimeApis.indexOf(this.draft.api) : -1;
      return this.openOptions("protocol", runtimeIndex >= 0 ? runtimeIndex : this.draft.api ? this.data.runtimeApis.length : 0);
    }
    if (field === "auth") {
      if (this.draft.authMode !== "none" && !this.draft.authValue) {
        this.editingField = "auth";
        this.input.setValue("");
        this.input.focused = this.focused;
        return;
      }
      return this.openOptions("auth", AUTH_MODES.indexOf(this.draft.authMode));
    }
    if (field === "discovery") return this.openOptions("discovery", this.draft.discoveryMode === "endpoint" ? 0 : 1);
    if (field === "enabled") {
      this.draft.enabled = !this.draft.enabled;
      return;
    }
    if (field === "probe") {
      this.draft.probe = !this.draft.probe;
      this.markConnectionStale("discovery");
      return;
    }
    if (field === "reasoningProbe") {
      this.draft.reasoningProbe = !this.draft.reasoningProbe;
      this.markConnectionStale("discovery");
      return;
    }
    this.editingField = field;
    this.input.setValue(this.editableFieldValue(field));
    this.input.focused = this.focused;
  }

  private openOptions(view: Exclude<FormSubView, "fields">, selected: number): void {
    this.formSubView = view;
    this.optionSelected = Math.max(0, selected);
  }

  private applyFormOption(): void {
    if (this.formSubView === "protocol") {
      const options = [...this.data.runtimeApis, "custom…"];
      const selected = options[this.optionSelected];
      if (!selected) return;
      if (selected === "custom…") {
        this.formSubView = "fields";
        this.editingField = "api";
        this.input.setValue(this.draft.api && !this.data.runtimeApis.includes(this.draft.api) ? this.draft.api : "");
        return;
      }
      this.draft.api = selected;
      this.markConnectionStale("api");
    } else if (this.formSubView === "auth") {
      const mode = AUTH_MODES[this.optionSelected];
      if (!mode) return;
      this.draft.authMode = mode;
      if (mode === "none") {
        this.draft.authValue = "";
      } else {
        this.draft.authValue = "";
        this.formSubView = "fields";
        this.editingField = "auth";
        this.input.setValue("");
        this.input.focused = this.focused;
        this.markConnectionStale("auth");
        return;
      }
      this.markConnectionStale("auth");
    } else {
      this.draft.discoveryMode = this.optionSelected === 0 ? "endpoint" : "manual";
      this.markConnectionStale("discovery");
    }
    this.formSubView = "fields";
  }

  private applyEditedValue(field: FormField, value: string): void {
    if (field === "name") this.draft.name = value;
    else if (field === "id") this.draft.id = value;
    else if (field === "api") this.draft.api = value;
    else if (field === "baseUrl") this.draft.baseUrl = value;
    else if (field === "modelsPath") this.draft.modelsPath = value;
    else if (field === "modelsUrl") this.draft.modelsUrl = value;
    else if (field === "reasoningEfforts") this.draft.reasoningEfforts = value;
    else if (field === "modelIds") this.draft.modelIds = value;
    else if (field === "headers") this.draft.headersJson = value;
    else if (field === "auth") this.draft.authValue = value;
    this.markConnectionStale(field);
  }

  private saveDraft(): void {
    let profile: EndpointProfile;
    try {
      profile = this.validatedDraft();
    } catch (error) {
      this.notice = { type: "error", message: error instanceof Error ? error.message : String(error) };
      return;
    }
    const discovery = profile.discovery.mode === "manual"
      ? manualDiscovery(profile)
      : this.connectionFingerprint === this.currentConnectionFingerprint()
        ? this.connectionResult
        : undefined;
    this.runBusy("Saving endpoint…", (signal) => this.options.operations.saveProfile(profile, this.draft.originalId, discovery, signal), (result) => {
      this.data = result.data;
      this.completion = { profileId: result.profileId, modelCount: result.modelCount };
      this.view = "completion";
      this.notice = undefined;
    });
  }

  private testDraftConnection(): void {
    let profile: EndpointProfile;
    try {
      profile = this.validatedDraft();
    } catch (error) {
      this.notice = { type: "error", message: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (profile.discovery.mode === "manual") {
      const result = manualDiscovery(profile);
      this.connectionResult = result;
      this.connectionFingerprint = this.currentConnectionFingerprint();
      this.notice = { type: "info", message: `Manual discovery · ${result.models.length} model${result.models.length === 1 ? "" : "s"} ready.` };
      return;
    }
    this.runBusy("Testing connection…", (signal) => this.options.operations.testConnection(profile, signal), (result) => {
      this.connectionResult = result;
      this.connectionFingerprint = this.currentConnectionFingerprint();
      this.notice = { type: "info", message: `Connected · ${result.models.length} model${result.models.length === 1 ? "" : "s"} discovered.` };
    });
  }

  private testSelectedProfile(profileId: string, modelId?: string): void {
    const profile = this.data.config.profiles[profileId];
    const cached = this.data.cache?.profiles[profileId];
    if (!profile || !cached) {
      this.notice = { type: "warning", message: `No cached models for ${profileId}. Refresh first.` };
      return;
    }
    const targetModelId = modelId ?? firstUsableModelId(cached);
    if (!targetModelId) {
      this.notice = { type: "warning", message: `No cached models for ${profileId}. Refresh first.` };
      return;
    }
    this.runBusy("Sending test message…", (signal) => this.options.operations.sendTestMessage(profile.id, targetModelId, signal), (result) => {
      if (result?.status === "success") {
        this.notice = { type: "info", message: `Test message succeeded for ${profileId}/${targetModelId} in ${result.latencyMs}ms.` };
      } else if (result?.status === "failed") {
        this.notice = { type: "error", message: `Test message failed for ${profileId}/${targetModelId}: ${result.message}` };
      } else if (result?.status === "timeout") {
        this.notice = { type: "warning", message: `Test message timed out for ${profileId}/${targetModelId}.` };
      } else if (result?.status === "cancelled") {
        this.notice = { type: "warning", message: `Test message cancelled for ${profileId}/${targetModelId}.` };
      }
    });
  }

  private openModels(profileId: string): void {
    const profile = this.data.config.profiles[profileId];
    const cachedProfile = this.data.cache?.profiles[profileId];
    if (!profile || !cachedProfile) {
      this.notice = { type: "warning", message: `No cache for ${profileId}. Refresh first.` };
      return;
    }
    this.view = "models";
    this.modelOverlay = new ModelManagerOverlay({
      profile,
      cache: cachedProfile,
      initialState: this.modelState,
      theme: this.theme(),
      onAction: (action) => {
        this.modelState = action.state;
        if (action.type === "back") {
          this.view = "list";
          this.modelOverlay = undefined;
          this.options.tui.requestRender();
          return;
        }
        if (action.type === "save") {
          this.applyModelChanges(profileId, action.changes);
          return;
        }
        if (action.type === "testModel") {
          this.testSelectedProfile(profileId, action.modelId);
          return;
        }
        if (action.type === "probeReasoning") {
          this.runBusy("Probing reasoning efforts…", (signal) => this.options.operations.probeReasoning(profileId, action.modelId, signal), (next) => {
            this.data = next;
            this.openModels(profileId);
          });
          return;
        }
        this.runBusy("Editing model fields…", async () => this.options.operations.editModelFields(profileId, action.modelId), (next) => {
          this.data = next;
          this.openModels(profileId);
        });
      },
    });
  }

  private applyModelChanges(profileId: string, changes: ModelOverlayChanges): void {
    this.runBusy("Saving model settings…", async () => this.options.operations.saveModelChanges(profileId, changes), (next) => {
      this.data = next;
      this.openModels(profileId);
    });
  }

  private validatedDraft(): EndpointProfile {
    const profile = profileFromEndpointDraft(this.draft);
    const collision = this.data.config.profiles[profile.id];
    if (collision && profile.id !== this.draft.originalId) throw new Error(`Endpoint id ${profile.id} already exists`);
    return profile;
  }

  private runBusy<T>(message: string, operation: (signal: AbortSignal) => Promise<T>, onSuccess: (result: T) => void): void {
    if (this.activeAbort) return;
    const controller = new AbortController();
    this.activeAbort = controller;
    this.busyMessage = message;
    this.notice = undefined;
    this.options.tui.requestRender();
    operation(controller.signal)
      .then((result) => {
        if (!this.closed) onSuccess(result);
      })
      .catch((error) => {
        if (this.closed) return;
        this.notice = controller.signal.aborted
          ? { type: "warning", message: "Operation cancelled." }
          : { type: "error", message: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        if (this.activeAbort === controller) this.activeAbort = undefined;
        this.busyMessage = undefined;
        if (!this.closed) this.options.tui.requestRender();
      });
  }

  private visibleFormFields(): FormField[] {
    return FORM_FIELDS.filter((field) => {
      if (field === "modelsPath") return this.draft.discoveryMode === "endpoint";
      if (field === "modelsUrl") return this.draft.discoveryMode === "endpoint";
      if (field === "probe") return this.draft.discoveryMode === "endpoint";
      if (field === "reasoningProbe" || field === "reasoningEfforts") return this.draft.api === "openai-completions";
      if (field === "modelIds") return this.draft.discoveryMode === "manual";
      return true;
    });
  }

  private formOptionRows(): string[] {
    if (this.formSubView === "protocol") return [...this.data.runtimeApis, "custom…"];
    if (this.formSubView === "auth") return ["None", "Environment variable", "Literal key", "Shell command"];
    return ["Fetch from endpoint", "Manual model IDs"];
  }

  private displayFieldValue(field: FormField): string {
    if (field === "name") return this.draft.name;
    if (field === "id") return this.draft.id;
    if (field === "api") return this.draft.api ?? "<required>";
    if (field === "baseUrl") return this.draft.baseUrl;
    if (field === "auth") return authDisplay(this.draft);
    if (field === "discovery") return this.draft.discoveryMode === "endpoint" ? "Fetch from endpoint" : "Manual model IDs";
    if (field === "modelsPath") return this.draft.modelsPath;
    if (field === "modelsUrl") return this.draft.modelsUrl || "(Base URL + path)";
    if (field === "probe") return this.draft.probe ? "Yes" : "No";
    if (field === "reasoningProbe") return this.draft.reasoningProbe ? "Yes" : "No";
    if (field === "reasoningEfforts") return this.draft.reasoningEfforts || "(probe / canonical)";
    if (field === "modelIds") return this.draft.modelIds || "<required>";
    if (field === "headers") return `${Object.keys(safeParseHeaders(this.draft.headersJson)).length} configured`;
    return this.draft.enabled ? "Yes" : "No";
  }

  private editableFieldValue(field: FormField): string {
    if (field === "name") return this.draft.name;
    if (field === "id") return this.draft.id;
    if (field === "api") return this.draft.api ?? "";
    if (field === "baseUrl") return this.draft.baseUrl;
    if (field === "modelsPath") return this.draft.modelsPath;
    if (field === "modelsUrl") return this.draft.modelsUrl;
    if (field === "reasoningEfforts") return this.draft.reasoningEfforts;
    if (field === "modelIds") return this.draft.modelIds;
    if (field === "headers") return this.draft.headersJson;
    if (field === "auth") return this.draft.authValue;
    throw new Error(`Field ${field} is not editable as text`);
  }

  private markConnectionStale(field: FormField | undefined): void {
    if (!field || !["api", "baseUrl", "auth", "discovery", "modelsPath", "modelsUrl", "probe", "modelIds", "headers"].includes(field)) return;
    this.connectionFingerprint = undefined;
    this.connectionResult = undefined;
  }

  private currentConnectionFingerprint(): string {
    return JSON.stringify({
      api: this.draft.api,
      baseUrl: this.draft.baseUrl,
      authMode: this.draft.authMode,
      authValue: this.draft.authValue,
      discoveryMode: this.draft.discoveryMode,
      modelsPath: this.draft.modelsPath,
      modelsUrl: this.draft.modelsUrl,
      probe: this.draft.probe,
      reasoningProbe: this.draft.reasoningProbe,
      reasoningEfforts: this.draft.reasoningEfforts,
      modelIds: this.draft.modelIds,
      headersJson: this.draft.headersJson,
    });
  }

  private requireModelOverlay(): ModelManagerOverlay {
    if (!this.modelOverlay) throw new Error("Model view is missing its overlay");
    return this.modelOverlay;
  }

  private theme(): OverlayTheme {
    return this.options.theme ?? plainOverlayTheme;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeAbort?.abort();
    this.options.done();
  }
}

function describeAuth(apiKey?: string): { mode: EndpointAuthMode; value: string } {
  if (apiKey === undefined) return { mode: "none", value: "" };
  if (apiKey.startsWith("$")) return { mode: "environment", value: apiKey.replace(/^\$\{?/, "").replace(/\}?$/, "") };
  if (apiKey.startsWith("!")) return { mode: "command", value: apiKey.slice(1) };
  return { mode: "literal", value: apiKey };
}

function authValue(mode: EndpointAuthMode, value: string): string | undefined {
  const trimmed = value.trim();
  if (mode === "none") return undefined;
  if (!trimmed) throw new Error(`Authentication ${mode} requires a value`);
  if (mode === "environment") return `$${trimmed.replace(/^\$+/, "")}`;
  if (mode === "command") return `!${trimmed.replace(/^!+/, "")}`;
  return trimmed;
}

function authDisplay(draft: EndpointDraft): string {
  if (draft.authMode === "none") return "None";
  if (draft.authMode === "environment") return draft.authValue ? `Environment · $${draft.authValue.replace(/^\$+/, "")}` : "Environment · <required>";
  if (draft.authMode === "command") return draft.authValue ? "Shell command · configured" : "Shell command · <required>";
  return draft.authValue ? "Literal key · configured" : "Literal key · <required>";
}

function parseHeaders(value: string): Record<string, string> | undefined {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Custom headers must be a JSON object");
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string" || !item.trim()) throw new Error(`Header ${key} must be a non-empty string`);
    headers[key] = item;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function safeParseHeaders(value: string): Record<string, string> {
  try {
    return parseHeaders(value) ?? {};
  } catch {
    return {};
  }
}

function parseModelIds(value: string): string[] {
  const ids = value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return [...new Set(ids)];
}

function manualDiscovery(profile: EndpointProfile): EndpointDiscoveryResult {
  return {
    models: (profile.discovery.modelIds ?? []).map((id) => ({ id, available: true })),
    warnings: [],
  };
}

function compactEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return baseUrl;
  }
}

function fieldLabel(field: FormField): string {
  const labels: Record<FormField, string> = {
    name: "Display name",
    id: "Endpoint ID",
    api: "API protocol",
    baseUrl: "Base URL",
    auth: "Authentication",
    discovery: "Model discovery",
    modelsPath: "Models path",
    modelsUrl: "Models URL",
    probe: "Path probing",
    reasoningProbe: "Reasoning probe",
    reasoningEfforts: "Reasoning efforts",
    modelIds: "Model IDs",
    headers: "Custom headers",
    enabled: "Enabled",
  };
  return labels[field];
}

function fieldDescription(field: FormField): string {
  const descriptions: Record<FormField, string> = {
    name: "Shown in Pi's model selector.",
    id: "Stable endpoint identifier. Must be unique.",
    api: "Required. Choose the wire protocol implemented by the endpoint.",
    baseUrl: "The endpoint root, usually including /v1 when required.",
    auth: "None is valid for local and trusted network endpoints.",
    discovery: "Fetch /models or enter exact model IDs manually.",
    modelsPath: "Path appended to Base URL during discovery.",
    modelsUrl: "Optional full discovery URL. Overrides Base URL + path when set (e.g. Ollama's http://host:11434/api/tags).",
    probe: "On 404/empty discovery, try /models, /v1/models, /api/tags, /api/models at the origin.",
    reasoningProbe: "Probe the endpoint for accepted reasoning_effort values on refresh (openai-completions only).",
    reasoningEfforts: "Comma separated reasoning_effort values this endpoint accepts. Wins over probe results.",
    modelIds: "Comma or whitespace separated exact model IDs.",
    headers: "JSON object. Values may use literal, $ENV, or !command syntax.",
    enabled: "Disabled profiles remain configured but are not registered.",
  };
  return descriptions[field];
}

function optionTitle(view: FormSubView): string {
  if (view === "protocol") return "Select API protocol";
  if (view === "auth") return "Select authentication";
  if (view === "discovery") return "Select model discovery";
  return "Endpoint fields";
}

function isUp(data: string): boolean {
  return matchesKey(data, Key.up) || data === "k";
}

function isDown(data: string): boolean {
  return matchesKey(data, Key.down) || data === "j";
}

function isConfirm(data: string): boolean {
  return matchesKey(data, Key.enter) || data === "\r" || data === "\n";
}

function clampIndex(index: number, total: number): number {
  return Math.max(0, Math.min(index, Math.max(0, total - 1)));
}

/** First available cached model, falling back to the first entry. */
function firstUsableModelId(cached: { models: Record<string, { available: boolean }> }): string | undefined {
  for (const [id, model] of Object.entries(cached.models)) {
    if (model.available) return id;
  }
  return Object.keys(cached.models)[0];
}

function visibleWindow(total: number, selected: number, maxRows: number): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), Math.max(0, total - maxRows)));
  return { start, end: Math.min(total, start + maxRows) };
}

function padLine(content: string, width: number): string {
  // width - 4: frameLine wraps these lines in "│ " and " ", so the content
  // area must leave one space of padding inside each border.
  const inner = Math.max(0, width - 4);
  const clipped = truncateToWidth(content.replace(/[\r\n]+/g, " "), inner);
  return ` ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} `;
}

function fitCell(value: string, width: number): string {
  const clipped = truncateToWidth(value, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function titleWithHint(title: string, hint: string, width: number): string {
  const gap = width - visibleWidth(title) - visibleWidth(hint);
  return gap >= 2 ? `${title}${" ".repeat(gap)}${hint}` : `${title}  ${hint}`;
}

function noticeColor(t: OverlayTheme, type: "info" | "warning" | "error"): (text: string) => string {
  if (type === "error") return t.error;
  if (type === "warning") return t.warning;
  return t.muted;
}
