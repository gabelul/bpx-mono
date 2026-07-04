# Changelog

All notable changes to @booplex/bpx-consult are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- v1: solo, council, debate, and gut-check consult modes.
- Context engine that fits the conversation to the advisor model's actual window (the §P fix).
- Triggers: onDone and whenStuck (loop + error detection), solo-only by design.
- CLI backend (codex/claude/opencode) via non-blocking subprocess.
- Wall-clock timeouts on council, debate, and CLI paths.
- Project-local config (`.pi/bpx-consult.json`, trusted projects only).
