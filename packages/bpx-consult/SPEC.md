# bpx-consult — SPEC

> A council of AI advisors for pi. Consult one model or run a full multi-model consensus before you commit to a direction. Replaces rpiv-advisor and fixes the context-window blowout.

---

## §G — Goal

Give the executor model (and the human) a way to pause mid-coding-session and ask other AI models for a read before committing to a plan, a fix, or a direction. One model for speed, several in parallel for real decisions, two arguing it out for controversial calls.

The non-negotiable: it must **never blow the context window**, no matter how long the session runs. That is the bug we're fixing first.

## §P — Problem with the status quo

`@juicesharp/rpiv-advisor` curates context through `buildSessionContext()`, which preserves Pi's **already-compacted** LLM context (compaction summaries + branch summaries), then strips the in-flight `advisor()` call and guarantees a user-tail (`advisor/context.ts`, `advisor/execute.ts:100-112`). What it does **not** do is re-fit that context to the *advisor's* window. The advisor model can be smaller than the executor — point a flash-tier or `codex`/`claude` CLI advisor (32k–64k) at a session the executor compacted to 128k and the advisor call exceeds *its* window and fails. The advisor dies exactly when the session is long enough to need it.

So the bug is not "no truncation" — it is **no truncation relative to the advisor's own context window**. The fix (§C) re-fits Pi's compacted context to whatever window *this* advisor has.

> **Repro-first:** before building §C, reproduce the overflow — run current rpiv-advisor with a small-window advisor model against a long session and confirm the failure. If it does not reproduce, the diagnosis is still off and the engine is premature.

Secondary gaps across what I surveyed:
- No multi-model / council mode in pi-land (only my-zen does it, as an MCP).
- No forced counterargument / debate pattern.
- Auto-triggers (`onDone`, `whenStuck` loop detection) live only in `pi-extensions/advisor`.
- A CLI-backed advisor exists (`pi-external-advisor`) but via **blocking `execSync()`** — unusable for a parallel council without going async (§B fixes this with `pi.exec`).
- Feedback can only return as a tool result — no mid-run steering.

## §M — Modes

`consult()` accepts `mode`. When the executor calls it with no args, **solo** runs.

### solo
One advisor model, one response. The rpiv-advisor experience but with the context engine. Fast, cheap, default. Model and thinking level come from config (`modes.solo.model`, `modes.solo.thinkingLevel`).

