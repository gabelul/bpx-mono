# bpx-endpoints — every model endpoint, one command | pi extension

<p align="center">
  <img src="https://raw.githubusercontent.com/gabelul/bpx-mono/main/packages/bpx-endpoints/.github/assets/hero.png" alt="A small clay robot at a workshop desk, plugged by a thick braided cable into a patch panel of colorful endpoint cables and three tiny homelab machines" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@booplex/bpx-endpoints"><img src="https://img.shields.io/npm/v/@booplex/bpx-endpoints?color=a855f7&labelColor=1a1a2e&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@booplex/bpx-endpoints"><img src="https://img.shields.io/npm/dm/@booplex/bpx-endpoints?color=2dd4bf&labelColor=1a1a2e" alt="npm downloads"></a>
  <a href="https://github.com/gabelul/bpx-mono/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/gabelul/bpx-mono/ci.yml?branch=main&label=CI&labelColor=1a1a2e&color=a855f7" alt="CI"></a>
</p>

pi ships with presets for the big hosted providers, and that's fine until your models live somewhere pi has never heard of. A load balancer in front of your model accounts. The vLLM box under the desk. A regional gateway with its own key dance. The stock answer is hand-editing `~/.pi/agent/models.json`, then hand-updating it every time the endpoint's model list changes — which is exactly the kind of chore I build tools to kill.

`bpx-endpoints` puts all of it behind one command: `/endpoints`. Point an endpoint at pi and it discovers the model list, pulls parameter metadata from pi's registry plus [models.dev](https://models.dev), generates the config, and registers the endpoint into your live session. One pi-native panel holds the model-by-model knobs; refresh and doctor keep it honest over time.

Works in [pi](https://pi.dev) (the coding agent, v0.80+).

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

## Quick start

1. Run `/endpoints` and press `a` to add an endpoint.
2. Fill in the form: an id, the base URL (`http://localhost:11434/v1` for a local Ollama, say), the API protocol, and the key — or Authentication None for open local endpoints.
3. Choose how models are discovered: the endpoint's own `/models` list (default) or manual ids. Press `ctrl+t` to test the connection, `ctrl+s` to save.

That's it. The models register into your running pi session immediately — no restart, no hand-written JSON. From the manager you can refresh (`r`), edit, clone (`y`), delete (`x`), and drill into per-model settings.

## Commands

```text
/endpoints                 Open the Endpoint Manager
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

The manager is the primary interface; the subcommands are shortcuts for scripting and recovery. It renders as a framed, solid panel centered at 104 columns — filled with your theme's card background, selected rows highlighted — so it reads as a dialog instead of more chat text. Model management, refresh, and completion happen inside the same panel session; the advanced override layer is one keystroke away.

## Discovery, metadata, and refresh

Discovery runs in two modes: the endpoint's own model list (`discovery.mode: "endpoint"` + `modelsPath`) or manual entry (`discovery.mode: "manual"` + `modelIds`). A few things worth knowing about how discovery behaves:

- **Full URL override**: `discovery.modelsUrl` bypasses baseUrl + path entirely — for endpoints like Ollama whose chat API lives at `.../v1` but model list at `http://host:11434/api/tags`.
- **Path probing** (`discovery.probe: true`): when the configured URL 404s or returns something unexpected, bpx-endpoints tries the common variants (`/models`, `/v1/models`, `/api/tags`, `/api/models`) at the origin. Never on auth failures — 401/403 are reported, not guessed around. The resolved URL is cached per profile.
- **Response shapes**: bare arrays, `data[]`, `models[]`, `data.models[]` nesting, and object-keyed maps all parse. Duplicate ids drop, id-less entries skip — both counted in warnings you'll see in doctor.
- **Retries**: transient network errors, 429 (honoring `Retry-After`), and 5xx retry with backoff. Auth failures don't.
- **Parameter sources** come from pi's built-in metadata plus a [models.dev](https://models.dev) sync cached locally (24h TTL, offline fallback), so refresh works when you're offline. Fuzzy matches surface as warnings; you can pick a different source per model from the manager.
- **Inclusion policy** is include-all with exclusions by default, or `includeOnly` with an explicit list.

## Reasoning efforts

OpenAI-compatible endpoints reject unknown `reasoning_effort` values, and pi's thinking levels (`low` through `xhigh`) don't map onto every server's schema. So bpx-endpoints never copies a metadata source's `thinkingLevelMap` verbatim; it always emits a complete map:

- **Unknown endpoint** → a canonical `low`/`medium`/`high` map that no pi level can leak through.
- **Live probe** (`discovery.reasoningProbe: true`, or `ctrl+r` in the models view) → up to four 1-token completions record which effort values the endpoint actually accepts, and the map picks the nearest accepted value for every pi level. Probe results cache per profile.
- **Manual override** (`reasoningEfforts: ["low", "medium"]`) → wins over probe results.
- An endpoint that accepts *no* effort value registers its reasoning models as non-reasoning, with a doctor warning.

A complete `thinkingLevelMap` you author yourself in `models.custom.json` is never clobbered.

## Keys, headers, and baseUrl references

Endpoints authenticate with `apiKey` (sent as `Authorization: Bearer ...`) unless you choose None and provide auth through custom headers. Secrets don't have to be literals in the config:

- `$VAR` and `${VAR}` expand from the environment; `!command` runs a shell command and uses its stdout. Header values and `apiKey` accept both; `baseUrl` accepts them too, including mid-URL: `"baseUrl": "http://${MY_HOST}:8080/v1"`.
- Expansion happens at use time — discovery, tests, and registration — so config files keep the reference and nothing resolved lands on disk. An unset variable fails fast with the profile id in the message. `!command` must be the whole value.
- A profile setting both `apiKey` and a custom `Authorization` header gets a doctor warning: pi appends the bearer token last, so it would silently win.

## Configuration

Managed config lives in a single flat file at `~/.pi/agent/bpx-endpoints.json` (the pi-native path, beside pi's own state) — TypeBox-schema validated, fail-soft on load, crash-resistant on save. Derived state lives under `~/.pi/agent/bpx-endpoints/`:

| File | Purpose |
| --- | --- |
| `bpx-endpoints.json` | Managed user intent: endpoint profiles + settings |
| `cache.json` | Discovered models, metadata candidates, per-profile test health |
| `models.generated.json` | Generated pi `models.json`-shaped config |
| `models.custom.json` | Unrestricted override layer, merged after the generated config |
| `models.dev.json` | Local models.dev catalog cache |

The config directory is created `0700`; extension-owned JSON files are written `0600`. The extension never writes to pi's native `~/.pi/agent/models.json` — that file stays yours.

On first run, existing state migrates automatically (from `bpx-endpoints/config.json` or the legacy `~/.pi/agent/custom-provider/` directory), so existing endpoints survive the switch. Startup never touches the network; it merges and registers locally. Caches older than the stale threshold (default 7 days, `settings.staleReminderDays`) trigger a gentle reminder and a doctor warning.

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
