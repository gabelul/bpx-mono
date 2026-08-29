import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { normalizeProfile } from "./config.js";
import { buildDoctorReport, staleReminderDays } from "./doctor.js";
import { generateModelsConfig } from "./generator.js";
import {
  ensureConfigDir,
  ensureCustomOverrideFile,
  ensureManagedConfig,
  getConfigPaths,
  loadCache,
  loadManagedConfig,
  loadModelsConfig,
  loadState,
  removeProfileFromCache,
  removeProfileFromGenerated,
  writeCache,
  writeGeneratedConfig,
  writeManagedConfig,
  writeModelsConfig,
} from "./io.js";
import { mergeModelsConfig } from "./merge.js";
import { fetchModelsDevCatalogCached } from "./models-dev.js";
import { discoverEndpointModels, probeReasoningEfforts, refreshProfileCache } from "./refresh.js";
import { filterRuntimeProviderModels, getRuntimeCapabilities } from "./runtime.js";
import { confirmAndTestProfileModel } from "./test-message.js";
import { maskEffectiveConfig, maskSecret } from "./redact.js";
import { runEndpointsSettings, showEndpointsStatus } from "./settings.js";
import { EndpointManagerSessionOverlay } from "./endpoint-manager.js";
import {
  DoctorReportOverlay,
  overlayThemeFromPi,
  ReadOnlyTextOverlay,
  type ModelOverlayChanges,
} from "./tui.js";
import type { DiscoveryCache, DoctorIssue, EndpointDiscoveryResult, FileLoadResult, ManagedConfig, ModelConfig, ModelsConfig, EndpointManagerData, EndpointManagerOperations, EndpointProfile, TestMessageResult } from "./types.js";

interface LoadedState {
  managed: FileLoadResult<ManagedConfig>;
  cache: FileLoadResult<DiscoveryCache>;
  generated: FileLoadResult<ModelsConfig>;
  custom: FileLoadResult<ModelsConfig>;
  issues: Array<{ level: "info" | "warning" | "error"; code: string; message: string }>;
  staleProfileReminderCount: number;
}

export async function registerGeneratedProviders(pi: ExtensionAPI): Promise<LoadedState> {
  const paths = getConfigPaths();
  const state = await loadState(paths);
  if (state.generated.value) {
    const effective = mergeModelsConfig(state.generated.value, state.custom.value);
    for (const [providerId, providerConfig] of Object.entries(effective.providers)) {
      pi.registerProvider(providerId, providerConfig as ProviderConfig);
    }
  }
  return {
    ...state,
    staleProfileReminderCount: state.managed.value && state.cache.value ? countStaleProfileReminders(state.managed.value, state.cache.value, new Date()) : 0,
  };
}

export function countStaleProfileReminders(config: ManagedConfig, cache: DiscoveryCache, now: Date): number {
  const staleDays = staleReminderDays(config);
  return Object.values(config.profiles).filter((profile) => {
    if (!profile.enabled) return false;
    const cachedProfile = cache.profiles[profile.id];
    if (!cachedProfile) return false;
    const ageDays = Math.floor((now.getTime() - new Date(cachedProfile.refreshedAt).getTime()) / (24 * 60 * 60 * 1000));
    return ageDays > staleDays;
  }).length;
}

export function isProfileInUse(currentModel: { provider?: string } | undefined, profileId: string): boolean {
  return currentModel?.provider === profileId;
}

export function registerEndpointCommand(pi: ExtensionAPI): void {
  pi.registerCommand("endpoints", {
    description: "Manage model endpoints, discovery, metadata sources, and generated Pi model config.",
    getArgumentCompletions: async (prefix: string) => {
      const parts = prefix.split(/\s+/);
      if (["refresh", "test", "probe-reasoning"].includes(parts[0] ?? "") && prefix.includes(" ")) {
        const profiles = (await loadManagedConfig(getConfigPaths())).value?.profiles ?? {};
        const profilePrefix = parts.at(-1) ?? "";
        return Object.keys(profiles).filter((profileId) => profileId.startsWith(profilePrefix)).map((profileId) => ({ value: profileId, label: profileId }));
      }
      const commands = ["doctor", "list", "refresh", "test", "probe-reasoning", "export", "open", "add", "settings", "status"];
      return commands.filter((command) => command.startsWith(prefix.trim())).map((command) => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      await handleEndpointCommand(pi, args.trim(), ctx);
    },
  });
}

async function handleEndpointCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const [command, ...rest] = args.split(/\s+/).filter(Boolean);
  if (!command) return openEndpointManager(pi, ctx);
  if (command === "doctor") return notifyDoctor(ctx);
  if (command === "list") return notifyList(ctx);
  if (command === "refresh") return refreshCommand(pi, ctx, rest[0]);
  if (command === "test") return testCommand(pi, ctx, rest);
  if (command === "probe-reasoning") return probeReasoningCommand(pi, ctx, rest[0]);
  if (command === "export") return exportEffective(ctx, rest[0]);
  if (command === "open") return openConfigDirectory(ctx);
  if (command === "add") return openEndpointManager(pi, ctx, "add");
  if (command === "settings") return runEndpointsSettings(ctx);
  if (command === "status") return showEndpointsStatus(ctx);
  ctx.ui.notify(`Unknown /endpoints command: ${command}`, "error");
}

