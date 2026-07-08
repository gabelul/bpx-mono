# Changelog

All notable changes to @booplex/bpx-consult are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/gabelul/bpx-mono/compare/v0.1.5...v0.2.0) (2026-07-08)


### Features

* evidence-aware context fit + audit ledger (SPEC §E.0/§E.1) ([4bd4d19](https://github.com/gabelul/bpx-mono/commit/4bd4d19e3309985d144f3bf8cceb6395f5569aa5))
* wire feedbackMode, add phrase triggers and per-turn consult cap ([44d9ef9](https://github.com/gabelul/bpx-mono/commit/44d9ef935235453b51e6dc53260ca5bacd781aaa))


### Bug Fixes

* phrase-trigger blocking, double-consult, and loose council match ([f199541](https://github.com/gabelul/bpx-mono/commit/f1995417d0397ecbf8c1436c202ac883dbb91b6a))

## [0.1.5](https://github.com/gabelul/bpx-mono/compare/v0.1.4...v0.1.5) (2026-07-07)


### Features

* interactive /consult configurator — set models, mode, triggers without editing a file ([c6aa5d4](https://github.com/gabelul/bpx-mono/commit/c6aa5d47e83272315e239cc80b7960677d3eb677))

## [0.1.4](https://github.com/gabelul/bpx-mono/compare/v0.1.3...v0.1.4) (2026-07-07)


### Bug Fixes

* remove external-tool attribution from source and docs ([d6bf90a](https://github.com/gabelul/bpx-mono/commit/d6bf90af03ed5bd516d942040f23277ddfd56519))

## [0.1.3](https://github.com/gabelul/bpx-mono/compare/v0.1.2...v0.1.3) (2026-07-06)


### Bug Fixes

* **deps:** move typebox to peerDependencies; add gallery preview image ([33da3b0](https://github.com/gabelul/bpx-mono/commit/33da3b0d5af2da3e1ab3e42216f4014e43a3126b))

## [0.1.2](https://github.com/gabelul/bpx-mono/compare/v0.1.1...v0.1.2) (2026-07-05)


### Bug Fixes

* **test:** invoke CLI fixtures via bash so CI doesn't depend on exec bit ([1026af2](https://github.com/gabelul/bpx-mono/commit/1026af285d6583dffb2fb969a067073294c63688))

## [0.1.1](https://github.com/gabelul/bpx-mono/compare/v0.1.0...v0.1.1) (2026-07-05)


### Bug Fixes

* **timeout:** remove AbortSignal listener leak + drop dead linkSignal ([e4fea8f](https://github.com/gabelul/bpx-mono/commit/e4fea8f40799a163981769654959bc9bc35b8fe5))

## [Unreleased]

### Added
- v1: solo, council, debate, and gut-check consult modes.
- Context engine that fits the conversation to the advisor model's actual window (the §P fix).
- Triggers: onDone and whenStuck (loop + error detection), solo-only by design.
- CLI backend (codex/claude/opencode) via non-blocking subprocess.
- Wall-clock timeouts on council, debate, and CLI paths.
- Project-local config (`.pi/bpx-consult.json`, trusted projects only).
