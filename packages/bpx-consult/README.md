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

If you're on a `0.x` install and Pi doesn't show an update notice, install the current release explicitly:

```bash
pi install npm:@booplex/bpx-consult@latest
```

Pre-1.0 npm ranges can pin you to an older minor line. Semver: technically correct, spiritually annoying.

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

The reason this extension exists. The advisor extension I tried forwarded the whole session to the advisor without checking whether the advisor's *own* window could hold it — so my second opinion errored out at exactly the moment the session got long enough to need one. Every consult path here runs the conversation through a context engine first. Inline windows come from Pi's model registry; CLI windows use a declared size, discovered OpenCode metadata, or a preset cap for Codex/Claude. Point a 32k flash-tier advisor at a 128k session and it fits. Point an 8k CLI advisor at the same session and it still fits. Council fits every member to the *smallest* window in the roster, so the weakest member can't overflow.

That's the guarantee. What changed in 0.2.0 is *how* it fits.

### Evidence-aware fit (0.2.0)

The old fit was blunt: keep the first couple messages, keep the last several, drop the middle, char-cap what's left. It never overflowed — but "keep recent, drop old" is a lousy proxy for "keep what matters." In a long debugging session the line that explains why you're stuck is usually in the *middle*, and blindly char-truncating a message shreds the one stack trace or diff the advisor needed.

So now the engine classifies before it cuts. Every message gets a deterministic tag — `directive`, `diff`, `failing-output`, `stack-trace`, `test`, `exploration`, and so on — from its role and content, **never from the model's own judgment** (the stuck model is the worst judge of what's safe to drop). Then it fills the window by priority, not by position:

1. **Your question and task framing** — pinned, first.
2. **The payload** — the latest failure and the latest diff, verbatim. This is the thing you're actually asking about.
3. **Pinned artifacts** — reviewer findings, repeated-failure signatures.
4. **Recent tail**, verbatim while there's room.
5. **Older path** — compressed to one-line signals (`read x.ts`, `edit y.ts (+30/-5)`, `$ npm test (exit 1)`), then dropped.

**Compress the path, preserve the payload.** Tool calls and their matching results are selected as one exchange, including multi-tool turns. If a whole exchange won't fit, it becomes a labeled text signal instead of a broken half-call. Pinned items never get silently dropped — if one's too big it degrades (verbatim → signal → clipped-to-anchors with markers), and in the pathological case where even the essentials won't fit, it fails closed with a clean error instead of overflowing. Every drop, every clip is marked. The full design is in [SPEC §E](SPEC.md#§e--context-engine-v2-evidence-aware-fit--progressive-council-roadmap).

### The ledger

Because it now decides *what* to keep, it can tell you what it did. Every consult result carries a ledger — `{ kept, compressed, clipped, dropped }` counts plus the `fittedTokens` estimate. Check the tool-result details after a consult and you can see exactly how a 150k session got fitted into a 28k advisor: what survived verbatim, what got compressed to a signal, what fell off the end. It's the measuring tape — if you're wondering whether the fit is losing something it shouldn't, the ledger is where you look.

---

## The four modes

| mode | what it does | when to reach for it |
|---|---|---|
| **solo** | One advisor model, one response. | Default. Fast, cheap, the second opinion you reach for most days. |
| **council** | Several models in parallel, each with a stance (for/against/neutral) and a persona. A synthesizer merges their verdicts with a confidence score. | Real decisions. Architecture, "should I even do this," tricky bugs where one voice isn't enough. |
| **debate** | Advocate proposes, critic attacks, advocate rebuts. Sequential rounds (1–4), then a synthesizer issues a verdict. | Controversial calls where you want the strongest case on both sides before you commit. |
| **gut-check** | One cheap fast model, terse output. | The "does this smell off?" sanity check before you do something you're 90% sure about. |

Call `consult()` with no args and solo runs. Pass `mode: "council"` (or `debate`, `gut-check`) to pick another. Tool results use one compact `consult / mode` heading rather than four unrelated layouts: actual route and execution state stay visible, advice stays readable in full, and Ctrl+O expands seat details, consultation ID and reported usage. Unknown CLI spend stays unknown. Council reports each seat as it finishes, then synthesis; Debate shows rounds and closing verdict. Those are progress updates, not extra advisor calls.

