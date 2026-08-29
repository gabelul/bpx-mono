# bpx-endpoints — every model endpoint, one command | pi extension

<p align="center">
  <a href="https://www.npmjs.com/package/@booplex/bpx-endpoints"><img src="https://img.shields.io/npm/v/@booplex/bpx-endpoints?color=a855f7&labelColor=1a1a2e&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@booplex/bpx-endpoints"><img src="https://img.shields.io/npm/dm/@booplex/bpx-endpoints?color=2dd4bf&labelColor=1a1a2e" alt="npm downloads"></a>
  <a href="https://github.com/gabelul/bpx-mono/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/gabelul/bpx-mono/ci.yml?branch=main&label=CI&labelColor=1a1a2e&color=a855f7" alt="CI"></a>
</p>

pi ships with presets for the big hosted providers, and that's fine until your models live somewhere pi has never heard of. A load balancer in front of your model accounts. The vLLM box under the desk. A regional gateway with its own key dance. The stock answer is hand-editing `~/.pi/agent/models.json`, then hand-updating it every time the endpoint's model list changes — which is exactly the kind of chore I build tools to kill.

`bpx-endpoints` puts all of it behind one command: `/endpoints`. Point an endpoint at pi and it discovers the model list, pulls parameter metadata from pi's registry plus [models.dev](https://models.dev), generates the config, and registers the endpoint into your live session. One Pi-native overlay holds the model-by-model knobs; refresh and doctor keep it honest over time.

