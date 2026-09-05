import { describe, expect, it } from "vitest";
import { buildDoctorReport } from "../src/doctor.js";
import type { DiscoveryCache, FileLoadResult, ManagedConfig, ModelsConfig } from "../src/types.js";

function managedWith(profileOverrides: Partial<ManagedConfig["profiles"][string]>): FileLoadResult<ManagedConfig> {
  return {
    missing: false,
    value: {
      version: 1,
      settings: {},
      profiles: {
        "p1": {
          id: "p1",
          name: "P1",
          enabled: true,
          api: "openai-completions",
          baseUrl: "http://localhost:1234/v1",
          modelPolicy: { mode: "includeAll" },
          discovery: { mode: "endpoint", modelsPath: "/models" },
          ...profileOverrides,
        },
      },
    },
  };
}

const emptyLoad = { missing: true } as FileLoadResult<ModelsConfig>;
const emptyCache = { missing: true } as FileLoadResult<DiscoveryCache>;

function reportFor(overrides: Partial<ManagedConfig["profiles"][string]>) {
  return buildDoctorReport({
    configDir: "/tmp",
    managed: managedWith(overrides),
    cache: emptyCache,
    generated: emptyLoad,
    custom: emptyLoad,
    runtimeAdapters: ["openai-completions"],
    now: new Date("2026-09-05T12:00:00Z"),
  });
}

describe("buildDoctorReport auth conflict", () => {
  it("warns when a profile sets both apiKey and a custom Authorization header", () => {
    const report = reportFor({ apiKey: "sk-test", headers: { Authorization: "Bearer custom" } });
    const issue = report.issues.find((item) => item.code === "auth_conflict");
    expect(issue?.level).toBe("warning");
    expect(issue?.message).toContain("p1");
  });

  it("ignores header-key casing when detecting the conflict", () => {
    const report = reportFor({ apiKey: "sk-test", headers: { "aUtHoRiZaTiOn": "Bearer custom" } });
    expect(report.issues.some((item) => item.code === "auth_conflict")).toBe(true);
  });

  it("does not warn when only one auth mechanism is configured", () => {
    const apiKeyOnly = reportFor({ apiKey: "sk-test" });
    expect(apiKeyOnly.issues.some((item) => item.code === "auth_conflict")).toBe(false);
    const headerOnly = reportFor({ headers: { Authorization: "Bearer custom" } });
    expect(headerOnly.issues.some((item) => item.code === "auth_conflict")).toBe(false);
  });
});
