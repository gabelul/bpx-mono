# Changelog

## Unreleased

### Fixed

- Reasoning-effort 400s: generated configs for `openai-completions` reasoning models no longer copy metadata `thinkingLevelMap` verbatim. A null/missing entry made pi leak the raw thinking level ("high", "xhigh") as `reasoning_effort`, which strict servers reject (OpenAI accepts only `low`/`medium`/`high`; some self-hosted servers accept even less). bpx-endpoints now always emits a complete map from a canonical safe set unless live probing established the endpoint's actual accepted efforts.

### Features

- Reasoning-effort discovery: opt-in `discovery.reasoningProbe` probes the endpoint on refresh with tiny 1-token chat completions per candidate value (`low`/`medium`/`high`/`xhigh`), classifying acceptances, effort-related rejections, and timeouts (timeouts count as accepted when validation is eager — rejection is instant, generation is slow). Probe results are cached per profile and drive the generated `thinkingLevelMap`, mapping every pi thinking level to the nearest accepted effort.
- Manual `reasoningEfforts` per profile wins over probe results.
- `/endpoints probe-reasoning [id]` command, `ctrl+r` probe action in the models overlay, reasoning status line in the models overlay, and reasoning probe checks in `/endpoints doctor`.

## [0.2.0](https://github.com/gabelul/bpx-mono/compare/bpx-endpoints-v0.1.0...bpx-endpoints-v0.2.0) (2026-08-29)


### Features

* **bpx-endpoints:** reasoning-effort probe + safe thinking maps ([e820ba6](https://github.com/gabelul/bpx-mono/commit/e820ba62bde340d7044c9a1681f963f1979b792b))

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
