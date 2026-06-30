# bpx-consult — SPEC

> A council of AI advisors for pi. Consult one model or run a full multi-model consensus before you commit to a direction. Replaces rpiv-advisor and fixes the context-window blowout.

---

## §G — Goal

Give the executor model (and the human) a way to pause mid-coding-session and ask other AI models for a read before committing to a plan, a fix, or a direction. One model for speed, several in parallel for real decisions, two arguing it out for controversial calls.

The non-negotiable: it must **never blow the context window**, no matter how long the session runs. That is the bug we're fixing first.

## §P — Problem with the status quo

rpiv-advisor forwards the **entire session history** to the advisor model with zero truncation (`buildSessionContext()` → full branch, no caps). In a long coding session this trivially exceeds the advisor model's window and the call fails. So the advisor dies exactly when you need it most.

Secondary gaps in everything I looked at:
- No multi-model / council mode anywhere in pi-land (only my-zen does it, as an MCP).
- No forced counterargument / debate pattern.
- Auto-triggers (onDone, loop detection) only exist in pi-extensions/advisor.
- Feedback can only come back as a tool result — no mid-run steering.

## §M — Modes

`consult()` accepts `mode`. When the executor calls it with no args, **solo** runs.

### solo
One advisor model, one response. The rpiv-advisor experience but with the context engine. Fast, cheap, default. The model and thinking level come from config (`soloModel`, `soloThinkingLevel`).

### council
N models run **in parallel** (`Promise.all`, my-zen's gather pattern), each with a persona and a stance. A synthesizer model merges the verdicts into one recommendation with a confidence score. For real decisions — architecture, "should I even do this", tricky bugs.

If members strongly disagree, surface the disagreement. No fake consensus.

### debate
Sequential and adversarial. Advocate proposes → critic attacks → advocate rebuts. Two rounds max by default, configurable. For controversial calls where you want the strongest case on both sides before you decide.

### gut-check
One cheap fast model, terse output, low token budget. "Does this smell off?" Used before you do something you're 90% sure about but want a sanity check. Configurable `gutCheckModel` (default a flash-tier model).

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

Char caps and window size are configurable under `contextBudget`.

## §V — Personas

Bundled defaults, all overridable in config. Each persona is `{ name, systemPrompt, defaultModel?, stance, thinkingLevel? }`. Stance is `for | against | neutral` — injected into the system prompt (my-zen pattern).

| persona | stance | job |
|---|---|---|
| `architect` | for | design soundness, lead-engineer view |
| `devils-advocate` | against | forced critique, finds the holes |
| `simplifier` | neutral | questions complexity, asks if it's needed |
| `qa` | neutral | edge cases, failure modes |
| `security` | neutral | security implications |
| `performance` | neutral | perf implications |
| `paranoid` | against | worst-case scenarios |

Council default roster: `architect`, `devils-advocate`, `simplifier`. User can override the roster and every persona field in config.

## §B — Backends

Each persona/advisor can target one of:

- **inline** — pi-ai `completeSimple()` with `provider/model` from the registry. Session-affine prefix caching. Default.
- **cli** — pipe curated context (as markdown) via stdin to an external CLI: `codex`, `claude`, or `opencode`. Parse JSONL (codex/opencode) or plain text (claude) output. Timeout-protected.

Mapped per-persona under `backends`. A council can mix inline and cli members freely.

## §T — Triggers

- **manual** — executor calls `consult()`, or you type `/consult`. Always available.
- **onDone** — auto-consult after `agent_end`. Off by default (configurable). Project-trust-gated: no silent auto-triggers in untrusted repos.
- **whenStuck:N** — auto-consult after N consecutive tool errors **or** N identical tool calls (loop detection via tool-name + args fingerprint). Default N = 3.

Triggers respect a per-session "already consulted this round" flag so they don't fire repeatedly.

## §F — Feedback injection

How the advisor's response reaches the executor:

- **show** — UI-only (`ctx.ui.notify`). You read it, executor never sees it.
- **pipe** — injected as a user message.
- **steer** — injected as a steering message mid-run. The killer feature for unblocking yourself without leaving the flow.

Default `steer`. Configurable per-mode.

## §X — Config

`~/.pi/agent/bpx-consult.json`:

```json
{
  "defaultMode": "solo",
  "soloModel": "anthropic/claude-sonnet-4-5",
  "soloThinkingLevel": "high",
  "council": {
    "members": ["architect", "devils-advocate", "simplifier"],
    "synthesizer": "anthropic/claude-sonnet-4-5",
    "parallel": true
  },
  "gutCheckModel": "google/gemini-2.5-flash",
  "debate": { "rounds": 2 },
  "personas": {},
  "backends": {},
  "triggers": { "onDone": false, "whenStuck": 3 },
  "feedbackMode": "steer",
  "contextBudget": {
    "userChars": 2800,
    "assistantChars": 1800,
    "toolArgChars": 800,
    "toolResultChars": 2000,
    "keepFirst": 2,
    "keepLast": 12
  },
  "disabledForModels": []
}
```

Precedence: env > project (`.pi/`) > global (`~/.pi/agent/`). Trust-aware.

## §S — Slash commands & tool

**Tool** (callable by the executor):
- `consult({ mode?, persona?, question? })` — all args optional. No args → solo.

**Slash commands** (for you):
- `/consult` — interactive picker: mode, model, effort level (the rpiv-advisor picker, kept).
- `/consult solo|council|debate|gut-check [provider/model]` — set mode (and optionally model).
- `/consult on|off` — enable/disable the whole thing.
- `/consult status` — show current mode, models, trigger state.
- `/consult config` — open config for editing.

## §O — Out of scope for v1

- MCP delegation backend (a council seat calling my-zen's `consensus` tool). v2.
- Memory compression (caveman-style) for very long sessions. v2.
- Branched session handoff (pi-mimir `createBranchedSession` pattern). v2.
- Debate mode may land as v1.1 if the sequential flow proves fiddly.

## §I — Invariants

- The advisor call **always** fits the target model's context window. No exceptions.
- The in-flight `consult()` call is always stripped before forwarding context.
- Triggers never fire in untrusted projects.
- Triggers never fire twice in the same round.
- Persona system prompts always include the stance.
- Config is always valid against the schema before it's applied.
