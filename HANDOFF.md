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

1. **triggers** — onDone (agent_end) + whenStuck:N (loop/error detection).
   Self-contained, independent of the call path. **Do this first.**
2. **debate** — sequential advocate/critic/rebut. Extends call path.
3. **CLI backend** — async pi.exec (NOT execSync), codex/claude/opencode.
   Extends call path.

Why this order: triggers is the only remaining step that doesn't touch the
validated completeSimple call path. Do it on a fresh session (this one is long).
Debate and CLI build on proven ground.

## pi API facts already nailed down (do NOT re-fetch docs)

**Triggers (step 5)**:
- `pi.on("agent_end", { messages })` → fires onDone.
- `pi.on("tool_call", { toolName, toolCallId, input })` → build the whenStuck
  fingerprint as `` `${toolName}:${JSON.stringify(input)}` `` **un-truncated**
  (pi-extensions CHANGELOG: they removed a 120-char cap that broke detection).
- `pi.on("tool_result", { isError })` → consecutive-error count.
- Reset point: `pi.on("before_agent_start", ...)` — clear `autoReviewedThisRound`
  + loop counters + `lastFingerprint` here (per-prompt reset).

**Two gotchas (both will bite if missed)**:
1. **Never call session-control methods from event handlers — pi docs say they
   deadlock.** Route the triggered consult via
   `pi.sendUserMessage(text, { deliverAs: "steer" })`.
2. **`consult()` is a tool, so it fires its own `tool_call` event.** Exclude it
   from the whenStuck fingerprint (skip when `toolName === "consult"`), or a
   triggered consult re-trips the loop detector.

**completeSimple canonical call**: `pi-advisor/index.ts:324` (the reference —
passes `sessionId` for prefix caching + `maxTokens`). Import from
`@earendil-works/pi-ai/compat` subpath (moved off main entry in 0.80.x). Council
uses per-member `AbortController` linked to parent signal, NOT shared ctx.signal.

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
