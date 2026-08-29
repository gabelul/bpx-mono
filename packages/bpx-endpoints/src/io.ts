import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createDefaultConfig, parseManagedConfig } from "./config.js";
import type { DiscoveryCache, DoctorIssue, FileLoadResult, ManagedConfig, ModelsConfig } from "./types.js";

export interface ConfigPaths {
  dir: string;
  config: string;
  cache: string;
  generated: string;
  custom: string;
  modelsDev: string;
}

/**
 * One-time migration from the pre-rename state directory. The fork reads and
 * writes bpx-endpoints/ going forward, but copies existing state over from the
 * old custom-provider/ directory on first run so existing profiles survive
 * the rename untouched. Non-destructive: the legacy directory is left in place.
 */
const LEGACY_STATE_DIR = "custom-provider";
const STATE_FILES = ["config.json", "cache.json", "models.generated.json", "models.custom.json"] as const;

export function getConfigPaths(agentDir = join(homedir(), ".pi", "agent")): ConfigPaths {
  const dir = join(agentDir, "bpx-endpoints");
  return {
    dir,
    config: join(agentDir, "bpx-endpoints.json"),
    cache: join(dir, "cache.json"),
    generated: join(dir, "models.generated.json"),
    custom: join(dir, "models.custom.json"),
    modelsDev: join(dir, "models.dev.json"),
  };
}

/**
 * First-run migration for the consult-style flat config file.
 *
 * Order of preference: an existing flat bpx-endpoints.json wins and is never
 * overwritten; otherwise the pre-flat bpx-endpoints/config.json; otherwise the
 * legacy custom-provider/config.json. The flat file is only written when the
 * source PARSES — a malformed legacy config is never converted into defaults
 * and persisted, or the recovery data disappears. Derived state files are
 * copied only when each destination is absent. Sources stay untouched.
 */
export async function ensureMigrated(paths: ConfigPaths): Promise<string | undefined> {
  let flatExists = true;
  try {
    await access(paths.config, constants.F_OK);
  } catch {
    flatExists = false;
  }
  // Managed config: the flat file always wins; otherwise migrate from the first
  // legacy source that parses. A malformed legacy config is never converted into
  // defaults — its error is returned so loadManagedConfig can surface it.
  let legacyError: string | undefined;
  if (!flatExists) {
    const legacyDirs = [paths.dir, join(dirname(paths.dir), LEGACY_STATE_DIR)];
    for (const legacyDir of legacyDirs) {
      const source = join(legacyDir, "config.json");
      const raw = await loadJsonFile(source);
      if (raw.missing) continue; // no source file — try next dir
      if (raw.error) {
        legacyError = raw.error;
        continue;
      }
      try {
        const parsed = parseManagedConfig(raw.value);
        await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
        await writeJson(paths.config, parsed);
        legacyError = undefined;
        break;
      } catch (error) {
        legacyError = `Invalid legacy config ${source}: ${error instanceof Error ? error.message : String(error)}`;
        // do NOT persist defaults over it — try the next legacy dir
      }
    }
  }
  // Derived state: copy each file from the first legacy dir that has it, but only
  // when the destination is absent. Runs even when the flat file exists — the
  // flat config winning must not block cache/generated/custom migration.
  for (const file of ["cache.json", "models.generated.json", "models.custom.json"] as const) {
    const target = join(paths.dir, file);
    try {
      await access(target, constants.F_OK);
      continue; // destination already exists — keep it
    } catch {
      // copy below
    }
    const legacyDirs = [paths.dir, join(dirname(paths.dir), LEGACY_STATE_DIR)];
    for (const legacyDir of legacyDirs) {
      const source = join(legacyDir, file);
      try {
        await access(source, constants.F_OK);
        await mkdir(paths.dir, { recursive: true, mode: 0o700 });
        await copyFile(source, target);
        break;
      } catch {
        // no source — try next dir
      }
    }
  }
  return legacyError;
}

export async function ensureConfigDir(paths: ConfigPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await ensureMigrated(paths);
}