Type **`/consult`** to configure routes interactively: Solo, gut-check, Council members, and the synthesizer each have a backend-first editor. Debate uses its selected personas and the same synthesizer routes. Inline seats show Pi's available models; CLI seats keep their own model choices. Candidate models can be probed on their prospective route before saving. (`/consult status` prints a quick read-out.)

**Outcome labels are yours to set, not the model's.** `/consult recent` lists consultation IDs on the active session branch (the last ten are shown). Mark an outcome with `/consult label <id> used yes|no|unknown helped yes|no|unknown`; either field can be set alone and `unknown` clears that field. Nothing is labeled automatically. Outcome metadata holds only ID, mode/source and your chosen labels, not question or advice text. Forking to another branch hides labels that aren't on that branch. Tool results carry their IDs in details; phrase, automatic, and file-sharing consultations show their IDs in the delivered advice.

**Share selected files on purpose:** `/consult share [solo|gut-check|council|debate]` asks for an optional question and exact file paths, one per line. `.diff` and `.patch` files work too; it never runs Git or discovers files for you. In a trusted project with interactive/RPC UI, it reads only those regular UTF-8 files inside the project (up to five, 32 KiB each, 96 KiB total), shows path/size and a short preview, names the configured recipients, then asks before sending full buffered contents. Sharing currently requires inline routes for *every* seat: CLI tools can read other files, so they cannot uphold selected-file consent. No approval, no advisor call. Files must fit the advisor window *verbatim*, or the call fails instead of quietly clipping what you approved. Responses from this command are shown in a UI notification and saved as local, non-model-context session entries; `/consult result <id>` shows one again on the active branch. They aren't steered into the executor. Advisor replies may quote selected files and remain in that local session. There is no secret scanner: inspect selected files yourself. Existing transcript text may already go to the advisor during a normal consult; this consent controls new file reads, not earlier session context.

The **Council members** submenu (one entry on the main `/consult` menu) manages who's on the council. Each seated member opens a detail view:

- **Choose the backend first** — inline, codex / claude / opencode CLI, or a **Custom CLI** (any executable: command + structured args + a required context window). Each CLI seat runs as a subprocess in parallel with inline seats. A custom CLI must pass a probe before it's saved; it has to accept bpx-consult's stdin contract (markdown transcript in, text/JSONL out).
- **Choose a model for that backend.** Codex lists models through its app-server; OpenCode runs `opencode models --verbose`; Claude has no stable model-list command, so use its configured default or enter an ID/alias. Every preset allows manual entry and a no-override default. Listing isn't proof of account access: **Test with this persona first** probes the candidate on its actual route. Inline and per-CLI selections remain separate when switching backends. Custom CLI arguments remain yours; the picker never guesses a model flag for them.
- **Retest the assigned route** any time from the same detail view.
- **Enable / disable** a persona — unseating keeps its definition, so re-enabling restores its model
- **Add manually** — type a name, pick a stance (for/against/neutral), pick a model
- **Add AI-generated** — describe the advisor's focus, pick a model to draft it, confirm the `{name, stance, system prompt}` it returns, and seat it
- **Synthesizer route** — backend and model used to merge Council verdicts and close Debate

The default roster seats architect/critic/simplifier on distinct model tiers so parallel calls don't all hammer one provider. CLI routing is persona-scoped — two seats on the same model can route differently (one inline, one CLI). Advanced settings (context-budget char caps, per-backend timeouts) still live in the config file.

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

Consults don't have to be manual. Two auto-triggers plus phrase triggers:

- **whenStuck:N** — **off by default (N = 0).** Set it to a positive number in `/consult` to arm it. Once armed, it fires after N consecutive tool errors *or* N identical tool calls (loop detection via an un-truncated `toolName:input` fingerprint), runs a solo advisor, and steers you out. Off out of the box so the safety net never spends advisor tokens unless you ask it to — the model decides when to consult, nudged by the tool guidelines.
- **onDone** — **off by default.** When on, it fires when the agent finishes a turn and reviews the work before it stops.

