# Changelog

## [0.3.1](https://github.com/gabelul/bpx-mono/compare/bpx-endpoints-v0.3.0...bpx-endpoints-v0.3.1) (2026-09-25)


### Bug Fixes

* **bpx-endpoints:** treat an empty manual reasoningEfforts list as unset ([00e81a1](https://github.com/gabelul/bpx-mono/commit/00e81a1363d7347883eefdd439ccfcbd089a69d0))

## [0.3.0](https://github.com/gabelul/bpx-mono/compare/bpx-endpoints-v0.2.0...bpx-endpoints-v0.3.0) (2026-09-25)


### Features

* **bpx-endpoints:** reasoning evidence per model, error mining, responses coverage, true off ([152dec4](https://github.com/gabelul/bpx-mono/commit/152dec4d756d07822e083911ed1b5df19ba1adf0))


### Bug Fixes

* **bpx-endpoints:** close third-review gaps in reasoning evidence and gates ([96c4c2c](https://github.com/gabelul/bpx-mono/commit/96c4c2cb9b27a18f80c9e4166b0091d4d7f36cc1))

## 0.3.0 — 2026-09-25

### Fixes

- **Reasoning policy now covers `openai-responses` profiles.** v0.2.x skipped them entirely, so models behind a Responses-API endpoint (e.g. vLLM's `/v1/responses`) got no `thinkingLevelMap` at all — pi leaked its raw thinking level as the wire value and the endpoint 400'd. Both OpenAI APIs now share the full policy.
- **Evidence is per-model, not per-endpoint.** One model's probe result was previously applied to every model on the profile (and the probe ran on the first *available* model, which might not even reason). Evidence is now keyed by model id, only reasoning-flagged models are probed, and a sibling's accepted set is never reused. Legacy single-result caches migrate to their recorded model.
- **Timeouts are unknown, not accepted.** v0.2.x promoted timed-out probe values to accepted when the server showed any fast signal; queued servers and delayed validation make silence ambiguous. Timeouts are recorded as `timedOut` and excluded from the map. All-timeout-with-zero-signals remains fatal.
- **Explicit map precedence.** A user-authored `thinkingLevelMap` (models.custom.json override) always wins: complete maps pass through untouched, and partial maps keep their authored entries — including `null` values, which pi renders as unsupported levels — while only *missing* keys are filled. Previously any non-complete map (nulls included) was clobbered wholesale by probe/manual data or the canonical set.

### Features

- **Error-message mining.** When a probe request or test message dies on an effort-specific rejection, the body is mined for a declared supported set ("Supported types are xhigh (default), medium, and low"). Mining is guarded three ways: structured `error.message` fields are preferred over raw bodies, sentences that negate support ("reasoning_effort is not supported") are dropped so echoed request values can't be mistaken for declarations, and extraction windows require affirmative declaration phrases. Mined values are stored as `advertised` — safe to send, not exhaustive — and union with probe acceptances, minus anything the endpoint effort-rejected. A failed test message that yields a set teaches the profile immediately (evidence replaces any older acceptance for that model, since the endpoint just contradicted it) and re-registers the config. This is refresh/test-time learning; the extension is not inside pi's request path, so mid-conversation 400s are not intercepted.
- **True off via wire value.** The effort vocabulary now includes `none` and `minimal`. When an endpoint accepts `none`, pi's `off` level maps to it — zero reasoning tokens instead of a token-burning `low` (verified against a Qwen3.8-27B vLLM serving: 0 vs 52 thinking tokens on a trivial question).
- **Wider probe vocabulary** (`low`/`medium`/`high`/`xhigh`/`minimal`/`none`) with a per-refresh budget (max 3 models, oldest evidence first) and 24h evidence freshness keyed to the endpoint's identity (resolved baseUrl + api): repoint a profile at a different backend (configured URL change) and the old evidence is re-probed, not reused — note this validates configuration changes, not silent swaps behind an unchanged front URL, which nothing client-side can detect. Freshness is also re-checked at generate time, not only when refreshing. Migrated v0.2.x evidence (any record without a recorded endpoint identity) is flagged `degraded` — v0.2 promoted timeouts to acceptances, so migrated sets re-probe on the first refresh instead of riding on guessed values. Registering non-reasoning now requires the probe to have attempted the full effort vocabulary: a restricted candidate set leaves the model inconclusive (canonical map + a doctor note) instead of non-reasoning. Legacy caches normalize at the generation and TUI read boundaries, so old cache files are safe to load. The probe command, models-overlay status line, doctor lines, and manager form fields now cover responses profiles too, and models with a per-model API override are skipped by the probe rather than probed with the wrong payload.
- **Transport-verified true off.** The wire behavior is pinned by integration tests against pi-ai's real adapters (not just config generation): with a map routing `off → "none"`, the completions adapter sends `reasoning_effort: "none"` (both via an explicit `"off"` and via an omitted reasoning option — the public caller contract), the responses adapter sends `reasoning.effort: "none"`, and a map with `off: null` sends no effort field at all (level unsupported).
- The non-reasoning doctor note now points at pi's native escape hatch (`compat.supportsReasoningEffort: false` + a `thinkingFormat`) instead of implying non-reasoning is the only option.

### Breaking-ish

- Probe timeout semantics changed as above — cached v0.2.x evidence re-derives through the new rules on next refresh.

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
