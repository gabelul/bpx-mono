# bpx-consult — handoff to fresh session

> Start here. This is the full state at the natural stopping point after council
> validation. Pick up at **triggers** (step 5 of 7). No re-discovery needed.

## Project

`gabelul/bpx-mono` — Booplex pi extensions monorepo (npm workspaces). First
package: `@gabelul/bpx-consult` at `packages/bpx-consult/`. A council of AI
advisors for pi; replaces rpiv-advisor and fixes its context-window blowout.

- **Repo**: https://github.com/gabelul/bpx-mono (public)
- **SPEC**: `packages/bpx-consult/SPEC.md` (revised, grounded against actual
  source — read §R reuse map before writing anything new)
- **Local source**: `/Volumes/MyEXT/Projects/Others/PI/bpx-mono/`
- **Persona**: load `/Users/gabel/Desktop/my_persona_v3.md` first, every task.
  Global directive already in `~/.pi/agent/AGENTS.md` + project AGENTS.md.
  Run slopbuster on anything Gabi signs his name to.

## Validation table (all ✅, live-tested in pi 0.80.2 / tmux)

| Mechanism | Status |
|---|---|
| Extension loads, tool/command register | ✅ |
| Solo end-to-end (real model reply via completeSimple) | ✅ |
| Config layer + project-local (.pi/, trusted) + trust gating | ✅ |
| Council parallel fan-out (Promise.allSettled) | ✅ |
| Per-member AbortController isolation (rpiv-btw "Decision 8") | ✅ held under 2-of-3 failure |
| Resilience (member fails → rest proceed, pre-failed collected) | ✅ |
| Min-window fit (§I — council fits to smallest member window) | ✅ wired + unit-tested (council-fit.test.ts) |
| Confidence formula (0.4·success + 0.35·agreement + 0.25·alignment) | ✅ ran on real for/against |
| Stance validation + disagreement surfacing on genuine dissent | ✅ |
| Triggers — onDone + whenStuck (loop + error), solo-only by design (§T) | ✅ error trigger fired live, no deadlock, no cascade |
| Debate — round threading, per-round §C re-fit, genuine clash → verdict | ✅ synthesis quoted round-1 substance, decisive verdict |

**NOT done**: debate wall-clock timeout (folded into CLI session — last unprotected path), CLI backend.

**Live test setup**: `pi install -l <pkg path>` in `/tmp/bpx-test` (scoped
local, NOT global — global would load in Gabi's 4 live `omx-*` sessions). Start
pi in tmux: `pi --model google/gemini-2.5-flash --thinking low`. **Auth state at
handoff**: only Google works (flash + pro under cap). Anthropic OAuth token
expired (401), deepseek key invalid (401), minimax 401, zai 429 (no balance),
openrouter out of credits. Re-probe before relying on a provider.

## §I min-window decision (don't relitigate)

Council resolves every member model UPFRONT, takes
`min(synth.window, ...memberWindows)`, fits the shared context to that smallest
window. Every member sees the same payload and the smallest-window member is
guaranteed to fit. §I ("always fits, no exceptions") holds. Wired in
`src/council.ts`; unit-tested in `tests/council-fit.test.ts` (32k + 8k
mismatches).

## Rate-limit finding + fix (shipped, don't relitigate)

Same-provider parallel members trip QPM rate limits and silently die. Live test
killed 2-of-3 (two flash members + flash executor = three concurrent google
calls). **Fix already shipped** (commit be09a74):
- `DEFAULT_CONFIG.personas` now spreads Anthropic tiers: architect/opus,
  critic/sonnet, simplifier/haiku. Members must NOT all share one tier, and
  shouldn't reuse `modes.solo.model` (that's the executor's tier).
- `warnOnProviderCollision()` in council.ts — non-blocking warning naming the
  colliding provider + members. Warns, doesn't force-stagger (paid tiers can
  handle it; user knows their limits).

For live tests with limited auth: use `parallel: false` (sequential) to dodge
the issue entirely while proving logic.

## Remaining steps + order

1. **CLI backend + debate.timeoutMs (combined — same timeout primitive, same headspace)** — async pi.exec (NOT execSync), codex/claude/opencode backends, AND a debate wall-clock timeout. **This is the only remaining step.** Most independent (subprocess plumbing, no completeSimple/consensus touch) — ideal cold-pickup.

Why combined: debate is currently the only path without timeout protection (council has per-member, CLI will have resolveShellTimeoutMs). consult() is executor-callable, so "user can Ctrl-C" doesn't cover an autonomous debate that hangs mid-round — no human, no escape, executor turn blocked. Fold debate.timeoutMs into the CLI session rather than v1.1.

**Debate timeout**: Promise.race / timer firing the abort controller that already propagates. Small. `config.modes.debate.timeoutMs` (suggest default 180000 = 3min for up to 4 rounds + synth).

### CLI backend — pi API facts (do NOT re-fetch docs)
- Async only: `pi.exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>` — NEVER `execSync` (blocks event loop, serializes a Promise.all council).
- `ExecResult` has `killed: boolean` for clean timeout detection.
- Reuse `resolveShellTimeoutMs` (tolerant frontmatter→ms, `0` = disable) + the `res.killed` pattern from `research/rpiv-mono/packages/rpiv-args/args.ts`.
- CLI commands (per pi-external-advisor): `codex exec --sandbox read-only --skip-git-repo-check -`, `claude -p`, `opencode exec --sandbox read-only --skip-git-repo-check -`. Read prompt from stdin.
- Output parse: JSONL (codex/opencode — parse `type: "item.completed"`, extract `.item.text`) OR plain text (claude). See `research/pi-external-advisor/index.ts`.

