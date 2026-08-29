import type { DiscoveryCache, DoctorReport, FileLoadResult, ManagedConfig, ModelsConfig } from "./types.js";

export function buildDoctorReport(input: {
  configDir: string;
  managed: FileLoadResult<ManagedConfig>;
  cache?: FileLoadResult<DiscoveryCache>;
  generated: FileLoadResult<ModelsConfig>;
  custom: FileLoadResult<ModelsConfig>;
  runtimeAdapters: string[];
  extraIssues?: DoctorReport["issues"];
  now?: Date;
}): DoctorReport {
  const issues: DoctorReport["issues"] = [];
  const now = input.now ?? new Date();
  for (const issue of input.extraIssues ?? []) pushIssue(issues, issue);
  if (input.managed.missing) pushIssue(issues, { level: "info", code: "config_missing", message: "No bpx-endpoints.json found yet. Run /endpoints to add an endpoint." });
  if (input.managed.error) pushIssue(issues, { level: "error", code: "config_invalid", message: input.managed.error });
  if (input.generated.missing) pushIssue(issues, { level: "info", code: "generated_missing", message: "No models.generated.json found yet. Refresh after adding a profile." });
  if (input.generated.error) pushIssue(issues, { level: "error", code: "generated_invalid", message: input.generated.error });
  if (input.custom.error) pushIssue(issues, { level: "warning", code: "custom_invalid", message: input.custom.error });
  if (input.cache?.error) pushIssue(issues, { level: "warning", code: "cache_invalid", message: input.cache.error });

  const managed = input.managed.value;
  if (managed) {
    const staleDays = staleReminderDays(managed);
    for (const profile of Object.values(managed.profiles)) {
      if (!profile.enabled) continue;
      if (!input.runtimeAdapters.includes(profile.api)) {
        pushIssue(issues, {
          level: "error",
          code: "api_unresolved",
          profileId: profile.id,
          message: `Profile ${profile.id} api ${profile.api} is not available in this Pi runtime. Run /endpoints and edit the profile api field.`,
        });
      }
      const cachedProfile = input.cache?.value?.profiles[profile.id];
      if (!cachedProfile) pushIssue(issues, { level: "warning", code: "profile_not_refreshed", profileId: profile.id, message: `Profile ${profile.id} has no discovery cache. Run /endpoints refresh ${profile.id}.` });
      if (cachedProfile) {
        const ageDays = Math.floor((now.getTime() - new Date(cachedProfile.refreshedAt).getTime()) / (24 * 60 * 60 * 1000));
        if (ageDays > staleDays) pushIssue(issues, { level: "info", code: "cache_stale", profileId: profile.id, message: `Profile ${profile.id} was last refreshed ${ageDays}d ago. Run /endpoints refresh ${profile.id}.` });
      }
      if (profile.api === "openai-completions") {
        const reasoning = cachedProfile?.reasoning;
        if (reasoning?.error) {
          pushIssue(issues, { level: "warning", code: "reasoning_probe_failed", profileId: profile.id, message: `Profile ${profile.id} reasoning probe failed: ${reasoning.error}` });
        } else if (reasoning && reasoning.accepted.length === 0) {
          pushIssue(issues, { level: "warning", code: "reasoning_probe_rejected_all", profileId: profile.id, message: `Profile ${profile.id}: endpoint accepted no reasoning_effort value — reasoning models are registered as non-reasoning.` });
        } else if (profile.discovery.reasoningProbe && !reasoning) {
          pushIssue(issues, { level: "info", code: "reasoning_probe_pending", profileId: profile.id, message: `Profile ${profile.id}: discovery.reasoningProbe is on but no probe result is cached. Run /endpoints refresh ${profile.id} or /endpoints probe-reasoning ${profile.id}.` });
        }
      }
      for (const warning of cachedProfile?.warnings ?? []) {
        pushIssue(issues, { level: "warning", code: "refresh_warning", profileId: profile.id, message: `Profile ${profile.id}: ${warning}` });
      }
      const health = cachedProfile?.health;
      if (health?.lastTestAt && health.lastError) {
        pushIssue(issues, { level: "warning", code: "test_last_failed", profileId: profile.id, message: `Profile ${profile.id} last test failed${health.lastTestMs ? ` after ${health.lastTestMs}ms` : ""} (${health.failureCount ?? 1} failures, ${lastTestAge(cachedProfile, now)}): ${health.lastError}. Run /endpoints test ${profile.id}.` });
      } else if (cachedProfile && !health?.lastTestAt) {
        pushIssue(issues, { level: "info", code: "test_never_run", profileId: profile.id, message: `Profile ${profile.id} has never been test-messaged. Run /endpoints test ${profile.id}.` });
      }
      for (const [modelId, sourceId] of Object.entries(profile.parameterSourceSelections ?? {})) {
        const cachedModel = cachedProfile?.models[modelId];
        if (cachedModel && !cachedModel.candidates.some((candidate) => candidate.sourceId === sourceId)) {
          pushIssue(issues, { level: "warning", code: "parameter_source_missing", profileId: profile.id, message: `Profile ${profile.id} model ${modelId} selected source ${sourceId} no longer exists.` });
        }
      }
    }
  }

  if (issues.length === 0) issues.push({ level: "info", code: "ok", message: "No issues found." });
  return { configDir: input.configDir, issues };
}

/** Stale-cache reminder threshold; override with settings.staleReminderDays. */
export function staleReminderDays(config: ManagedConfig): number {
  return config.settings?.staleReminderDays ?? 7;
}

/** Human-readable age of the last test message, or "never". */
export function lastTestAge(cachedProfile: { health?: { lastTestAt?: string } } | undefined, now = new Date()): string {
  if (!cachedProfile?.health?.lastTestAt) return "never";
  const ageMs = now.getTime() - new Date(cachedProfile.health.lastTestAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "never";
  if (ageMs < 60 * 1000) return "just now";
  const minutes = Math.floor(ageMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function pushIssue(issues: DoctorReport["issues"], issue: DoctorReport["issues"][number]): void {
  if (issues.some((existing) => existing.message === issue.message)) return;
  issues.push(issue);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`bpx-endpoints doctor`, `Config directory: ${report.configDir}`, ""];
  for (const issue of report.issues) {
    lines.push(`${issue.level.toUpperCase()} ${issue.code}: ${issue.message}`);
  }
  return lines.join("\n");
}
