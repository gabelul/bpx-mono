# Changelog

## 0.2.0 — 2026-09-05

### Features

- Solid-card overlays: every panel (endpoint manager, models, doctor, read-only views) draws a real box frame filled with the theme's floating-card color, and selected rows highlight with the theme selection color — the old borderless bands melted into the chat behind them. The manager sits centered at 104 columns (doctor 110, read-only 120).
- `baseUrl` accepts `$VAR`/`${VAR}` environment references and whole-value `!command`, like `apiKey` and `headers` already did. Mid-URL works (`http://${MY_HOST}:8080/v1`). Expansion happens at use time (discovery, reasoning probe, test messages, provider registration), so config files keep the reference and nothing resolved lands on disk. An unset variable fails fast with the profile id in the message.
- Reasoning-effort discovery: opt-in `discovery.reasoningProbe` probes the endpoint on refresh with tiny 1-token chat completions per candidate value (`low`/`medium`/`high`/`xhigh`), classifying acceptances, effort-related rejections, and timeouts (timeouts count as accepted when validation is eager — rejection is instant, generation is slow). Probe results are cached per profile and drive the generated `thinkingLevelMap`, mapping every pi thinking level to the nearest accepted effort.
- Manual `reasoningEfforts` per profile wins over probe results.
- `/endpoints probe-reasoning [id]` command, `ctrl+r` probe action in the models overlay, reasoning status line in the models overlay, and reasoning probe checks in `/endpoints doctor`.

### Fixed

- Doctor warns when a profile sets both `apiKey` and a custom `Authorization` header: pi appends the bearer token last and quietly overwrites the custom header.
- The startup reminder says "1 Endpoint has" instead of "1 Endpoint(s) have".
- Reasoning-effort 400s: generated configs for `openai-completions` reasoning models no longer copy metadata `thinkingLevelMap` verbatim. A null/missing entry made pi leak the raw thinking level ("high", "xhigh") as `reasoning_effort`, which strict servers reject (OpenAI accepts only `low`/`medium`/`high`; some self-hosted servers accept even less). bpx-endpoints now always emits a complete map from a canonical safe set unless live probing established the endpoint's actual accepted efforts.

### Housekeeping

- Removed dead `wizard.ts`; doctor gained its first tests and `baseUrl` resolution is covered by new tests (111 total, was 104).

## 0.1.0 — 2026-08-16

Initial release of `@booplex/bpx-endpoints`.

### Features

- `/endpoints` overlay for adding, editing, cloning, and deleting model endpoints
- Endpoint model discovery (endpoint or manual model ids) with connection testing
- Parameter metadata sync from pi's runtime registry and models.dev (cached locally, 24h TTL, offline fallback)
- Generated pi `models.json`-shaped config with live session registration
- Per-model parameter source selection and inclusion policies
- Custom override layer for advanced model field edits
- Test messages with provider error classification and hints
- `/endpoints doctor`, `list`, `refresh`, `export`, `open`, `test`, `settings`, `status` subcommands
- Full discovery URL override (`discovery.modelsUrl`) and opt-in path probing (`discovery.probe`) for non-standard endpoints like Ollama
- Bounded retries on transient discovery and models.dev failures (429/5xx/network, honoring Retry-After)
- Per-profile test health history surfaced in doctor and status
