<p align="center">
  <img src="https://raw.githubusercontent.com/gabelul/bpx-mono/main/.github/assets/hero.png" alt="Booplex pi extensions — a shelf of small handmade tools and little robot gadgets on a tinkerer's pegboard" width="100%">
</p>

# bpx-mono — Booplex pi extensions | tools for the pi coding agent

<p align="center">
  <a href="https://github.com/gabelul/bpx-mono/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/gabelul/bpx-mono/ci.yml?branch=main&label=CI&labelColor=1a1a2e&color=a855f7" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@booplex/bpx-consult"><img src="https://img.shields.io/npm/v/@booplex/bpx-consult?label=bpx-consult&color=2dd4bf&labelColor=1a1a2e&logo=npm&logoColor=white" alt="bpx-consult on npm"></a>
  <img src="https://img.shields.io/badge/license-MIT-888?labelColor=1a1a2e" alt="MIT license">
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-0.80%2B-a855f7?labelColor=1a1a2e" alt="pi 0.80+"></a>
  <a href="https://booplex.com"><img src="https://img.shields.io/badge/website-booplex.com-2dd4bf?labelColor=1a1a2e" alt="Booplex — booplex.com"></a>
</p>

Small, sharp extensions for [pi](https://pi.dev), the minimal terminal coding harness — built by [Booplex](https://booplex.com). The idea across all of them is the same: pi stays lean and does the work; these add the bits I kept wishing it had. Every package installs on its own, so you take only what you want — the monorepo just keeps them under one roof, one CI, and one release pipeline.

## What's inside

| Extension | What it does | Install |
|---|---|---|
| **[@booplex/bpx-consult](packages/bpx-consult/)**<br>a council of AI advisors | Run a cheap, fast model as your working agent and keep a stronger one on the bench to steer it — a solo second opinion, a full council, or two models debating the hard calls. Senior judgment on tap, paid for only when it counts.<br>[README](packages/bpx-consult/README.md) · [SPEC](packages/bpx-consult/SPEC.md) | `pi install npm:@booplex/bpx-consult` |

More on the way — the house is built to hold them.

## Requirements

- [pi](https://pi.dev) **0.80+** — the extensions build on pi's `@earendil-works/pi-ai` (`completeSimple`), its event handlers, and `sendUserMessage`.
- At least one model provider authed in pi (or an external CLI like `codex` / `claude`, depending on the extension).

## Install

Take whichever extension you want — you don't need the whole monorepo. The clean way is npm:

```bash
pi install npm:@booplex/bpx-consult
```

Restart your pi session and its tools and slash commands wire themselves in. Config and usage live in each package's own README.

Want to try one before you commit to it? Load it for a single session — no install, gone when you quit:

```bash
pi -e npm:@booplex/bpx-consult
```

Prefer source? Pull it from GitHub, or from a local clone if you're hacking on it:

```bash
pi install git:github.com/gabelul/bpx-mono     # from GitHub
pi install ./packages/bpx-consult              # from a local checkout
```

Tack `-l` onto any of these to scope the install to the current project (`.pi/`) instead of your global `~/.pi/agent/`. Once things are in: `pi list` shows what you've got, `pi config` toggles them on and off, and `pi remove` clears them out.

## Related — more Booplex tools for agents that care about quality

- **[slopbuster](https://github.com/gabelul/slopbuster)** — AI text humanizer. 100+ patterns, two-pass audit, three-tier scoring. Makes AI-generated prose, code comments, and academic writing sound human.
- **[pixelslop](https://github.com/gabelul/pixelslop)** — Design-quality scanner. Opens real pages in Playwright, measures actual pixels, catches visual AI slop.
- **[pixeltamer](https://github.com/gabelul/pixeltamer-gpt-image-skill)** — Generate, edit, and compose images with gpt-image-2. It drew every illustration in this repo.
- **[stitch-kit](https://github.com/gabelul/stitch-kit)** — Design superpowers for coding agents. 35 skills for ideation, generation, and production conversion via Google Stitch MCP.

## Contributing

PRs and issues welcome — start with the [contributing guide](CONTRIBUTING.md). Short version: keep commit titles conventional (they drive the release pipeline), and each extension keeps its tests and docs in its own package folder.

---

Built by Gabi @ [Booplex.com](https://booplex.com) — because pi is lovely and lean, and I kept wanting to hand it a second brain. MIT license.
