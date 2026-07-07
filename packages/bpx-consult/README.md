<p align="center">
  <img src="https://raw.githubusercontent.com/gabelul/bpx-mono/main/packages/bpx-consult/.github/assets/hero.png" alt="A small, cheap coding agent at a workshop desk, guided by a council of three senior AI advisors — one approving, one skeptical, one running a checklist" width="100%">
</p>

# bpx-consult — a council of AI advisors for pi | pi extension

<p align="center">
  <a href="https://www.npmjs.com/package/@booplex/bpx-consult"><img src="https://img.shields.io/npm/v/@booplex/bpx-consult?color=a855f7&labelColor=1a1a2e&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@booplex/bpx-consult"><img src="https://img.shields.io/npm/dm/@booplex/bpx-consult?color=2dd4bf&labelColor=1a1a2e" alt="npm downloads"></a>
  <a href="https://www.npmjs.com/package/@booplex/bpx-consult#provenance"><img src="https://img.shields.io/badge/provenance-signed-2dd4bf?logo=npm&logoColor=white&labelColor=1a1a2e" alt="published with npm provenance"></a>
  <a href="https://github.com/gabelul/bpx-mono/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/gabelul/bpx-mono/ci.yml?branch=main&labelColor=1a1a2e&color=a855f7" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@booplex/bpx-consult?color=888&labelColor=1a1a2e" alt="MIT license"></a>
</p>

Your coding agent runs on a cheap, fast model most of the time, and most of the time that's the right call — it's grinding through edits, running tests, moving quick. The trouble is the handful of moments that actually decide how the thing turns out: the architecture choice, the "should I even build this," the bug it's been circling for twenty minutes. That's where cheap-and-fast quietly makes the wrong call, and you don't catch it until three commits later.

`bpx-consult` is the smarter, pricier model you keep on the bench for exactly those moments. One advisor for a quick gut-check, a whole council when the call's genuinely hard, two of them arguing it out when it's contentious. Let the cheap model do the typing; pay senior rates only when senior judgment is actually worth it.

None of this is a new trick for me. I'd already run the same idea — cheap models doing the grunt work, a stronger, pricier one taming and steering them — in a private MCP of my own, well before I needed it in pi. So when I wanted it here, I wasn't starting from scratch; I knew the pattern worked.

The catch was the advisor extension I tried in pi kept dying on me: it forwarded the entire session to the advisor without checking whether the advisor's own window could hold it, so my second opinion errored out at exactly the moment the session got long enough to need one. So I built `bpx-consult` — same pattern, done right for pi. And once you're already paying to call a second model, why stop at one, and why only to review? A council. A debate. A cheap model driving and an expensive one steering — with a context engine that finally makes it survive a long session, which is the part the old extension never got right.

Four modes, all wired: **solo** (one model, fast), **council** (several models in parallel with stances and a synthesizer), **debate** (advocate vs critic, sequential rounds, closing verdict), and **gut-check** (one cheap model, terse read). Plus triggers that fire a consult automatically when you're stuck or when a turn finishes.