async function openEndpointManager(pi: ExtensionAPI, ctx: ExtensionCommandContext, initialView: "list" | "add" = "list"): Promise<void> {
  const paths = getConfigPaths();
  await ensureConfigDir(paths);
  await ensureCustomOverrideFile(paths);
  const data = await loadEndpointManagerData(ctx);
  if (!data) return;
  const operations = endpointManagerOperations(pi, ctx);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    return new EndpointManagerSessionOverlay({
      tui,
      data,
      operations,
      done,
      initialView,
      theme: overlayThemeFromPi(theme),
    });
  }, { overlay: true, overlayOptions: centeredOverlayOptions(110, 80) });
}

async function loadEndpointManagerData(ctx: ExtensionCommandContext): Promise<EndpointManagerData | undefined> {
  const paths = getConfigPaths();
  const state = await loadState(paths);
  const config = state.managed.value ?? (state.managed.missing ? await ensureManagedConfig(paths) : undefined);
  if (!config) {
    ctx.ui.notify("bpx-endpoints.json is invalid. Use /endpoints doctor, then repair the file before editing.", "error");
    return undefined;
  }
  return {
    config,
    cache: state.cache.value,
    runtimeApis: getRuntimeCapabilities(ctx).adapters,
    doctor: buildDoctorReport({
      configDir: paths.dir,
      managed: state.managed.value ? state.managed : { missing: false, error: state.managed.error },
      cache: state.cache,
      generated: state.generated,
      custom: state.custom,
      runtimeAdapters: getRuntimeCapabilities(ctx).adapters,
    }),
  };
}

