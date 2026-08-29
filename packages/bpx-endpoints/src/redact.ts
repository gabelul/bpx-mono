import type { ModelsConfig } from "./types.js";

/**
 * redact — recursive secret redaction for exported/displayed model configs.
 *
 * The generated + custom merged config can carry secrets in more places than
 * the top-level provider.apiKey: custom provider headers (X-API-Key, custom
 * Authorization), per-model headers, and per-model overrides. Exporting or
 * echoing any of these leaks credentials. Redaction walks the whole tree and
 * masks literal values under secret-looking keys and inside any `headers`
 * object, while preserving $ENV / !command references verbatim (they resolve
 * at request time and are not themselves secrets).
 */

const SECRET_KEY_PATTERN = /^(?:api[-_ ]?key|authorization|token|secret|password|passwd)$/i;

export function maskSecret(value: string): string {
  if (value.startsWith("$") || value.startsWith("!")) return value;
  if (value.length <= 12) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively redact a plain JSON value (models config shape).
 * - Keys matching apiKey/authorization/token/secret/etc: mask string values.
 * - Any object under a key named `headers`: mask every string value (header
 *   values are commonly the credential themselves).
 * - Everything else is left untouched.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "headers") {
      out[key] = redactHeaders(item);
    } else if (typeof item === "string" && SECRET_KEY_PATTERN.test(key)) {
      out[key] = maskSecret(item);
    } else if (Array.isArray(item) || isRecord(item)) {
      out[key] = redactSecrets(item);
    } else {
      out[key] = item;
    }
  }
  return out;
}

function redactHeaders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactHeaders(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = typeof item === "string" ? maskSecret(item) : redactSecrets(item);
  }
  return out;
}

/** Deep-copy a ModelsConfig with all secrets masked — safe to export or print. */
export function maskEffectiveConfig(config: ModelsConfig): ModelsConfig {
  return redactSecrets(config) as ModelsConfig;
}