export async function loadJsonFile(path: string): Promise<FileLoadResult<unknown>> {
  try {
    const content = await readFile(path, "utf8");
    return { value: JSON.parse(content), missing: false };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { missing: true };
    const label = error instanceof SyntaxError ? "Failed to parse" : "Failed to read";
    return { missing: false, error: `${label} ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function loadManagedConfig(paths: ConfigPaths): Promise<FileLoadResult<ManagedConfig>> {
  const legacyError = await ensureMigrated(paths);
  const raw = await loadJsonFile(paths.config);
  if (raw.missing || raw.error) {
    // No flat file: surface a legacy migration error instead of silent missing,
    // so /endpoints doctor can point at the malformed source that blocks recovery.
    // missing stays true only when there is genuinely nothing to migrate — an
    // error here must NOT trigger ensureManagedConfig's default-write path.
    const missing = raw.missing && legacyError === undefined;
    return { missing, error: raw.error ?? legacyError };
  }
  try {
    const parsed = parseManagedConfig(raw.value);
    return { missing: false, value: parsed as unknown as ManagedConfig };
  } catch (error) {
    return { missing: false, error: `Invalid managed config ${paths.config}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function loadModelsConfig(path: string): Promise<FileLoadResult<ModelsConfig>> {
  const raw = await loadJsonFile(path);
  if (raw.missing || raw.error) return { missing: raw.missing, error: raw.error };
  if (!isRecord(raw.value) || !isRecord(raw.value.providers)) {
    return { missing: false, error: `Invalid models config ${path}: expected providers object` };
  }
  return { missing: false, value: raw.value as unknown as ModelsConfig };
}

export async function loadCache(paths: ConfigPaths): Promise<FileLoadResult<DiscoveryCache>> {
  const raw = await loadJsonFile(paths.cache);
  if (raw.missing || raw.error) return { missing: raw.missing, error: raw.error };
  if (!isRecord(raw.value) || raw.value.version !== 1 || !isRecord(raw.value.profiles)) {
    return { missing: false, error: `Invalid discovery cache ${paths.cache}: expected version 1 and profiles object` };
  }
  return { missing: false, value: raw.value as unknown as DiscoveryCache };
}

export async function loadState(paths: ConfigPaths): Promise<{
  managed: FileLoadResult<ManagedConfig>;
  cache: FileLoadResult<DiscoveryCache>;
  generated: FileLoadResult<ModelsConfig>;
  custom: FileLoadResult<ModelsConfig>;
  issues: DoctorIssue[];
}> {
  const [managed, cache, generated, customRaw] = await Promise.all([
    loadManagedConfig(paths),
    loadCache(paths),
    loadModelsConfig(paths.generated),
    loadModelsConfig(paths.custom),
  ]);
  const issues: DoctorIssue[] = [];
  if (managed.error) issues.push({ level: "error", code: "config_parse_failed", message: managed.error });
  if (cache.error) issues.push({ level: "warning", code: "cache_parse_failed", message: cache.error });
  if (generated.error) issues.push({ level: "error", code: "generated_parse_failed", message: generated.error });
  if (customRaw.error) issues.push({ level: "warning", code: "custom_parse_failed", message: customRaw.error });
  return { managed, cache, generated, custom: customRaw, issues };
}

export async function writeManagedConfig(paths: ConfigPaths, config: ManagedConfig): Promise<void> {
  await ensureConfigDir(paths);
  await writeJson(paths.config, config);
}

export async function ensureManagedConfig(paths: ConfigPaths): Promise<ManagedConfig> {
  await ensureConfigDir(paths);
  const existing = await loadManagedConfig(paths);
  if (existing.value) return existing.value;
  if (!existing.missing) throw new Error(existing.error ?? "Unable to load managed config");
  const config = createDefaultConfig();
  await writeManagedConfig(paths, config);
  return config;
}

export async function writeCache(paths: ConfigPaths, cache: DiscoveryCache): Promise<void> {
  await ensureConfigDir(paths);
  await writeJson(paths.cache, cache);
}

export async function writeGeneratedConfig(paths: ConfigPaths, config: ModelsConfig): Promise<void> {
  await ensureConfigDir(paths);
  await writeJson(paths.generated, config);
}

export async function writeModelsConfig(paths: ConfigPaths, config: ModelsConfig): Promise<void> {
  await ensureConfigDir(paths);
  await writeJson(paths.custom, config);
}

export async function ensureCustomOverrideFile(paths: ConfigPaths): Promise<void> {
  await ensureConfigDir(paths);
  try {
    await access(paths.custom, constants.F_OK);
  } catch {
    await writeJson(paths.custom, { providers: {} });
  }
}

export async function removeProfileFromGenerated(paths: ConfigPaths, profileId: string): Promise<void> {
  const loaded = await loadModelsConfig(paths.generated);
  if (loaded.missing || loaded.error || !loaded.value) return;
  if (!loaded.value.providers[profileId]) return;
  delete loaded.value.providers[profileId];
  await writeGeneratedConfig(paths, loaded.value);
}

export async function removeProfileFromCache(paths: ConfigPaths, profileId: string): Promise<void> {
  const loaded = await loadCache(paths);
  if (loaded.missing || loaded.error || !loaded.value) return;
  if (!loaded.value.profiles[profileId]) return;
  delete loaded.value.profiles[profileId];
  await writeCache(paths, loaded.value);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