Auto-triggers always run **solo**, regardless of your default mode. An auto-fire is a safety net, not a deliberate consultation. A council burning 3+ model calls every time you hit a loop would be a surprise-quota footgun. If you want a council, call it explicitly.

Triggers never fire in untrusted projects.

### Phrase triggers

You can also fire a consult by just typing a phrase — no tool call, no slash command:

| Say something like… | Runs |
|---|---|
| "ask the council", "use the council", "council on this", "convene the council", "run the council" | **council** |
| "ask the advisor", "second opinion", "get advice" | **solo** |
| "debate this", "have them debate", "start a debate" | **debate** |
| "gut check this", "gut-check" | **gut-check** |

Matching is case-insensitive and word-boundaried. Add "about …" to focus it — "ask the council about the retry strategy" passes *the retry strategy* as the question. Phrase triggers only fire on your own interactive input in a trusted, enabled project, and they honor your `feedbackMode` (below). Because they're user-initiated, they're **not** subject to the per-turn consult cap.

One deliberate non-trigger: a bare "the council" won't fire — it needs a verb ("ask/use/consult/run the council") or the "council on this" shape. Otherwise a passing mention ("what did the council say?") would spend real money on a council you didn't ask for.

---

## How advice reaches the executor

Advice comes back differently depending on who asked for it. `feedbackMode` (default **steer**) controls only the paths where bpx-consult injects on your behalf.

- **The model's own `consult()` tool call** → always a normal tool result. It asked for the advice, so it always gets it back inline. `feedbackMode` does not apply here — there's nothing to route.
- **Phrase triggers and manual standalone runs** → honor `feedbackMode`:
  - **steer** — injects the advice as a steering message mid-run; the executor sees it and continues without you leaving the flow.
  - **pipe** — injects it as a user message (queued as a follow-up), so the executor treats it as your input.
  - **show** — local UI notification, saved outside model context and retrievable with `/consult result <id>`. The executor doesn't receive it. That local entry contains the full reply (which may quote your session), unlike the small outcome-label metadata. A phrase trigger also **suppresses the agent run**. Without interactive/RPC UI, it consumes the request without making an advisor or executor call; the session records why no display was possible. Older show messages are filtered from future executor/advisor requests, but previously generated summaries may still quote them.
