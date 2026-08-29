import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConfigPaths } from "./io.js";
import { fetchWithRetry, type Fetcher } from "./refresh.js";
import type { ModelsDevRecord } from "./types.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelsDevCacheFile {
  version: 1;
  fetchedAt: string;
  records: ModelsDevRecord[];
}

export async function fetchModelsDevCatalog(fetcher: Fetcher = fetch, url = MODELS_DEV_URL): Promise<ModelsDevRecord[]> {
  const response = await fetchWithRetry({ fetcher, url, timeoutMs: 15_000, retries: 1 });
  if (!response.ok) throw new Error(`models.dev sync failed: HTTP ${response.status}`);
  return parseModelsDevCatalog((await response.json()) as unknown);
}

/**
 * models.dev catalog with a local cache. The catalog is a large remote JSON;
 * fetching it on every refresh/save made models.dev a single point of failure
 * for the whole extension. With a cache (24h TTL + stale-on-error fallback),
 * refresh works offline and only hits the network when the cache is actually
 * stale.
 */
export async function fetchModelsDevCatalogCached(input: {
  paths: ConfigPaths;
  fetcher?: Fetcher;
  now?: () => Date;
}): Promise<{ records: ModelsDevRecord[]; warning?: string }> {
  const cached = await loadModelsDevCache(input.paths.modelsDev);
  if (cached && fresh(cached.fetchedAt, input.now)) return { records: cached.records };
  try {
    const records = await fetchModelsDevCatalog(input.fetcher);
    await saveModelsDevCache(input.paths.modelsDev, records, input.now);
    return { records };
  } catch (error) {
    if (cached && cached.records.length > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      return { records: cached.records, warning: `models.dev sync failed — using cached catalog from ${new Date(cached.fetchedAt).toISOString()}. ${detail}` };
    }
    throw error;
  }
}

function fresh(fetchedAt: string, now?: () => Date): boolean {
  const fetched = new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetched)) return false;
  return (now ?? (() => new Date()))().getTime() - fetched < MODELS_DEV_TTL_MS;
}

async function loadModelsDevCache(path: string): Promise<ModelsDevCacheFile | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.fetchedAt !== "string" || !Array.isArray(parsed.records)) return undefined;
    return { version: 1, fetchedAt: parsed.fetchedAt, records: parsed.records as ModelsDevRecord[] };
  } catch {
    return undefined;
  }
}

async function saveModelsDevCache(path: string, records: ModelsDevRecord[], now?: () => Date): Promise<void> {
  const value: ModelsDevCacheFile = { version: 1, fetchedAt: (now ?? (() => new Date()))().toISOString(), records };
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export function parseModelsDevCatalog(payload: unknown): ModelsDevRecord[] {
  if (!isRecord(payload)) return [];
  const records: ModelsDevRecord[] = [];
  const providers = isRecord(payload.providers) ? payload.providers : payload;
  for (const [provider, providerValue] of Object.entries(providers)) {
    if (!isRecord(providerValue)) continue;
    const models = isRecord(providerValue.models) ? providerValue.models : providerValue;
    for (const [modelId, modelValue] of Object.entries(models)) {
      if (!isRecord(modelValue)) continue;
      records.push(toRecord(provider, modelId, modelValue));
    }
  }
  return records;
}

function toRecord(provider: string, id: string, value: Record<string, unknown>): ModelsDevRecord {
  const contextWindow = numberField(path(value, ["limit", "context"]), value.contextWindow, value.context_window, value.context_length, value.context);
  const maxTokens = numberField(path(value, ["limit", "output"]), value.maxTokens, value.max_tokens, value.max_output_tokens, value.output);
  return {
    provider,
    id,
    name: typeof value.name === "string" ? value.name : id,
    reasoning: booleanField(value.reasoning, value.supports_reasoning, value.thinking),
    input: inputField(value.input, isRecord(value.modalities) ? value.modalities.input : undefined),
    cost: {
      input: numberField(path(value, ["cost", "input"]), path(value, ["pricing", "input"]), path(value, ["price", "input"])),
      output: numberField(path(value, ["cost", "output"]), path(value, ["pricing", "output"]), path(value, ["price", "output"])),
      cacheRead: numberField(path(value, ["cost", "cache_read"]), path(value, ["cost", "cacheRead"]), path(value, ["pricing", "cache_read"]), path(value, ["pricing", "cacheRead"])),
      cacheWrite: numberField(path(value, ["cost", "cache_write"]), path(value, ["cost", "cacheWrite"]), path(value, ["pricing", "cache_write"]), path(value, ["pricing", "cacheWrite"])),
    },
    contextWindow: contextWindow || 128000,
    maxTokens: maxTokens || 16384,
  };
}

function inputField(...values: unknown[]): Array<"text" | "image"> {
  for (const value of values) {
    if (Array.isArray(value)) {
      const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
      if (input.length > 0) return input;
    }
  }
  return ["text"];
}

function booleanField(...values: unknown[]): boolean {
  for (const value of values) if (typeof value === "boolean") return value;
  return false;
}

function numberField(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function path(value: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