function endpointManagerOperations(pi: ExtensionAPI, ctx: ExtensionCommandContext): EndpointManagerOperations {
  return {
    testConnection: async (profile, signal) => {
      try {
        return await discoverEndpointModels(profile, fetchWithSignal(signal));
      } catch (error) {
        throw new Error(describeConnectionTestFailure(profile, error));
      }
    },
    saveProfile: (profile, originalId, discovery, signal) => saveEndpointProfile(pi, ctx, profile, originalId, discovery, signal),
    refresh: async (profileId, signal) => {
      await refreshCommand(pi, ctx, profileId, signal);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
    deleteProfile: async (profileId) => {
      await deleteProfileFlow(pi, ctx, profileId);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
    cloneProfile: async (profileId) => {
      await cloneProfileFlow(pi, ctx, profileId);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
    saveModelChanges: async (profileId, changes) => {
      await saveModelChanges(pi, ctx, profileId, changes);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
    editModelFields: async (profileId, modelId) => {
      await editModelFields(pi, ctx, profileId, modelId);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
    editCustomOverrides: async () => {
      await editCustomOverrides(ctx);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
    sendTestMessage: async (profileId, modelId, signal) => {
      return testSpecificProfileModel(pi, ctx, profileId, modelId, signal);
    },
    probeReasoning: async (profileId, modelId, signal) => {
      await probeReasoningAndRegenerate(pi, ctx, profileId, modelId, signal);
      return requiredEndpointManagerData(await loadEndpointManagerData(ctx));
    },
  };
}

function requiredEndpointManagerData(data: EndpointManagerData | undefined): EndpointManagerData {
  if (!data) throw new Error("Endpoint manager state could not be reloaded");
  return data;
}

function fetchWithSignal(signal: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, init?.signal].filter((item): item is AbortSignal => item !== undefined)) });
}

function describeConnectionTestFailure(profile: EndpointProfile, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (profile.discovery.mode === "endpoint" && /HTTP (?:400|401|403|404)|Unsupported \/models response shape|non-JSON/i.test(message)) {
    return `${message} This only tests model discovery; the chat protocol may still work. Switch Model discovery to Manual model IDs if this endpoint does not expose /models.`;
  }
  return message;
}

/**
 * The overlay container centers whatever width we request; cap it so wide
 * terminals get a readable dialog instead of a full-bleed one.
 */
function centeredOverlayOptions(maxWidth: number, minWidth: number): () => OverlayOptions {
  return () => ({
    width: Math.min(maxWidth, Math.floor((process.stdout.columns || maxWidth) * 0.9)),
    minWidth,
    maxHeight: "85%",
  });
}

/** Duplicate an existing profile under a new id; common for same endpoint, different key/policy. */
async function cloneProfileFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string): Promise<void> {
  const paths = getConfigPaths();
  const loaded = await loadManagedConfig(paths);
  if (!loaded.value) return ctx.ui.notify(loaded.error ?? "No bpx-endpoints.json found", "error");
  const source = loaded.value.profiles[profileId];
  if (!source) return ctx.ui.notify(`Profile ${profileId} not found`, "error");
  let newId: string | undefined;
  while (true) {
    newId = await ctx.ui.input("New profile id", `${profileId}-copy`);
    if (newId === undefined) return;
    newId = newId.trim();
    if (!newId) continue;
    if (!loaded.value.profiles[newId]) break;
    ctx.ui.notify(`Profile ${newId} already exists`, "error");
  }
  try {
    const clone = normalizeProfile({
      ...structuredClone(source),
      id: newId,
      name: `${source.name} (copy)`,
    });
    loaded.value.profiles[newId] = clone;
    await writeManagedConfig(paths, loaded.value);
    ctx.ui.notify(`Cloned ${profileId} → ${newId}.`, "info");
    await refreshCommand(pi, ctx, newId);
  } catch (error) {
    ctx.ui.notify(`Clone rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function deleteProfileFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string): Promise<void> {
  if (isProfileInUse(ctx.model, profileId)) {
    ctx.ui.notify(`Cannot delete ${profileId}: the current session is using a model from this endpoint. Switch model first.`, "error");
    return;
  }
  const ok = await ctx.ui.confirm("Delete Endpoint", `Delete ${profileId}? This removes the profile and its derived state.`);
  if (!ok) return;
  const paths = getConfigPaths();
  const loaded = await loadManagedConfig(paths);
  if (!loaded.value) return ctx.ui.notify(loaded.error ?? "No bpx-endpoints.json found", "error");
  delete loaded.value.profiles[profileId];
  await writeManagedConfig(paths, loaded.value);
  await removeProfileFromGenerated(paths, profileId);
  await removeProfileFromCache(paths, profileId);
  pi.unregisterProvider(profileId);
  ctx.ui.notify(`Deleted ${profileId}`, "info");
}

async function testSpecificProfileModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string, modelId: string, signal?: AbortSignal, offerSwitch = true): Promise<TestMessageResult | undefined> {
  const paths = getConfigPaths();
  const profile = (await loadManagedConfig(paths)).value?.profiles[profileId];
  if (!profile) {
    ctx.ui.notify(`Profile ${profileId} not found`, "error");
    return undefined;
  }
  const cachedModel = (await loadCache(paths)).value?.profiles[profileId]?.models[modelId];
  if (!cachedModel) {
    ctx.ui.notify(`No cached model ${modelId} for ${profileId}. Refresh first.`, "warning");
    return undefined;
  }
  const effectiveModel = ctx.modelRegistry.find(profileId, modelId) as Model<Api> | undefined;
  const result = await confirmAndTestProfileModel({
    profile,
    cachedModel,
    signal,
    model: effectiveModel,
    confirm: (title, message) => ctx.ui.confirm(title, message),
    notify: (message, type) => ctx.ui.notify(message, type),
  });
  await recordTestHealth(paths, profileId, modelId, result);
  if (result.status === "success" && offerSwitch) await offerModelSwitch(pi, ctx, profileId, modelId);
  return result;
}

/** Persist the latest test outcome on the profile's cached health record. */
async function recordTestHealth(paths: ReturnType<typeof getConfigPaths>, profileId: string, modelId: string, result: TestMessageResult): Promise<void> {
  if (result.status === "cancelled") return; // user backed out — nothing to record
  const loaded = await loadCache(paths);
  if (!loaded.value) return;
  const cached = loaded.value.profiles[profileId];
  if (!cached) return;
  const health = cached.health ??= {};
  health.lastTestAt = new Date().toISOString();
  health.lastModelId = modelId;
  if (result.status === "success") {
    health.lastTestMs = result.latencyMs;
    health.lastError = undefined;
    health.failureCount = 0;
  } else {
    health.lastTestMs = undefined;
    health.lastError = result.status === "timeout" ? "timed out" : result.message;
    health.failureCount = (health.failureCount ?? 0) + 1;
  }
  await writeCache(paths, loaded.value);
}

/**
 * /endpoints probe-reasoning [id] — probe the endpoint for accepted
 * reasoning_effort values, cache the outcome, and re-register the generated
 * config so the thinkingLevelMap reflects the server's reality immediately.
 * Without an id, probes every enabled openai-completions profile.
 */
async function probeReasoningCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId?: string): Promise<void> {
  const paths = getConfigPaths();
  const managed = await loadManagedConfig(paths);
  if (!managed.value) {
    ctx.ui.notify(managed.error ?? "No bpx-endpoints.json found.", "error");
    return;
  }
  let targets = Object.values(managed.value.profiles).filter((profile) => profile.enabled && profile.api === "openai-completions");
  if (profileId) {
    const profile = managed.value.profiles[profileId];
    if (!profile) {
      ctx.ui.notify(`Profile ${profileId} not found`, "error");
      return;
    }
    targets = profile.api === "openai-completions" ? [profile] : [];
  }
  if (targets.length === 0) {
    ctx.ui.notify(profileId ? `Profile ${profileId} is not an openai-completions endpoint — probing only applies to that protocol.` : "No enabled openai-completions endpoints to probe.", "warning");
    return;
  }
  let succeeded = 0;
  for (const profile of targets) {
    try {
      const result = await probeReasoningAndRegenerate(pi, ctx, profile.id, undefined, undefined);
      if (result === undefined) continue;
      succeeded += 1;
      const accepted = result.accepted.length > 0 ? result.accepted.join(", ") : "none";
      ctx.ui.notify(result.error ? `Reasoning probe failed for ${profile.id}: ${result.error}` : `Reasoning probe for ${profile.id}: accepted [${accepted}] — applied to this session.`, result.error ? "error" : "info");
    } catch (error) {
      ctx.ui.notify(`Reasoning probe failed for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  if (targets.length > 1) ctx.ui.notify(`${succeeded}/${targets.length} profile(s) probed.`, succeeded === targets.length ? "info" : "warning");
}

/** Probe one profile, persist the outcome to its cache entry, regenerate, and re-register. */
async function probeReasoningAndRegenerate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  profileId: string,
  modelId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<typeof probeReasoningEfforts>> | undefined> {
  const paths = getConfigPaths();
  const managed = await loadManagedConfig(paths);
  const profile = managed.value?.profiles[profileId];
  if (!profile) {
    ctx.ui.notify(profileId ? `Profile ${profileId} not found` : "No bpx-endpoints.json found.", "error");
    return undefined;
  }
  const cached = (await loadCache(paths)).value?.profiles[profileId];
  if (!cached || Object.keys(cached.models).length === 0) {
    ctx.ui.notify(`No cached models for ${profileId}. Refresh first.`, "warning");
    return undefined;
  }
  const targetModelId = modelId ?? (Object.keys(cached.models).find((id) => cached.models[id]?.available) ?? Object.keys(cached.models)[0]);
  if (!targetModelId) {
    ctx.ui.notify(`No cached models for ${profileId}. Refresh first.`, "warning");
    return undefined;
  }
  const result = await probeReasoningEfforts({ profile, modelId: targetModelId, fetcher: signal ? fetchWithSignal(signal) : undefined });
  const cache = (await loadCache(paths)).value ?? { version: 1, profiles: {} };
  if (!cache.profiles[profileId]) {
    ctx.ui.notify(`No cached profile ${profileId}. Refresh first.`, "warning");
    return undefined;
  }
  cache.profiles[profileId].reasoning = result;
  await writeCache(paths, cache);
  const generated = await regenerateAndApply(pi, ctx, managed.value!);
  for (const issue of generated.issues) ctx.ui.notify(issue.message, notifyTypeForIssue(issue));
  return result;
}

/**
 * /endpoints test [profile] [model] — one-off connectivity + stream test;
 * /endpoints test --all — batch-check every enabled profile (one confirm,
 * paid API calls). Discovery-only probing stays a separate free operation.
 */
async function testCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<void> {
  if (args[0] === "--all" || args[0] === "-a") {
    const paths = getConfigPaths();
    const managed = await loadManagedConfig(paths);
    const enabled = managed.value ? Object.values(managed.value.profiles).filter((profile) => profile.enabled) : [];
    if (enabled.length === 0) {
      ctx.ui.notify("No enabled Endpoints configured.", "warning");
      return;
    }
    const confirmed = await ctx.ui.confirm("Test all endpoints", `Send a test message to the first available model of each of ${enabled.length} enabled Endpoint(s)? This makes real API calls and may incur token costs.`);
    if (!confirmed) return;
    ctx.ui.setStatus("bpx-endpoints", "testing endpoints…");
    let succeeded = 0;
    let failed = 0;
    for (const profile of enabled) {
      const modelId = await firstCachedModelId(profile);
      if (!modelId) {
        failed += 1;
        ctx.ui.notify(`No cached models for ${profile.id}. Refresh first.`, "warning");
        continue;
      }
      const result = await testSpecificProfileModel(pi, ctx, profile.id, modelId, undefined, false);
      if (result?.status === "success") succeeded += 1;
      else failed += 1;
    }
    ctx.ui.setStatus("bpx-endpoints", undefined);
    ctx.ui.notify(failed === 0 ? `All ${succeeded} Endpoint(s) tested OK.` : `${succeeded} ok, ${failed} failed.`, failed === 0 ? "info" : "warning");
    return;
  }
  const profileId = args[0];
  if (!profileId) {
    ctx.ui.notify("Usage: /endpoints test <profile> [model]  ·  /endpoints test --all", "error");
    return;
  }
  const paths = getConfigPaths();
  const profile = (await loadManagedConfig(paths)).value?.profiles[profileId];
  if (!profile) {
    ctx.ui.notify(`Profile ${profileId} not found`, "error");
    return;
  }
  const modelId = args[1] ?? (await firstCachedModelId(profile));
  if (!modelId) {
    ctx.ui.notify(`No cached models for ${profileId}. Refresh first.`, "warning");
    return;
  }
  await testSpecificProfileModel(pi, ctx, profileId, modelId);
}

/** First available cached model id for a profile (list view and batch tests). */
async function firstCachedModelId(profile: EndpointProfile): Promise<string | undefined> {
  const cached = (await loadCache(getConfigPaths())).value?.profiles[profile.id];
  if (!cached) return undefined;
  for (const [id, model] of Object.entries(cached.models)) {
    if (model.available) return id;
  }
  return Object.keys(cached.models)[0];
}

/** After a successful test, close the loop: offer to make the tested model the session model. */
async function offerModelSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string, modelId: string): Promise<void> {
  if (ctx.model?.provider === profileId && ctx.model?.id === modelId) return;
  const model = ctx.modelRegistry.find(profileId, modelId);
  if (!model) return;
  const ok = await ctx.ui.confirm("Switch model?", `Use ${profileId}/${modelId} as the current session model?`);
  if (!ok) return;
  const switched = await pi.setModel(model);
  if (switched) ctx.ui.notify(`Switched current model to ${profileId}/${modelId}.`, "info");
  else ctx.ui.notify(`Could not switch to ${profileId}/${modelId}: no API key available.`, "error");
}

async function editModelFields(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string, modelId: string): Promise<void> {
  const paths = getConfigPaths();
  const managed = await loadManagedConfig(paths);
  if (!managed.value) {
    ctx.ui.notify(managed.error ?? "No bpx-endpoints.json found", "error");
    return;
  }
  if (!managed.value.profiles[profileId]) {
    ctx.ui.notify(`Profile ${profileId} not found`, "error");
    return;
  }
  const loadedCustom = await loadModelsConfig(paths.custom);
  if (loadedCustom.error) {
    ctx.ui.notify(loadedCustom.error, "error");
    return;
  }
  const custom = loadedCustom.value ?? { providers: {} };
  const existing = custom.providers[profileId]?.modelOverrides?.[modelId];
  const contextWindow = await promptPositiveInteger(ctx, "Context window", existing?.contextWindow);
  if (contextWindow === undefined) return;
  const maxTokens = await promptPositiveInteger(ctx, "Max output tokens", existing?.maxTokens);
  if (maxTokens === undefined) return;
  const inputCost = await promptNonNegativeNumber(ctx, "Cost input", existing?.cost?.input);
  if (inputCost === undefined) return;
  const outputCost = await promptNonNegativeNumber(ctx, "Cost output", existing?.cost?.output);
  if (outputCost === undefined) return;
  const reasoningChoice = await ctx.ui.select("Reasoning", existing?.reasoning === false ? ["false", "true"] : ["true", "false"]);
  if (reasoningChoice === undefined) return;
  const imageChoice = await ctx.ui.select("Image input", existing?.input?.includes("image") ? ["true", "false"] : ["false", "true"]);
  if (imageChoice === undefined) return;

  const provider = custom.providers[profileId] ?? {};
  const modelOverrides = { ...provider.modelOverrides };
  const previous = modelOverrides[modelId] ?? {};
  modelOverrides[modelId] = {
    ...previous,
    contextWindow,
    maxTokens,
    cost: { ...previous.cost, input: inputCost, output: outputCost } as ModelConfig["cost"],
    reasoning: reasoningChoice === "true",
    input: imageChoice === "true" ? ["text", "image"] : ["text"],
  };
  custom.providers[profileId] = { ...provider, modelOverrides };
  await writeModelsConfig(paths, custom);
  const generated = await regenerateAndApply(pi, ctx, managed.value);
  for (const issue of generated.issues) ctx.ui.notify(issue.message, issue.level === "info" ? "info" : "warning");
  ctx.ui.notify(`Saved model fields for ${modelId} — applied to this session.`, "info");
}

/** Persist buffered model edits, then regenerate and re-register so they apply now, not at the next refresh. */
async function saveModelChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string, changes: ModelOverlayChanges): Promise<void> {
  const paths = getConfigPaths();
  const loaded = await loadManagedConfig(paths);
  if (!loaded.value) {
    ctx.ui.notify(loaded.error ?? "No bpx-endpoints.json found", "error");
    return;
  }
  const profile = loaded.value.profiles[profileId];
  if (!profile) {
    ctx.ui.notify(`Profile ${profileId} not found`, "error");
    return;
  }
  profile.modelPolicy = changes.policy;
  profile.parameterSourceSelections = Object.keys(changes.sources).length > 0 ? changes.sources : undefined;
  await writeManagedConfig(paths, loaded.value);
  const generated = await regenerateAndApply(pi, ctx, loaded.value);
  for (const issue of generated.issues) ctx.ui.notify(issue.message, issue.level === "info" ? "info" : "warning");
  ctx.ui.notify(`Saved model settings for ${profileId} — applied to this session.`, "info");
}

async function editCustomOverrides(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getConfigPaths();
  await ensureCustomOverrideFile(paths);
  const current = (await loadModelsConfig(paths.custom)).value ?? { providers: {} };
  const edited = await ctx.ui.editor("Edit models.custom.json", JSON.stringify(current, null, 2));
  if (!edited) return;
  try {
    const parsed = JSON.parse(edited) as unknown;
    if (!isModelsConfig(parsed)) throw new Error("Expected { providers: {...} }");
    await writeModelsConfig(paths, parsed);
  } catch (error) {
    ctx.ui.notify(`models.custom.json edit rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function refreshCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId?: string, signal?: AbortSignal): Promise<void> {
  const paths = getConfigPaths();
  const operationSignal = signal ?? new AbortController().signal;
  const managed = await loadManagedConfig(paths);
  if (!managed.value) {
    ctx.ui.notify(managed.missing ? "No bpx-endpoints.json found. Run /endpoints to add an endpoint." : managed.error ?? "Invalid bpx-endpoints.json", managed.missing ? "warning" : "error");
    return;
  }
  const runtime = filterRuntimeProviderModels(getRuntimeCapabilities(ctx), Object.keys(managed.value.profiles));
  const previousCache = (await loadCache(paths)).value ?? { version: 1, profiles: {} };
  const profiles = Object.values(managed.value.profiles).filter((profile) => profile.enabled && (!profileId || profile.id === profileId));
  if (profiles.length === 0) {
    ctx.ui.notify(profileId ? `No enabled profile ${profileId}` : "No enabled Endpoints configured.", "warning");
    return;
  }
  ctx.ui.setStatus("bpx-endpoints", "refreshing endpoints…");
  let modelsDevModels: Awaited<ReturnType<typeof fetchModelsDevCatalogCached>>["records"] = [];
  const issues: DoctorIssue[] = [];
  try {
    try {
      const modelsDev = await fetchModelsDevCatalogCached({ paths, fetcher: fetchWithSignal(operationSignal) });
      modelsDevModels = modelsDev.records;
      if (modelsDev.warning) issues.push({ level: "warning", code: "models_dev_sync_failed", message: modelsDev.warning });
    } catch (error) {
      issues.push({ level: "warning", code: "models_dev_sync_failed", message: `models.dev sync failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    const nextCache: DiscoveryCache = { version: 1, profiles: { ...previousCache.profiles } };
    let succeeded = 0;
    for (const profile of profiles) {
      try {
        nextCache.profiles[profile.id] = await refreshProfileCache({
          profile,
          runtime,
          modelsDevModels,
          previous: previousCache.profiles[profile.id],
          fetcher: fetchWithSignal(operationSignal),
        });
        succeeded += 1;
      } catch (error) {
        issues.push({ level: "warning", code: "endpoint_discovery_failed", profileId: profile.id, message: `Endpoint discovery failed for ${profile.id}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const previousGenerated = await loadModelsConfig(paths.generated);
    const generated = generateModelsConfig(managed.value, nextCache, runtime);
    await registerEffectiveProviders(pi, generated.config, ctx, previousGenerated.value);
    await writeCache(paths, nextCache);
    await writeGeneratedConfig(paths, generated.config);
    for (const issue of [...issues, ...generated.issues]) ctx.ui.notify(issue.message, notifyTypeForIssue(issue));
    const failed = profiles.length - succeeded;
    ctx.ui.notify(
      failed === 0
        ? `Refreshed ${succeeded} Endpoint(s).`
        : `Refreshed ${succeeded} of ${profiles.length} Endpoint(s); ${failed} failed. Previous cache retained for failures.`,
      failed === 0 ? "info" : "warning",
    );
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  } finally {
    ctx.ui.setStatus("bpx-endpoints", undefined);
  }
}

async function saveEndpointProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  profile: EndpointProfile,
  originalId: string | undefined,
  discovery: EndpointDiscoveryResult | undefined,
  signal: AbortSignal,
): Promise<{ data: EndpointManagerData; profileId: string; modelCount: number }> {
  const paths = getConfigPaths();
  const config = await ensureManagedConfig(paths);
  if (config.profiles[profile.id] && profile.id !== originalId) throw new Error(`Endpoint id ${profile.id} already exists`);
  if (originalId && isProfileInUse(ctx.model, originalId) && !profile.enabled) {
    throw new Error(`Cannot disable ${originalId}: the current session is using this endpoint. Switch model first.`);
  }
  if (originalId && originalId !== profile.id) {
    if (isProfileInUse(ctx.model, originalId)) throw new Error(`Cannot rename ${originalId}: the current session is using this endpoint`);
    delete config.profiles[originalId];
    await removeProfileFromGenerated(paths, originalId);
    await removeProfileFromCache(paths, originalId);
    pi.unregisterProvider(originalId);
  }
  config.profiles[profile.id] = profile;
  await writeManagedConfig(paths, config);

  const runtime = filterRuntimeProviderModels(getRuntimeCapabilities(ctx), Object.keys(config.profiles));
  let modelsDevModels: Awaited<ReturnType<typeof fetchModelsDevCatalogCached>>["records"] = [];
  try {
    const modelsDev = await fetchModelsDevCatalogCached({ paths, fetcher: fetchWithSignal(signal) });
    modelsDevModels = modelsDev.records;
    if (modelsDev.warning) ctx.ui.notify(modelsDev.warning, "warning");
  } catch (error) {
    ctx.ui.notify(`models.dev sync failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
  const previousCache = (await loadCache(paths)).value ?? { version: 1, profiles: {} };
  const nextCache: DiscoveryCache = { version: 1, profiles: { ...previousCache.profiles } };
  nextCache.profiles[profile.id] = await refreshProfileCache({
    profile,
    runtime,
    modelsDevModels,
    discoveryResult: discovery,
    previous: previousCache.profiles[profile.id],
    fetcher: fetchWithSignal(signal),
  });
  await writeCache(paths, nextCache);
  const previousGenerated = await loadModelsConfig(paths.generated);
  const generated = generateModelsConfig(config, nextCache, runtime);
  await writeGeneratedConfig(paths, generated.config);
  await registerEffectiveProviders(pi, generated.config, ctx, previousGenerated.value);
  for (const issue of generated.issues) ctx.ui.notify(issue.message, notifyTypeForIssue(issue));
  const data = requiredEndpointManagerData(await loadEndpointManagerData(ctx));
  return { data, profileId: profile.id, modelCount: Object.keys(nextCache.profiles[profile.id].models).length };
}

async function registerEffectiveProviders(pi: ExtensionAPI, generated: ModelsConfig, ctx: ExtensionCommandContext, previousGenerated?: ModelsConfig): Promise<void> {
  const paths = getConfigPaths();
  const custom = await loadModelsConfig(paths.custom);
  const effective = mergeModelsConfig(generated, custom.value);
  for (const [providerId, providerConfig] of Object.entries(effective.providers)) {
    pi.registerProvider(providerId, providerConfig as ProviderConfig);
  }
  for (const providerId of Object.keys(previousGenerated?.providers ?? {})) {
    if (!effective.providers[providerId]) pi.unregisterProvider(providerId);
  }
}

async function regenerateAndApply(pi: ExtensionAPI, ctx: ExtensionCommandContext, config: ManagedConfig): Promise<ReturnType<typeof generateModelsConfig>> {
  const paths = getConfigPaths();
  const previousGenerated = await loadModelsConfig(paths.generated);
  const runtime = filterRuntimeProviderModels(getRuntimeCapabilities(ctx), Object.keys(config.profiles));
  const cache = (await loadCache(paths)).value ?? { version: 1, profiles: {} };
  const generated = generateModelsConfig(config, cache, runtime);
  await writeGeneratedConfig(paths, generated.config);
  await registerEffectiveProviders(pi, generated.config, ctx, previousGenerated.value);
  return generated;
}

async function notifyDoctor(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getConfigPaths();
  const state = await loadState(paths);
  const report = buildDoctorReport({ configDir: paths.dir, managed: state.managed, cache: state.cache, generated: state.generated, custom: state.custom, runtimeAdapters: getRuntimeCapabilities(ctx).adapters });
  await ctx.ui.custom<void>((_tui, theme, _keybindings, close) => new DoctorReportOverlay(report, close, overlayThemeFromPi(theme)), { overlay: true, overlayOptions: centeredOverlayOptions(110, 80) });
}

async function notifyList(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getConfigPaths();
  const config = (await loadManagedConfig(paths)).value;
  if (!config) return ctx.ui.notify("No valid bpx-endpoints.json found.", "warning");
  const lines = Object.values(config.profiles).map((profile) => `${profile.enabled ? "✓" : "-"} ${profile.id}  api=${profile.api}  baseUrl=${profile.baseUrl}`);
  await showReadOnlyText(ctx, "Endpoints", lines.length ? lines.join("\n") : "No Endpoints configured.");
}

async function exportEffective(ctx: ExtensionCommandContext, outputPath?: string): Promise<void> {
  const paths = getConfigPaths();
  const generated = await loadModelsConfig(paths.generated);
  if (!generated.value) return ctx.ui.notify(generated.error ?? "No models.generated.json found.", "error");
  const custom = await loadModelsConfig(paths.custom);
  const effective = mergeModelsConfig(generated.value, custom.value);
  const content = `${JSON.stringify(maskEffectiveConfig(effective), null, 2)}\n`;
  if (!outputPath) {
    await showReadOnlyText(ctx, "Effective models config", content.trimEnd());
    return;
  }
  try {
    const absolutePath = resolveExportPath(outputPath);
    await writeFile(absolutePath, content, "utf8");
    ctx.ui.notify(`Exported effective models config to ${absolutePath}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function openConfigDirectory(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getConfigPaths();
  await ensureConfigDir(paths);
  ctx.ui.notify(`Config: ${paths.config}\nState: ${paths.dir}`, "info");
}

async function showReadOnlyText(ctx: ExtensionCommandContext, title: string, content: string): Promise<void> {
  await ctx.ui.custom<void>((_tui, theme, _keybindings, close) => new ReadOnlyTextOverlay(title, content, close, overlayThemeFromPi(theme)), { overlay: true, overlayOptions: centeredOverlayOptions(120, 80) });
}

export function renderEndpointSummary(profile: EndpointProfile, extraLine?: string): string {
  const apiKey = profile.apiKey === undefined ? "none" : maskSecret(profile.apiKey);
  const headers = Object.entries(profile.headers ?? {});
  const policy = profile.modelPolicy.mode === "includeOnly" ? `includeOnly (${profile.modelPolicy.include?.length ?? 0} included)` : `includeAll (${profile.modelPolicy.exclude?.length ?? 0} excluded)`;
  const lines = [
    `id: ${profile.id}`,
    `name: ${profile.name}`,
    `enabled: ${String(profile.enabled)}`,
    `api: ${profile.api}`,
    `baseUrl: ${profile.baseUrl}`,
    `apiKey: ${apiKey}`,
    `discovery: ${profile.discovery.mode}`,
    `modelsPath: ${profile.discovery.modelsPath}`,
    `policy: ${policy}`,
  ];
  if (profile.api === "openai-completions") {
    if (profile.reasoningEfforts && profile.reasoningEfforts.length > 0) lines.push(`reasoningEfforts: manual [${profile.reasoningEfforts.join(", ")}]`);
    lines.push(`reasoningProbe: ${profile.discovery.reasoningProbe ? "on" : "off"}`);
  }
  for (const [name, value] of headers) lines.push(`header "${name}": ${maskSecret(value)}`);
  if (profile.discovery.mode === "manual") lines.push(`modelIds: ${profile.discovery.modelIds?.join(", ") ?? ""}`);
  if (extraLine) lines.push(extraLine);
  if (profile.apiKey?.startsWith("!")) lines.push(`⚠ This profile will execute a shell command: ${profile.apiKey.slice(1)}`);
  for (const [name, value] of headers) {
    if (value.startsWith("!")) lines.push(`⚠ This profile will execute a shell command for header "${name}": ${value.slice(1)}`);
  }
  return lines.join("\n");
}

async function promptPositiveInteger(ctx: ExtensionCommandContext, title: string, current?: number): Promise<number | undefined> {
  while (true) {
    const raw = await ctx.ui.input(title, current === undefined ? "" : String(current));
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
    ctx.ui.notify(`${title} must be a positive integer. Press escape to cancel.`, "error");
  }
}

async function promptNonNegativeNumber(ctx: ExtensionCommandContext, title: string, current?: number): Promise<number | undefined> {
  while (true) {
    const raw = await ctx.ui.input(title, current === undefined ? "" : String(current));
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
    ctx.ui.notify(`${title} must be a non-negative number. Press escape to cancel.`, "error");
  }
}

function resolveExportPath(outputPath: string): string {
  const expanded = outputPath.startsWith("~/") ? `${homedir()}${outputPath.slice(1)}` : outputPath;
  return resolve(process.cwd(), expanded);
}

function notifyTypeForIssue(issue: DoctorIssue): "info" | "warning" | "error" {
  if (issue.level === "info") return "info";
  if (issue.level === "error") return "warning";
  return "warning";
}

function isModelsConfig(value: unknown): value is ModelsConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "providers" in value;
}