Works in [pi](https://pi.dev) (the coding agent, v0.80+).

---

## What it's for

pi's built-in presets already cover the known providers with correct base URLs and metadata, so this extension doesn't duplicate a preset catalog. It covers everything the presets don't:

- OpenAI-compatible proxies and load balancers
- Self-hosted endpoints (LM Studio, Ollama, vLLM)
- Regional gateways
- Any deployment where you supply the base URL, protocol, and key yourself

## Install

```bash
pi install npm:@booplex/bpx-endpoints
```

Restart your pi session and `/endpoints` wires itself in.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/gabelul/bpx-mono
cd bpx-mono
pi install ./packages/bpx-endpoints
```

</details>

## Getting started

Everything runs through `/endpoints`. The typical first run:

1. Run `/endpoints add` (or open `/endpoints` and press `a`).
2. Fill in the endpoint form inside the Endpoint Manager. The Endpoint ID defaults to `endpoint-1` and stays editable. ↑/↓ to move, Enter to edit, → on Authentication to change its mode once a value is set.
3. Pick an **API protocol** from pi's runtime list, or enter a custom protocol id. Protocol is never inferred from the URL — an endpoint that speaks OpenAI-completions at an `/v1` path is not the same as one that speaks OpenAI-responses, and guessing wrong fails in confusing ways.
4. Enter the **Base URL** and choose authentication: None, environment variable, literal key, or shell command. None is valid for local services like LM Studio, vLLM, and llama.cpp.
5. Choose endpoint discovery or enter exact model IDs manually. `Ctrl+T` tests model discovery; a `/models` failure doesn't mean chat is broken — it means switch to manual IDs.
6. Save with `Ctrl+S`. The Endpoint Manager stays open and shows completion; model management and test messages are optional follow-ups.

Each endpoint maps to exactly one `pi.registerProvider()` call. Once saved, the endpoint generates into pi's config and registers live in the session — no restart needed.

## Commands

```text
/endpoints                 Open the Endpoint Manager overlay
/endpoints add             Add an endpoint through interactive prompts
/endpoints settings        Edit extension settings (same picker as /consult)
/endpoints status          Print a config / cache / generated read-out
/endpoints list            List endpoints
/endpoints refresh         Refresh all enabled endpoints
/endpoints refresh <id>    Refresh a single endpoint
/endpoints test <id> [model]   Send a test message (streams, reports latency)
/endpoints test --all          Batch-test all enabled endpoints (one confirm)
/endpoints probe-reasoning [id]  Probe accepted reasoning_effort values
/endpoints doctor          Diagnose config / cache / generated / custom state
/endpoints export [path]   Write masked effective generated + custom config
/endpoints open            Show the config file + state directory paths
```

The overlay is the primary interface; the subcommands are shortcuts for scripting and recovery. Add, edit, refresh, model management, and completion all happen inside one overlay session — no dialog teardown, no flicker. From the overlay you can also check endpoint status, clone (`y`), delete, send an explicit test message, and reach the advanced override layer. Test messages stream through the endpoint's real protocol (the exact registered model, including `models.custom.json` overrides), time out after 30s, and record latency + failure history that `/endpoints doctor` and `/endpoints status` surface.

## Model discovery and metadata

- **Discovery** runs in two modes: endpoint discovery (`discovery.mode: "endpoint"` + `modelsPath`) or manual entry (`discovery.mode: "manual"` + `modelIds`).
- **Full URL override**: `discovery.modelsUrl` bypasses baseUrl + path entirely — for endpoints like Ollama whose chat API lives at `.../v1` but model list at `http://host:11434/api/tags`.
- **Path probing** (`discovery.probe: true`): when the configured URL returns 404, an unsupported shape, or an empty list, bpx-endpoints automatically tries `/models`, `/v1/models`, `/api/tags`, and `/api/models` at the origin. Never on auth failures — 401/403 are reported, not guessed around. The resolved URL is cached per profile so later refreshes skip the guessing.
- **Response shapes** accepted: bare arrays, `data[]`, `models[]`, `data.models[]` nesting, and object-keyed maps. Duplicate ids are dropped, entries without an id are skipped (both counted in warnings).
- **Bounded retries**: discovery and models.dev sync retry once on transient network errors, 429 (honoring `Retry-After`), and 5xx.
- **Parameter sources** for each model come from pi's built-in metadata plus [models.dev](https://models.dev) sync, cached locally with a 24h TTL and offline fallback — refresh works without depending on a remote. Unsourced or fuzzy matches show as warnings; unsourced models fall back to built-in defaults until verified. The default source is the first sorted candidate, and you can pick another from `/endpoints`.
- **Inclusion policy** is `includeAll` with exclusions by default, or `includeOnly` with an explicit list of model ids.
- **Per-model overrides** of arbitrary fields live in `modelOverrides` or the custom override layer.

## Reasoning efforts

Pi sends `reasoning_effort = thinkingLevelMap[level] ?? level` to OpenAI-compatible endpoints. A null or missing map entry makes pi leak the raw thinking level ("high", "xhigh") as the wire value — and real servers reject those: OpenAI's schema only accepts `low`/`medium`/`high`, and some self-hosted servers accept even less. bpx-endpoints therefore never copies a metadata source's `thinkingLevelMap` verbatim for `openai-completions` reasoning models. It always emits a complete map:

- **Unknown endpoint** → canonical `low`/`medium`/`high` map, so no pi level can ever leak a rejected value.
- **Live probe** (`discovery.reasoningProbe: true`) → on refresh, bpx-endpoints sends one tiny chat completion (1 token) per candidate value (`low`, `medium`, `high`, `xhigh`) and records which the endpoint accepts. Rejections are classified from the error body; because validation is eager, a probe timeout counts as *accepted* (the server rejected the bad values instantly and is just slow at generating). The map then picks the nearest accepted effort for every pi thinking level.
- **Manual override** (`reasoningEfforts: ["low", "medium"]` on the profile) → wins over probe results, for endpoints where you already know the schema.
- If the endpoint accepts *no* effort value, reasoning models register as non-reasoning (any `reasoning_effort` would 400) with a doctor warning — set `compat.thinkingFormat` in `models.custom.json` if the model thinks via a different parameter.
- A **complete** `thinkingLevelMap` you author yourself (e.g. in `models.custom.json`) is never clobbered — explicit user intent wins when there's no probe/manual ground truth.

Probe results are cached per profile and surfaced in the models overlay (`ctrl+r` re-probes), in `/endpoints probe-reasoning [id]`, and in doctor/status. One probe run makes up to four 1-token calls, so it's opt-in via the form's *Reasoning probe* field.

## Custom headers

For endpoints that don't use the default `Authorization: Bearer <apiKey>` style, an endpoint can carry optional `headers`. They apply to endpoint discovery and land in the generated provider config for pi's requests. Header values support the same literal, `$ENV_VAR`, and `!command` forms as `apiKey`. Choose Authentication None when custom headers provide all required auth.

```json
{
  "headers": {
    "x-api-key": "$MY_GATEWAY_KEY"
  }
}
```

## Configuration

Managed config lives in a single flat file at `~/.pi/agent/bpx-endpoints.json` (the pi-native path, beside pi's own state) — TypeBox-schema validated, fail-soft on load, crash-resistant on save. Derived state lives under `~/.pi/agent/bpx-endpoints/`:

| File | Purpose |
| --- | --- |
| `bpx-endpoints.json` | Managed user intent: endpoint profiles + settings (TypeBox-validated) |
| `cache.json` | Discovered endpoint models and metadata candidates, plus per-profile test health (last test time, latency, failure count) |
| `models.generated.json` | Generated pi `models.json`-shaped config |
| `models.custom.json` | Unrestricted override layer, merged after the generated config |
| `models.dev.json` | Local models.dev catalog cache (24h TTL, offline fallback) |

The config directory is created `0700`; extension-owned JSON files are written `0600`. The extension never writes to pi's native `~/.pi/agent/models.json` — that file stays yours.

Settings edit through `/endpoints settings` (same interactive picker as `/consult`) or `/endpoints status` for a read-out: stale reminder on/off and the stale-day threshold (default 7). Status also summarizes test health per profile (ok / failing / never tested).

On first run, existing state is migrated automatically — from `bpx-endpoints/config.json` if present, otherwise the legacy `~/.pi/agent/custom-provider/` directory — so existing endpoints survive the switch. The flat file is never overwritten once it exists, and a malformed legacy config is never converted into defaults.

Startup only performs the local generated/custom merge and endpoint registration; it never touches the network. Deleted, disabled, or no-longer-generated endpoints unregister from the live session immediately. Endpoint rows show cache age, and `doctor` plus the startup reminder flag caches older than the stale threshold (set `settings.staleReminderDays` in `bpx-endpoints.json`, or `settings.staleReminder: false` to silence the reminder).

## Error handling

| Situation | Behavior |
| --- | --- |
| Missing `models.generated.json` | Normal onboarding; no endpoints registered |
| Invalid `models.generated.json` | Registration skipped, but `/endpoints`, refresh, doctor, and recovery still work |
| Invalid `models.custom.json` | Ignored with a warning; generated endpoints still register |
| Invalid `bpx-endpoints.json` | Already-generated endpoints still register, but edit/refresh enter recovery until fixed; `/endpoints settings` refuses to open over a broken file rather than overwrite it |
| Unresolved API protocol | The affected endpoint is invalid — not generated, not registered, no silent fallback |

## Development

```bash
git clone https://github.com/gabelul/bpx-mono
cd bpx-mono
npm install
npm run check   # typecheck + tests, monorepo-wide
```

Issues and PRs at [gabelul/bpx-mono](https://github.com/gabelul/bpx-mono/issues).
