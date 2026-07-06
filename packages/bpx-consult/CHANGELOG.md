# Changelog

All notable changes to @booplex/bpx-consult are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
