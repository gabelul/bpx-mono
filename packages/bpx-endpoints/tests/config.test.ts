import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManagedConfig } from "../src/config.js";
import {
  ensureConfigDir,
  ensureMigrated,
  getConfigPaths,
  loadManagedConfig,
  writeManagedConfig,
} from "../src/io.js";
import type { EndpointProfile, ManagedConfig } from "../src/types.js";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "bpx-endpoints-test-"));
}

function sampleProfile(id = "codex-lb"): EndpointProfile {
  return {
    id,
    enabled: true,
    name: "Codex load balancer",
    api: "openai-completions",
    baseUrl: "https://lb.example.com/v1",
    apiKey: "${CODEX_LB_KEY}",
    discovery: { mode: "endpoint", modelsPath: "/models" },
    modelPolicy: { mode: "includeAll", exclude: [] },
  };
}

function sampleConfig(overrides: Partial<ManagedConfig> = {}): ManagedConfig {
  return {
    version: 1,
    profiles: { "codex-lb": sampleProfile() },
    settings: { staleReminder: true, staleReminderDays: 7 },
    ...overrides,
  };
}

describe("flat managed config", () => {
  it("round-trips profiles + settings through the flat file", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    const config = sampleConfig();

    await writeManagedConfig(paths, config);
    expect(readFileSync(paths.config, "utf8")).toContain('"codex-lb"');

    const loaded = await loadManagedConfig(paths);
    expect(loaded.missing).toBe(false);
    expect(loaded.error).toBeUndefined();
    expect(loaded.value?.profiles["codex-lb"]?.baseUrl).toBe("https://lb.example.com/v1");
    expect(loaded.value?.settings?.staleReminderDays).toBe(7);
  });

  it("round-trips modelsUrl and probe through the flat file", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await writeManagedConfig(paths, sampleConfig({
      profiles: {
        "ollama": {
          ...sampleProfile("ollama"),
          discovery: { mode: "endpoint", modelsPath: "/models", modelsUrl: "http://host:11434/api/tags", probe: true },
        },
      },
    }));

    const loaded = await loadManagedConfig(paths);
    const discovery = loaded.value?.profiles["ollama"]?.discovery;
    expect(discovery?.modelsUrl).toBe("http://host:11434/api/tags");
    expect(discovery?.probe).toBe(true);
    expect(discovery?.modelsPath).toBe("/models");
  });

  it("rejects a modelsUrl that is not an http(s) URL", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await writeManagedConfig(paths, sampleConfig({
      profiles: {
        "bad": { ...sampleProfile("bad"), discovery: { mode: "endpoint", modelsPath: "/models", modelsUrl: "api/tags" } },
      },
    }));

    const loaded = await loadManagedConfig(paths);
    expect(loaded.value).toBeUndefined();
    expect(loaded.error).toMatch(/modelsUrl/);
  });

  it("fails soft on malformed flat config without overwriting it", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await ensureConfigDir(paths);
    writeFileSync(paths.config, "{ not valid json", "utf8");

    const loaded = await loadManagedConfig(paths);
    expect(loaded.missing).toBe(false);
    expect(loaded.error).toMatch(/Failed to parse/);
    // The malformed file must remain untouched — no defaults were written over it.
    expect(readFileSync(paths.config, "utf8")).toBe("{ not valid json");
  });

  it("fails soft on invalid managed config without overwriting it", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await ensureConfigDir(paths);
    writeFileSync(paths.config, JSON.stringify({ version: 1, profiles: { bad: { id: "drifted", name: "X" } } }), "utf8");

    const loaded = await loadManagedConfig(paths);
    expect(loaded.error).toMatch(/does not match its config key/);
    expect(readFileSync(paths.config, "utf8")).toContain('"drifted"');
  });

  it("enforces map-key/id consistency", () => {
    expect(() => parseManagedConfig({ version: 1, profiles: { a: { id: "b", name: "X" } } })).toThrow(/does not match/);
    const valid = sampleConfig({ profiles: { a: { ...sampleProfile("a") } } });
    expect(() => parseManagedConfig(valid)).not.toThrow();
  });
});