### CLI smoke test — engineer to trip these branches
1. **timeout fires** — tiny `timeoutMs` → `res.killed` → clean error result, not hang (this is the reason it's async).
2. **defensive parse** — feed junk-preamble-then-JSON, must not crash (real CLIs print warnings/deprecation notices before the payload).
3. **CLI missing/non-zero exit** — graceful "unavailable" result, not crash.
4. **§C fit before stdin pipe** — a 32k codex advisor still needs the window refit; pipe the fitted context, not raw.
5. **THE one that justifies execSync→pi.exec**: mixed inline+cli council in parallel — one completeSimple member + one pi.exec member, both return, parallel holds. A solo CLI call doesn't prove the decision.

## Past steps (for context — these are DONE, don't redo)

Solo, council, config, context engine, triggers, debate — all built and live-validated. Triggers dispatch solo-only by design (§T). Debate reuses council's stance-injection + challenge.py framing. See git log for the commit history.

The discipline that caught every bug: **engineer smoke tests to trip the mocked/risky branches, never happy paths.** Seven+ integration bugs caught across solo/council/triggers validation, all invisible to unit tests.

## pi API facts already nailed down (do NOT re-fetch docs)

**completeSimple** (inline backend, used by solo/council/debate): `pi-advisor/index.ts:324`
is the canonical call — passes `sessionId` for prefix caching + `maxTokens`. Import
from `@earendil-works/pi-ai/compat` subpath (moved off main entry in 0.80.x).
Council uses per-member `AbortController` linked to parent signal (`linkSignal`
in council.ts, now exported for debate reuse), NOT shared ctx.signal.

**Triggers** (DONE — `src/triggers.ts`, shipped): `pi.on("agent_end")` for onDone,
`pi.on("tool_result", {toolName, input, isError})` for whenStuck fingerprint
`` `${toolName}:${JSON.stringify(input)}` `` un-truncated. Reset on
`before_agent_start`. Two traps handled: route injection through
`pi.sendUserMessage({deliverAs})` (never session-control from a handler —
deadlocks); skip `toolName === "consult"` so a triggered consult doesn't re-trip.
Auto-triggers run **solo-only by design** (§T). All live-validated.

**CLI backend** (the remaining work): see "Remaining steps" above for pi.exec +
resolveShellTimeoutMs + ExecResult.killed + the parse/exit/parallel branches.

## Reference files (lift, don't write)

| Need | Source |
|---|---|
| Loop-detect fingerprint + autoReviewedThisRound | `research/pi-extensions/packages/pi-advisor/advisor.ts` |
| Async CLI via pi.exec + resolveShellTimeoutMs + res.killed | `research/rpiv-mono/packages/rpiv-args/args.ts` |
| Feedback injection + resolveAdviseMode + trust gating | `research/pi-extensions/packages/pi-advisor/advisor.ts` |
| completeSimple call shape | `research/pi-advisor/index.ts:324` |
| Persona archetypes (validator personas) | `research/.../my-zen/systemprompts/planner_validators.py` (external: /Volumes/MyEXT/Projects/Others/MCP/my-zen) |
| Stance prompts + confidence formula + circuit breaker | `.../my-zen/tools/consensus.py` |

All `research/...` paths resolve under `/Volumes/MyEXT/Projects/Others/PI/Advisor/research/`.

## Discipline that worked (keep doing this)

**Engineer every smoke test to trip the risky/mocked branches — never a happy
path.** Failure injection (bogus model), mixed windows (32k vs 200k), genuine
for/against dissent. Every engineered run caught a real bug that unit tests
mocked away:
- solo review → token estimate, clampSurvivor round-trip, loop bound (3 bugs)
- council run 1 → project-local config never loaded, one bad model killed council (2 bugs)
- council run 2 → rate-limit defect (defaults fix shipped)

Happy paths validated nothing that was mocked. Keep injecting failure.

## Quick orientation commands for the fresh session

```bash
cd /Volumes/MyEXT/Projects/Others/PI/bpx-mono
git log --oneline -12          # see the commit history
cat packages/bpx-consult/SPEC.md | head -60   # §G/§P/§M
npx tsc --noEmit -p packages/bpx-consult/tsconfig.json   # must stay clean
cd packages/bpx-consult && npx vitest run      # 69 tests, must stay green
```

Test config pattern (scoped local, never global):
```bash
mkdir -p /tmp/bpx-test/.pi
echo '{ "defaultMode":"council", ... }' > /tmp/bpx-test/.pi/bpx-consult.json
cd /tmp/bpx-test && pi install -l /Volumes/MyEXT/Projects/Others/PI/bpx-mono/packages/bpx-consult
# After source changes: pi uninstall -l <path> && pi install -l <path> to refresh
tmux new-session -d -s bpx-test -c /tmp/bpx-test
tmux send-keys -t bpx-test "pi --model google/gemini-2.5-flash --thinking low" Enter
```