- **Auto-triggers (whenStuck / onDone)** → fixed delivery, independent of `feedbackMode`: whenStuck **steers** (so it doesn't interrupt), onDone queues a **followUp**.

**Per-mode override.** `feedbackMode` can be set per mode as well as globally, and the per-mode value wins. So you can keep the top-level default at `steer` but set `modes.council.feedbackMode` to `show` — now "ask the council" gives you a read you act on yourself, while "second opinion" (solo) still steers. Any mode without its own `feedbackMode` inherits the top-level one, which falls back to `steer`.

```jsonc
{
  "feedbackMode": "steer",              // default for every mode
  "modes": {
    "council": { "feedbackMode": "show" }  // …but council results are UI-only
  }
}
```

---

## Backends

Solo, gut-check, Council members, Debate roles, and the shared synthesizer can each use an inline model or CLI route. Set `backend` and `cliModels` on that seat in `/consult` or config; keep `model` (or persona `defaultModel`) for its inline choice. The legacy `backends.<model>` map and persona `codexModel` still load. Presets run `codex exec`, `claude -p` (tools disabled), or `opencode run --format json` (dedicated agent with tool-deny settings; not a sandbox). Custom CLIs need a declared `contextWindow` and own their argv; no model flag is appended to custom args. OpenCode model discovery reads `limit.context`/`limit.input` from `opencode models --verbose`; a manual ID or CLI default needs a declared window rather than an invented fallback. Every CLI gets its fitted transcript on stdin. Without a selected CLI model, the CLI's configured default runs.

Inline advisor calls made through the model's `consult()` tool report their provider usage to Pi's `/cost` totals on Pi 0.87.1. This includes retries, failed replies, every Council member, and Debate rounds. CLI routes don't report comparable usage, so mixed consultations count only the known inline calls. Phrase, automatic and `/consult share` consultations run outside a tool result; Pi's extension API doesn't currently provide a supported way to add their usage to `/cost`. They still spend tokens. If a timed-out provider reports usage only after the consult has returned, that late usage cannot be added to its finished tool result either. Older Pi versions may ignore the tool-result usage field.

---

## Resilience

Two things that would silently bite, both handled.

Each council member runs under its own `AbortController` linked to the parent signal, so one member timing out or erroring drops only that member. The rest proceed and the synthesizer works with whoever replied. A flaky member never crashes the council.

Wall-clock timeouts cover the hang case across all modes. Council (`council.timeoutMs`, default 120s), debate (`debate.timeoutMs`, default 180s), and CLI (`timeoutMs` per backend) all have explicit budgets. A provider that accepts-then-hangs settles as a clean failure instead of hanging the executor turn.

What v1 does *not* have: per-member circuit-breaker with exponential backoff. Isolation plus timeouts is the resilience story today. Smarter retry is on the v1.1 list.

---

## Config

`~/.pi/agent/bpx-consult.json` (global) or `.pi/bpx-consult.json` (project-local, trusted projects only). Project overrides global at the leaf level. `/consult` edits the global file; edit project-local overrides in `.pi/bpx-consult.json` directly.

```jsonc
{
  "enabled": true,
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
  "triggers": { "onDone": false, "whenStuck": 0 },
  "feedbackMode": "steer",
  "maxConsultsPerTurn": 3,
  "disabledForModels": [],
  "contextBudget": { "responseReserveTokens": 4096 }
}
```

**`enabled`** (default `true`) is the master switch. Set it `false` to turn the whole extension off without uninstalling — the `consult` tool and triggers go dormant.

**`maxConsultsPerTurn`** (default `3`, `0` = unlimited) is a soft cap on how many times *the model itself* may call `consult()` in a single turn. Hit the cap and the next call returns a cheap "cap reached" note instead of spending another advisor call — the model proceeds on its own judgment or you raise the cap in `/consult`. It counts only the model's own tool calls; phrase triggers and auto-triggers have their own guards and are never blocked by it. The counter resets each turn and on your next input.

**`disabledForModels`** (default `[]`) turns consult off for specific *executor* models. Two shapes: a bare model key disables it outright (`"openai/gpt-5"`), or an object gates on effort — `{ "model": "anthropic/claude-opus-4-6", "minEffort": "high" }` keeps consult available only when that model is thinking at `high` or above, and off below it (so a cheap low-effort turn doesn't drag in an advisor). When disabled, `consult()` returns a short "disabled for this model" note instead of running.

The defaults are pinned to specific model versions, which means they'll drift as Anthropic ships new ones. The registry supports tier aliases in some places; where it does, prefer an alias. Otherwise expect to update these periodically, or override `personas.*.defaultModel` with whatever you actually have authed.

---

## Roadmap

Where this is heading. The package is pre-1.0, so these are milestone groupings, not version promises.

**Before 1.0**

- **Smarter retry.** Resilience today is per-member isolation plus wall-clock timeouts. Per-member circuit-breaker with exponential backoff is the next layer for flaky providers.

**After 1.0**

- **Research-backed council.** Council today argues from stances and the session transcript, or from files you explicitly share through `/consult share`. The next layer would let advisors search for evidence, weigh specific concerns (security, performance, cost), and work with diagrams or images. That automatic research is not part of file sharing today.
- **Memory compression and branched-session handoff.** For very long sessions and dedicated per-persona advisor forks.

The full design (including the decisions behind each of these) is in [SPEC.md on GitHub](https://github.com/gabelul/bpx-mono/blob/main/packages/bpx-consult/SPEC.md).

---

## Prerequisites

- pi 0.80+ (uses the `@earendil-works/pi-ai/compat` `completeSimple` entry, event handlers, `sendUserMessage`)
- Node 22.19+ — pi's own packages require it, so this does too.
- For inline seats, a provider authed via `/login`. CLI-only seats do not need a matching Pi registry model. The default roster uses Anthropic inline; change its routes if those aren't authed.
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