Works in [pi](https://pi.dev) (the coding agent, v0.80+).

---

## Install

```bash
pi install npm:@booplex/bpx-consult
```

Then restart your pi session. The `consult` tool and `/consult` command register automatically.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/gabelul/bpx-mono
cd bpx-mono
pi install ./packages/bpx-consult
```

</details>

---

## The window bug, and the fix

The reason this extension exists. Every consult path runs the conversation through a context engine before it reaches the advisor model:

1. **Strip** the in-flight `consult()` call. Providers reject orphan tool calls.
2. **Cap** each message (user text, assistant text, tool args, tool results) with explicit `[truncated]` markers. Never silent drops.
3. **Fit to a sliding window.** Keep the first few messages (task framing) and the last several (freshest evidence). Drop oldest-first with an `[omitted]` marker.
4. **Reserve** tokens for the advisor's reply, derived live from *that* advisor's context window minus a response reserve.

The budget is read per-call from the advisor model's actual window via the registry, never a global constant. Point a 32k flash-tier advisor at a 128k session and it fits. Point an 8k CLI advisor at the same session and it still fits. Council fits every member to the *smallest* window in the roster so the weakest member can't overflow.

Every mode goes through this.

---

## The four modes

| mode | what it does | when to reach for it |
|---|---|---|
| **solo** | One advisor model, one response. | Default. Fast, cheap, the second opinion you reach for most days. |
| **council** | Several models in parallel, each with a stance (for/against/neutral) and a persona. A synthesizer merges their verdicts with a confidence score. | Real decisions. Architecture, "should I even do this," tricky bugs where one voice isn't enough. |
| **debate** | Advocate proposes, critic attacks, advocate rebuts. Sequential rounds (1–4), then a synthesizer issues a verdict. | Controversial calls where you want the strongest case on both sides before you commit. |
| **gut-check** | One cheap fast model, terse output. | The "does this smell off?" sanity check before you do something you're 90% sure about. |

Call `consult()` with no args and solo runs. Pass `mode: "council"` (or `debate`, `gut-check`) to pick another. Or type `/consult` to open the status read-out and edit the config file.

---

## What it looks like

The executor calls `consult()` on its own when it wants a second opinion, or you invoke it by hand. Every arg is optional:

```ts
consult()                                          // solo, default model
consult({ question: "Is this auth flow sane?" })   // solo, with a specific ask
consult({ mode: "council" })                       // full roster, in parallel
consult({ mode: "debate", question: "Rewrite the parser, or patch it?" })
```

Here's a real council call — I asked whether to ship a half-built feature for the next morning's demo. The architect argued for it, the critic argued against, and the synthesizer refused to average them into mush (trimmed, but the verdict and numbers are from the actual run):

```text
COUNCIL — architect (for) · critic (against) · simplifier (neutral)

The council split. Surfaced honestly, not papered over:
  • architect (FOR)  — a demo doesn't need production rigor; ship it, caveat it live.
  • critic (AGAINST) — a broken demo teaches the room the wrong thing; the risk IS the story.
  • simplifier       — the pre-recorded path costs nothing and removes the failure mode entirely.

VERDICT — STOP. Demo the pre-recorded flow; ship the real feature once it's tested.
confidence 0.83   (success 1.0 · agreement 0.5 · alignment 1.0)
```

That `agreement 0.5` is the disagreement showing up in the math: two of three held opposing stances, so the confidence dial drops. That's the feature, not a bug. A council that always reported high confidence wouldn't be worth the tokens.

---

## Council, in more detail

This is the reason I went past a bugfix. The default roster seats three personas: **architect** (advocates for the design), **critic** (attacks it), **simplifier** (questions the complexity). Each runs on a distinct model tier so parallel calls don't trip provider rate limits, and each gets a stance-injected system prompt.

The stance framing biases what a persona hunts for, never the verdict. A `for` persona can still land on "don't do this" if the evidence says so. The guardrail is baked into the prompt because the alternative is theater: a critic that rubber-stamps, an advocate that caves.

When members genuinely disagree, the synthesizer is told to **surface the split**, not paper over it. A false consensus is worse than an honest "the architect argued X, the critic demolished it, here's my call." Every council result carries a confidence score (`0.4·success + 0.35·agreement + 0.25·stance-alignment`). It's a rough signal, not a verdict. The "agreement" term measures whether members landed on the same stance regardless of persona, which is roster-shaped: a default for/against/neutral trio will score lower on agreement than three neutrals. Treat it as a dial, not a grade.

---

## Triggers

Consults don't have to be manual. Two auto-triggers, both off by default:

- **whenStuck:N** fires after N consecutive tool errors *or* N identical tool calls (loop detection via an un-truncated `toolName:input` fingerprint). Default N = 3.
- **onDone** fires when the agent finishes a turn, then reviews the work.

Auto-triggers always run **solo**, regardless of your default mode. An auto-fire is a safety net, not a deliberate consultation. A council burning 3+ model calls every time you hit a loop would be a surprise-quota footgun. If you want a council, call it explicitly.

Triggers never fire in untrusted projects.

---

## How advice reaches the executor

A consult result can come back three ways, set with `feedbackMode` in the config. The default, **steer**, injects it as a steering message mid-run so you get the advice without leaving the flow and the executor sees it and continues. **pipe** injects it as a user message, so the executor treats it as your input. **show** is UI-only: you read it, the executor never sees it.

Auto-triggers always steer so they don't interrupt. Manual consults honor whatever you've configured.

---

## Backends

Solo can route to an external CLI instead of pi's inline provider. Set `backends.<model>.type: "cli"` in the config. Supported CLIs: `codex`, `claude`, `opencode`. Each reads the fitted context from stdin. The subprocess is non-blocking, so it doesn't serialize under the hood.

In v1, the CLI backend is solo-only. Council members don't route to CLI yet. That's a [v1.1 goal](#whats-not-in-v1).

---

## Resilience

Two things that would silently bite, both handled.

Each council member runs under its own `AbortController` linked to the parent signal, so one member timing out or erroring drops only that member. The rest proceed and the synthesizer works with whoever replied. A flaky member never crashes the council.

Wall-clock timeouts cover the hang case across all modes. Council (`council.timeoutMs`, default 120s), debate (`debate.timeoutMs`, default 180s), and CLI (`timeoutMs` per backend) all have explicit budgets. A provider that accepts-then-hangs settles as a clean failure instead of hanging the executor turn.

What v1 does *not* have: per-member circuit-breaker with exponential backoff. Isolation plus timeouts is the resilience story today. Smarter retry is on the v1.1 list.

---

## Config

`~/.pi/agent/bpx-consult.json` (global) or `.pi/bpx-consult.json` (project-local, trusted projects only). Project overrides global at the leaf level.

```jsonc
{
  "defaultMode": "solo",
  "modes": {
    "solo":     { "model": "anthropic/claude-sonnet-4-6", "thinkingLevel": "high" },
    "gutCheck": { "model": "google/gemini-2.5-flash", "thinkingLevel": "low", "terse": true },
    "council":  { "members": ["architect", "critic", "simplifier"], "synthesizer": { "model": "anthropic/claude-sonnet-4-6" }, "parallel": true, "timeoutMs": 120000 },
    "debate":   { "advocate": "architect", "critic": "critic", "rounds": 2, "timeoutMs": 180000 }
  },
  "personas": {
    "architect":  { "defaultModel": "anthropic/claude-opus-4-6" },
    "critic":     { "defaultModel": "anthropic/claude-sonnet-4-6" },
    "simplifier": { "defaultModel": "anthropic/claude-haiku-4-5" }
  },
  "backends": {
    "openai/codex": { "type": "cli", "command": "codex", "timeoutMs": 60000 }
  },
  "triggers": { "onDone": false, "whenStuck": 3 },
  "contextBudget": { "responseReserveTokens": 4096 }
}
```

The defaults are pinned to specific model versions, which means they'll drift as Anthropic ships new ones. The registry supports tier aliases in some places; where it does, prefer an alias. Otherwise expect to update these periodically, or override `personas.*.defaultModel` with whatever you actually have authed.

---

## Roadmap

Where this is heading next:

- **v1.1 — mixed inline+CLI council.** The async-subprocess plumbing is already in place so a council can seat one `completeSimple` member and one CLI member running in parallel. Wiring the CLI backend into council members (not just solo) is the headline next step.
- **v1.1 — smarter retry.** Resilience today is per-member isolation plus wall-clock timeouts. Per-member circuit-breaker with exponential backoff is the next layer for flaky providers.
- **v2 — research-backed council.** Council today argues from stances and the session transcript alone. The next layer grounds those arguments: advisors that web-search for evidence behind their position, focus-area steering (weigh security, or performance, or cost specifically), and context beyond the transcript (files, diagrams, images). Building it natively, not as a call-out to another MCP — the pattern's proven, owning it beats delegating it.
- **v2 — memory compression and branched-session handoff.** For very long sessions and dedicated per-persona advisor forks.

The full design (including the decisions behind each of these) is in [SPEC.md on GitHub](https://github.com/gabelul/bpx-mono/blob/main/packages/bpx-consult/SPEC.md).

---

## Prerequisites

- pi 0.80+ (uses the `@earendil-works/pi-ai/compat` `completeSimple` entry, event handlers, `sendUserMessage`)
- At least one provider authed via `/login`. The default roster uses Anthropic; override `personas.*.defaultModel` to match what you have.
- For the CLI backend: `codex`, `claude`, or `opencode` installed and on PATH.

---

## Related

Other tools for agents that care about quality:

- **[slopbuster](https://github.com/gabelul/slopbuster)** — AI text humanizer. 100+ patterns, two-pass audit, three-tier scoring. Makes AI-generated prose, code comments, and academic writing sound human.
- **[pixelslop](https://github.com/gabelul/pixelslop)** — Design quality scanner. Opens real pages in Playwright, measures actual pixels, catches visual AI slop.
- **[pixeltamer](https://github.com/gabelul/pixeltamer-gpt-image-skill)** — Generate, edit, and compose images with gpt-image-2. It drew this project's brand art.
- **[stitch-kit](https://github.com/gabelul/stitch-kit)** — Design superpowers for AI coding agents. 35 skills for ideation, generation, iteration, and production conversion via Google Stitch MCP.

---

Built by Gabi @ [Booplex.com](https://booplex.com) — because the advisor that dies when you need it most isn't an advisor, it's a liability. MIT license.