### council
N models run **in parallel** (`Promise.all`, my-zen's `asyncio.gather` pattern), each with a persona and a stance. A synthesizer model merges the verdicts into one recommendation with a confidence score. For real decisions — architecture, "should I even do this", tricky bugs.

Two mechanics lifted from my-zen's `tools/consensus.py` give "no fake consensus" actual teeth:
- **Stance validation** — after each member replies, check it actually held its assigned stance (keyword/alignment scan, `consensus.py:774-871`). A member told to argue `against` that returns mush gets flagged, not counted as agreement.
- **Confidence score** — `0.4·success_ratio + 0.35·agreement_ratio + 0.25·avg_alignment` (`consensus.py:978-1032`). Surfaced with the synthesis so you can see how solid the consensus is.

If members strongly disagree, surface the disagreement. Never manufacture agreement.

Resilience (also from `consensus.py:873-976`): per-member **circuit breaker** (skip a backend after repeated failures instead of cascading retries) + bounded exponential backoff with jitter. One flaky advisor never hangs the council; `Promise.allSettled` semantics, failed members drop to a fallback verdict.

### debate
Sequential and adversarial. Advocate proposes → critic attacks → advocate rebuts. Two rounds max by default, configurable. The attack step reuses my-zen's `challenge.py` wrapper — wrap the prior position in a "critically reassess, do not reflexively agree" frame so the critic genuinely stress-tests rather than rubber-stamps. For controversial calls where you want the strongest case on both sides before you decide.

### gut-check
One cheap fast model, terse output, low token budget. "Does this smell off?" Used before you do something you're 90% sure about but want a sanity check. Configured at `modes.gutCheck` (default a flash-tier model, `terse: true`).

## §C — Context engine (the fix)

This is the core. Layered, borrows the best of pi-advisor + pi-extensions/advisor.

**Input**: `ctx.sessionManager` entries for the active branch.

**Pipeline**:
1. **Strip in-flight call** — remove the `consult()` toolCall currently in flight so we don't orphan it.
2. **Extract** — user messages, assistant text + thinking blocks, tool calls (name + args), tool results.
3. **Stage detection** — `exploring` (early, mostly reads/searches) / `stuck` (repeated failures or loops) / `done` (agent_end, verification commands run). Drives the directive.
4. **Signal extraction** — recent file mutations, repeated failure signatures, verification commands run, last ~8 tool calls summarized.
5. **Per-message char caps** — user ~2800, assistant text ~1800, tool args ~800, tool results ~2000. Over-cap content gets a `[omitted]` marker, not a silent drop.
6. **Sliding window** — keep first 2 + last N messages; when still over budget, drop oldest-first.
7. **Reserve** — always reserve tokens for the advisor's response so it can reply.
8. **Assemble** — curated `Message[]`, with a final context message carrying stage + directive + signals.

**Output**: a `Message[]` that fits the target advisor model's window. Guaranteed.

**Most of this is fork, not write.** The pieces already exist:
- Steps 1–2 (strip + extract): `rpiv-advisor/advisor/context.ts` (`stripInflightAdvisorCall`, `ensureUserTailForAdvisor`) + `convertToLlm` / `buildSessionContext`.
- Step 3–4 (stage + signals): `pi-advisor/src/advisor-signals.ts` (`detectStage`, `buildExecutorSignals`, `isVerificationCommand`). Heuristic, so this is where bugs hide — but it's forkable, not greenfield.
- Step 5–6 (caps + window): `pi-advisor/src/advisor-messages.ts` (`clampText`, `summarizeUserContent`, the first-2 + last-N transcript compaction with an `[N earlier messages omitted]` marker). The char-cap constants in step 5 are lifted straight from there.

**Window-fit does not depend on steps 3–4.** Strip → cap → window → reserve (1, 2, 5, 6, 7) alone satisfy the invariant. Stage/signal detection improves the *directive*, not the *fit* — ship the guaranteed-fit core first, then layer the heuristics.

**Step 7 is the load-bearing one.** `maxContextTokens` is **not** a config constant — it is read per-call from the advisor model's window via `ctx.modelRegistry`, minus `contextBudget.responseReserveTokens`. That is what makes the §P fix per-advisor rather than global.

Char caps, window size, and the response reserve are configurable under `contextBudget`.

## §V — Personas

Bundled defaults, all overridable in config. Each persona is `{ name, systemPrompt, stance, defaultModel?, thinkingLevel? }`. Stance is `for | against | neutral` — injected into the system prompt (my-zen pattern). Every persona carries its own model + effort, so a council can run `architect`-on-opus + `critic`-on-codex + `tester`-on-flash.

| persona | stance | conditional? | job |
|---|---|---|---|
| `architect` | for | no | design soundness, lead-engineer view |
| `critic` | against | no | forced critique, finds the holes |
| `simplifier` | neutral | no | questions complexity, "do we even need this" |
| `pragmatist` | neutral | no | effort vs. payoff, "ship the cheap version" — counterweight to architect |
| `tester` | neutral | no | edge cases, failure modes |
| `security` | neutral | **yes** | security implications — only seated when the call touches it |
| `performance` | neutral | **yes** | perf implications — conditional, same rule |

Council default roster: `architect`, `critic`, `simplifier`. User can override the roster and every persona field in config.

Changes from the first draft: renamed `devils-advocate`→`critic` and `qa`→`tester` (shorter keys, less ambiguity); **dropped `paranoid`** (it was `critic` with worse-case framing — fold that into critic's prompt as an intensity dial, don't give it a seat); **added `pragmatist`** (the draft roster was all idealist-or-critic, nobody argued ROI — this maps to my-zen's `business_analyst` validator in `systemprompts/planner_validators.py`); marked `security`/`performance` **conditional** (domain seats, not general advisors — otherwise someone gets a security review on a CSS refactor). The remaining five mirror my-zen's validator personas almost 1:1, which is reassuring corroboration.

**Stance wording invariant:** stance biases what a persona hunts for and how hard it stress-tests — **never the verdict**. A `for` persona must still be able to land on "don't do this." A persona structurally incapable of dissent is theater (my-zen's known failure mode). my-zen's stance prompts (`consensus.py:677-772`) bake in this guardrail explicitly ("avoid purely contrarian", "avoid artificial balance") — reuse that framing.

## §B — Backends

Each persona/advisor can target one of:

- **inline** — pi-ai `completeSimple()` with `provider/model` from the registry. Session-affine prefix caching. Default.
- **cli** — pipe curated context (as markdown) via stdin to an external CLI: `codex`, `claude`, or `opencode`. Parse JSONL (codex/opencode) or plain text (claude) output. **Run via async `pi.exec(cmd, args, { timeout })`, not `execSync`** — `execSync` blocks the event loop, so a single CLI member would serialize an entire `Promise.all` council. `rpiv-args/args.ts` already has the pattern: `resolveShellTimeoutMs` (tolerant frontmatter→ms, `0` = disable) + `pi.exec` returning `res.killed` for a clean "[timed out after Ns]" result. Reuse it.

Mapped per-persona under `backends`. A council can mix inline and cli members freely — and because the CLI path is async, parallelism holds across mixed backends.

## §T — Triggers

- **manual** — executor calls `consult()`, or you type `/consult`. Always available.
- **onDone** — auto-consult after `agent_end`. Off by default (configurable). Project-trust-gated: no silent auto-triggers in untrusted repos.
- **whenStuck:N** — auto-consult after N consecutive tool errors **or** N identical tool calls. Default N = 3, `0` = off. Lift the loop detector from `pi-extensions/advisor/advisor.ts`: fingerprint = `` `${toolName}:${JSON.stringify(input)}` `` (do **not** truncate it — their CHANGELOG records removing an arbitrary 120-char cap that broke detection), bump `loopCount` on repeat, reset `lastFingerprint`/`loopCount`/`stuckErrors` on user input (`source` = `interactive`/`rpc`).

Triggers respect a per-session `autoReviewedThisRound` flag (same name as pi-extensions) so they don't fire repeatedly within one round.

**Auto-triggers always run solo, regardless of `defaultMode`.** An auto-fire is a safety net, not a deliberate consultation — a council would burn 3+ model calls + synthesis per trigger, a surprise-quota footgun on a loop or repeated errors. Council is reserved for explicit invocation (`mode: "council"` on the tool, or `/consult council`).

## §F — Feedback injection

How the advisor's response reaches the executor:

- **show** — UI-only (`ctx.ui.notify`). You read it, executor never sees it.
- **pipe** — injected as a user message: `pi.sendUserMessage(text, { deliverAs: "followUp" })`.
- **steer** — injected as a steering message mid-run: `pi.sendUserMessage(text, { deliverAs: "steer" })`. The killer feature for unblocking yourself without leaving the flow.

The API and the auto-resolve logic already exist in `pi-extensions/advisor` (`resolveAdviseMode`): default to `steer` when the agent is active, `pipe` when idle, `show` only when explicit. Reuse it, including its re-entrancy guard so an auto-trigger can't recurse into itself.

Default `steer`. The global default lives at `feedbackMode`; per-mode override under `modes.*.feedbackMode` (§X).

## §X — Config

`~/.pi/agent/bpx-consult.json`. Loaded and validated via `@juicesharp/rpiv-config` (`loadJsonConfig`, `saveJsonConfig`, `validateConfig` over a TypeBox schema) — don't hand-roll config I/O. Model strings use rpiv's `modelKey` codec, which is tolerant of both `provider/model` (canonical) and `provider:model` (legacy) and auto-migrates on save.

```jsonc
{
  "defaultMode": "solo",

  // Every mode carries its own model + thinkingLevel, set via slash command and
  // persisted — same modelKey codec + effort as @juicesharp/rpiv-advisor.
  "modes": {
    "solo":     { "model": "anthropic/claude-sonnet-4-6", "thinkingLevel": "high" },
    "gutCheck": { "model": "google/gemini-2.5-flash", "thinkingLevel": "low", "terse": true },
    "council": {
      "members": ["architect", "critic", "simplifier"],
      "synthesizer": { "model": "anthropic/claude-sonnet-4-6", "thinkingLevel": "high", "systemPrompt": null },
      "parallel": true
    },
    "debate": { "advocate": "architect", "critic": "critic", "rounds": 2 }
  },

  // Per-persona overrides. Each may set its own model/effort.
  "personas": {
    // "architect": { "defaultModel": "anthropic/claude-opus-4-8", "thinkingLevel": "high" }
  },

  // Per-persona/advisor backend. inline = pi-ai completeSimple; cli = async pi.exec.
  "backends": {
    // "architect": { "type": "inline" },
    // "critic":    { "type": "cli", "command": "codex", "timeoutMs": 60000 }
  },

  "triggers": { "onDone": false, "whenStuck": 3 },   // whenStuck: 0 = off
  "feedbackMode": "steer",                            // global default; override per-mode at modes.*.feedbackMode

  "contextBudget": {
    "userChars": 2800,
    "assistantChars": 1800,
    "toolArgChars": 800,
    "toolResultChars": 2000,
    "keepFirst": 2,
    "keepLast": 12,
    "responseReserveTokens": 4096   // reserved for the advisor's reply (§C step 7)
    // maxContextTokens is NOT here — read per-call from the advisor model's
    // window via ctx.modelRegistry, minus responseReserveTokens.
  },

  // Inherited from rpiv-advisor: executor models for which consult is suppressed,
  // optionally gated to a minimum effort. Entry = string | { model, minEffort? }.
  "disabledForModels": []
}
```

Model strings shown are *defaults* — the registry's resolved default wins, and `sonnet-4-6` will drift, so prefer a tier alias over a pinned version where the registry supports one.

Precedence: env > project (`.pi/`, only if trusted) > global (`~/.pi/agent/`) > built-in defaults. Reuse `pi-extensions/advisor`'s `resolveEffectiveConfig` + `contextProjectTrusted(ctx)` (calls `ctx.isProjectTrusted()`, defaults true) and per-field non-blocking validation (warn, don't throw).

## §S — Slash commands & tool

**Tool** (callable by the executor):
- `consult({ mode?, persona?, question? })` — all args optional. No args → solo.

**Slash commands** (for you):
- `/consult` — interactive picker: mode, model, effort level. Reuse rpiv-advisor's `advisor-ui.ts` (`showFilterablePicker`, `selectListTheme`, `DynamicBorder`) + `fuzzy.ts` (`fuzzyScore`, `filterItems`) — the filterable model picker already exists.
- `/consult solo|council|debate|gut-check [provider/model]` — set mode (and optionally model).
- `/consult on|off` — enable/disable the whole thing.
- `/consult status` — show current mode, models, trigger state.
- `/consult config` — open config for editing.

## §O — Out of scope for v1

- MCP delegation backend (a council seat calling my-zen's `consensus` tool). v2.
- Memory compression (caveman-style) for very long sessions. v2.
- Branched session handoff — `pi-mimir`'s `SessionManager.createBranchedSession(leafId)` forks a snapshot `.jsonl` and runs a child `pi` subprocess (`--session`, `--model`, `--system-prompt`, `--tools`). Powerful for dedicated per-persona advisor sessions, but v2.
- Stage/signal detection (§C steps 3–4) is **v1.0 fast-follow, not blocking** — window-fit ships without it. Forked from `advisor-signals.ts` once the guaranteed-fit core is proven.
- Debate mode may land as v1.1 if the sequential flow proves fiddly.

(Gut-check stays in v1: once every mode has its own model, it's just a `modes` entry with a cheap model + `terse`, and `/consult gut-check` is a clearer intent than `solo --model flash --terse`.)

## §R — Reuse map (what's lifted, from where)

bpx-consult is mostly assembly. Before writing anything new, check here.

| Need | Source | Symbols |
|---|---|---|
| Config I/O + model-key codec | `@juicesharp/rpiv-config` | `loadJsonConfig`, `saveJsonConfig`, `configPath`, `parseModelKey`/`modelKey`, `validateConfig` |
| Strip in-flight call + user-tail | `rpiv-advisor/advisor/context.ts` | `stripInflightAdvisorCall`, `ensureUserTailForAdvisor` |
| Compacted session context | `pi-coding-agent` (via rpiv) | `buildSessionContext`, `convertToLlm` |
| Char caps + transcript compaction | `pi-advisor/src/advisor-messages.ts` | `clampText`, `summarizeUserContent`, first-2 + last-N omission |
| Stage + signal detection | `pi-advisor/src/advisor-signals.ts` | `detectStage`, `buildExecutorSignals`, `isVerificationCommand` |
| Loop-detect fingerprint | `pi-extensions/advisor/advisor.ts` | `${toolName}:${JSON.stringify(input)}`, `autoReviewedThisRound` |
| Steering injection | `pi-extensions/advisor` | `pi.sendUserMessage(text, { deliverAs })`, `resolveAdviseMode` |
| Trust + config precedence | `pi-extensions/advisor` | `contextProjectTrusted`, `resolveEffectiveConfig`, `validateAdvisorConfig` |
| Async CLI + timeout | `rpiv-args/args.ts` | `resolveShellTimeoutMs`, `pi.exec(..., { timeout })`, `res.killed` |
| Fuzzy picker UI | `rpiv-advisor/{fuzzy,advisor-ui}.ts` | `fuzzyScore`, `filterItems`, `showFilterablePicker`, `selectListTheme` |
| Parallel consensus + stance validation + confidence + circuit breaker | `my-zen/tools/consensus.py` | gather, stance-keyword validation, `0.4/0.35/0.25` confidence, circuit breaker + backoff |
| Debate / challenge primitive | `my-zen/tools/challenge.py` | "critically reassess, do not reflexively agree" wrapper |
| Persona archetypes | `my-zen/systemprompts/planner_validators.py` | devil-advocate, business-analyst, simplifier, lead-engineer, qa, pm |
| Tool-contract + ship-manifest tests | `rpiv-mono/packages/test-utils/contract.ts` | `assertToolContract`, `describeRegisteredTools`, `verifyShipManifest` |

## §I — Invariants

- The advisor call **always** fits the target model's context window. No exceptions. `maxContextTokens` is derived from the advisor model's window (`ctx.modelRegistry`) minus `responseReserveTokens`, never a global constant.
- The in-flight `consult()` call is always stripped before forwarding context.
- CLI backends run via async `pi.exec` (never `execSync`), so council parallelism holds even with mixed inline/cli members.
- Triggers never fire in untrusted projects.
- Triggers never fire twice in the same round (`autoReviewedThisRound`), and reset on user input.
- The loop-detection fingerprint is never truncated.
- Persona system prompts always include the stance, and the stance biases emphasis only — never forces a verdict.
- Config is always valid against the schema before it's applied; invalid fields warn and fall back, they never throw.
