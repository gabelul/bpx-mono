# bpx-consult — a council of AI advisors for pi

I kept losing my advisor mid-session. The tool I was using would die with "context window exceeded" right when I needed it most. Long debugging session, deep in a problem, and the second opinion I called for just errored out. The bug was straightforward: it forwarded the whole compacted session to the advisor model without checking whether that model's window could actually hold it. Point a smaller advisor at a session the executor had compacted to 128k and the call overflowed every time.

So I built my own. Started as "fix the window bug," became "while I'm here, let me get a real council instead of one advisor." `bpx-consult` is the result: one advisor when you want speed, several debating when the call actually matters, and the window-fit guarantee the whole thing exists to provide.

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

## What's not in v1

Honest about the scope so the README doesn't drift from the code:

- **Council members don't route to CLI** (solo only). A mixed inline+CLI council, one `completeSimple` member plus one CLI member running in parallel, is the headline v1.1 goal. It's what the whole async-subprocess decision is there to enable.
- **No per-member circuit-breaker / exponential backoff.** Resilience is isolation (`Promise.allSettled`) plus wall-clock timeouts. Smarter retry lands in v1.1.
- **No MCP delegation backend.** A council seat calling another MCP's consensus tool. v2.
- **No memory compression / branched-session handoff.** v2.

The [SPEC](./SPEC.md) has the full design, including the v1.1 and v2 sections.

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
- **[stitch-kit](https://github.com/gabelul/stitch-kit)** — Design superpowers for AI coding agents. 35 skills for ideation, generation, iteration, and production conversion via Google Stitch MCP.
- **[claude-code-skill-activator](https://github.com/gabelul/claude-code-skill-activator)** — Skill auto-detection for Claude Code. AI extracts keywords once, then fast offline matching suggests skills as you type.

---

Built by Gabi @ [Booplex.com](https://booplex.com) — because the advisor that dies when you need it most isn't an advisor, it's a liability. MIT license.