describe("first-run migration", () => {
  it("migrates from bpx-endpoints/config.json (pre-flat layout)", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    // Simulate the pre-flat fork layout: state dir + config.json inside it.
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(join(paths.dir, "config.json"), JSON.stringify(sampleConfig()), "utf8");

    await ensureMigrated(paths);
    expect(readFileSync(paths.config, "utf8")).toContain('"codex-lb"');
    // Source stays untouched.
    expect(readFileSync(join(paths.dir, "config.json"), "utf8")).toContain('"codex-lb"');
  });

  it("migrates from legacy custom-provider/config.json", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), JSON.stringify(sampleConfig()), "utf8");

    await ensureMigrated(paths);
    expect(readFileSync(paths.config, "utf8")).toContain('"codex-lb"');
  });

  it("does not convert a malformed legacy config into defaults", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), "{ broken", "utf8");

    await ensureMigrated(paths);
    // No flat file may be created from a broken source — recovery data survives.
    let flatExists = false;
    try {
      readFileSync(paths.config, "utf8");
      flatExists = true;
    } catch {
      // expected
    }
    expect(flatExists).toBe(false);
  });

  it("is idempotent: an existing flat file always wins", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await ensureConfigDir(paths);
    await writeManagedConfig(paths, sampleConfig());
    const flatBefore = readFileSync(paths.config, "utf8");

    // A legacy source with a different profile appears afterwards.
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), JSON.stringify(sampleConfig({ profiles: { other: sampleProfile("other") } })), "utf8");

    await ensureMigrated(paths);
    expect(readFileSync(paths.config, "utf8")).toBe(flatBefore);
    expect(readFileSync(paths.config, "utf8")).not.toContain('"other"');
  });

  it("copies derived state files only when each destination is absent", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), JSON.stringify(sampleConfig()), "utf8");
    writeFileSync(join(legacyDir, "cache.json"), JSON.stringify({ version: 1, profiles: {} }), "utf8");

    await ensureMigrated(paths);
    expect(readFileSync(paths.cache, "utf8")).toContain('"version":1');

    // Second run: destination exists, legacy is not copied over it.
    writeFileSync(join(paths.dir, "cache.json"), JSON.stringify({ version: 1, profiles: { marker: {} } }), "utf8");
    await ensureMigrated(paths);
    expect(readFileSync(paths.cache, "utf8")).toContain('"marker"');
  });

  it("copies derived state from legacy even when the flat file already exists", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await ensureConfigDir(paths);
    await writeManagedConfig(paths, sampleConfig());
    // Flat exists; only derived state is missing locally but present in legacy.
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "models.custom.json"), JSON.stringify({ providers: { "codex-lb": { models: [] } } }), "utf8");
    writeFileSync(join(legacyDir, "models.generated.json"), JSON.stringify({ providers: { "codex-lb": { models: [] } } }), "utf8");

    await ensureMigrated(paths);
    expect(readFileSync(paths.custom, "utf8")).toContain('"providers"');
    expect(readFileSync(paths.generated, "utf8")).toContain('"providers"');
    // Flat file unchanged.
    expect(readFileSync(paths.config, "utf8")).toContain('"codex-lb"');
  });

  it("surfaces a malformed legacy config as an error when no flat file exists", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), "{ broken", "utf8");

    const loaded = await loadManagedConfig(paths);
    expect(loaded.value).toBeUndefined();
    expect(loaded.missing).toBe(false);
    expect(loaded.error).toMatch(/Failed to parse/);
  });

  it("leaves the legacy directory untouched", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    const legacyDir = join(agentDir, "custom-provider");
    mkdirSync(legacyDir, { recursive: true });
    const legacyContent = JSON.stringify(sampleConfig());
    writeFileSync(join(legacyDir, "config.json"), legacyContent, "utf8");

    await ensureMigrated(paths);
    expect(readFileSync(join(legacyDir, "config.json"), "utf8")).toBe(legacyContent);
  });
});

describe("custom override layer", () => {
  it("keeps arbitrary fields in models.custom.json untouched", async () => {
    const agentDir = tempAgentDir();
    const paths = getConfigPaths(agentDir);
    await ensureConfigDir(paths);
    const custom = {
      providers: {
        "codex-lb": {
          models: [{ id: "gpt-5", compat: { someFutureField: { nested: [1, 2, 3] } }, unknown: "survives" }],
        },
      },
    };
    writeFileSync(paths.custom, JSON.stringify(custom), "utf8");

    const { loadModelsConfig } = await import("../src/io.js");
    const loaded = await loadModelsConfig(paths.custom);
    expect(loaded.error).toBeUndefined();
    expect(loaded.value?.providers["codex-lb"]?.models?.[0]?.compat).toEqual({ someFutureField: { nested: [1, 2, 3] } });
    expect(loaded.value?.providers["codex-lb"]?.models?.[0]).toHaveProperty("unknown", "survives");
  });
});
