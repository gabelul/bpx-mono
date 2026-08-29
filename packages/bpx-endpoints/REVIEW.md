# bpx-endpoints — code review & improvement plan

Review date: 2026-08-16. Scope: packages/bpx-endpoints (post consult-style config redesign). Every claim below was verified against the current source and, where it touches pi behavior, against pi-ai 0.80.x / pi-coding-agent source in node_modules.

Status: all five bugs and the full improvement track below are **implemented** (see CHANGELOG + README). This document keeps the original findings for reference.

---

## Bugs worth fixing first

### 1. Export leaks secrets in custom headers

`maskEffectiveConfig()` in src/command.ts masks only `provider.apiKey`. The config layer also carries secrets in:

- `provider.headers` (X-API-Key, custom Authorization, etc.)
- `provider.models[].headers`
- `provider.modelOverrides[*].headers`

`/endpoints export` writes these unmasked to disk or the read-only overlay. Fix: recursive redaction over the whole models config — mask literal values under keys like `apiKey`, `authorization`, `token`, `secret`, and every value inside a `headers` object; keep `$ENV` and `!command` references intact via the existing `maskSecret()`.

### 2. Settings editor can overwrite a malformed config

src/settings.ts `runEndpointsSettings()`:

```ts
let config = (await loadManagedConfig(paths)).value ?? { version: 1, profiles: {} };
```

When `bpx-endpoints.json` is malformed, `loadManagedConfig` returns `error` (no value), so this falls back to defaults, and the first save then **writes defaults over the malformed file** — destroying the recovery data that `/endpoints doctor` is supposed to protect. Fix: when `loaded.error` is set, refuse to open the editor and point the user at `/endpoints doctor`. Only fall back to defaults when `loaded.missing === true` (preferably via `ensureManagedConfig(paths)`).

### 3. Test messages can hang forever, and test the wrong model

src/test-message.ts `confirmAndTestProfileModel()`:

- Passes no `signal`/`AbortSignal` to `streamSimple`. A hung endpoint hangs the busy UI until the process dies; the overlay's "esc cancel" can't abort because `EndpointManagerOperations.sendTestMessage(profileId, modelId)` takes no signal.
- Passes no `maxTokens` cap.
- `buildTestModel()` reconstructs the model from cache candidates, **ignoring `models.custom.json` and managed `modelOverrides`**. It can report success for a model configuration that pi is not actually using. The right source of truth is the effective registered model: `ctx.modelRegistry.find(profileId, modelId)`.
- Reports success when the stream ends with no usable response (empty reply is fine; zero events is not).
- Doesn't distinguish cancellation from timeout.

Fix together: add `signal` to `sendTestMessage`, combine overlay signal with `AbortSignal.timeout(30_000)`, pass `signal` + small `maxTokens` to `streamSimple`, test the registered model, only report success on a usable stream, classify the failure (cancelled vs timed out vs error).

### 4. No way to test a specific model

- List-view `t` tests only `cached.models[0]`.
- `ModelManagerOverlay` (src/tui.ts) has keys for source selection, policy, field edits — but no test key at all.

For a profile with 50 discovered models you can never test #23 from the UI. Fix: add a `test` action (e.g. `ctrl+t`) to `ModelManagerOverlay`, routing the selected model id through the overlay session.

### 5. Refresh reports success even when everything failed

`refreshCommand()` ends with `Refreshed N Endpoint(s).` even when every profile's discovery threw (issues are notified separately, then the unconditional success line lands on top). Fix: report counts — `2 succeeded, 1 failed; previous cache retained for failures`.

---

## Endpoint testing — the ways to test

Current state: discovery-only check in the form (`ctrl+t` tests `/models` fetch), and a single "Say OK" streaming test message. That's a decent floor; here's the ladder:

1. **Discovery probe** (free) — already exists; keep it separate from message tests since it makes no paid calls.
2. **Per-model streaming test** — the `ModelManagerOverlay` test key from bug #4, with signal/maxTokens/timeout from #3.
3. **`/endpoints test [profile] [model]`** — non-interactive single test for scripting.
4. **`/endpoints test --all`** — batch health check across enabled profiles. Batch message tests need **one confirmation** (they're paid API calls); keep the free discovery-only variant as a separate verb (e.g. `/endpoints check`).
5. **Health history** — persist `lastTestAt`, `lastTestMs`, `failureCount` per profile in cache.json; surface in `/endpoints status`, the list view, and doctor ("never tested", "last test failed 2h ago"). Turns "did it work once" into "is it healthy now".
6. **Effective-model fidelity** — the test must run the exact model pi would run (bug #3). This is the single most valuable correctness fix: a test that passes while pi fails is worse than no test.

Note: `completeSimple` from pi-ai compat is NOT a non-streaming fallback — it just consumes `streamSimple` to completion. The streaming route is what pi actually uses, so keep testing streaming and don't advertise a `stream:false` path.

---

## Auto-discovery

The core loop is `GET {baseUrl}/{modelsPath}` → parse `data[]` / `models[]` / bare array → build parameter candidates. Good bones; three upgrades:

### 6. Full discovery URL override

`joinUrl()` just concatenates baseUrl + modelsPath. This breaks the common Ollama/llama.cpp layout: chat base URL is `http://host:11434/v1` but model discovery lives at origin-root `/api/tags`. Concatenation produces `/v1/api/tags`. Fix: add optional `discovery.modelsUrl` (full URL, wins outright), keep `modelsPath` for backward compat, document the precedence.

### 7. Opt-in path probing

When the configured URL returns 404, an unsupported shape, or an empty list, probe candidates in order:

- configured URL first
- `{base}/models`
- `{origin}/v1/models`
- `{origin}/api/tags`
- `{origin}/api/models`

Rules: only probe on 404 / shape-miss / empty — never on 401/403 (auth is the problem, not the path). Cache the resolved URL back into the profile (or cache.json) so subsequent refreshes don't repeat the guessing game. Make it a profile-level toggle (`discovery.probe: true`) rather than always-on, since probing makes extra network requests.

### 8. Richer response parsing

`parseEndpointModels()` handles `data[]`, `models[]`, and bare arrays. Missing: `{ data: { models: [...] } }` nesting, object-keyed maps (`{ "gpt-4": {...} }`), duplicate id dedup, and explicit empty-response handling (currently `[]` parses to zero models with no warning). Add these before touching the probing logic and cover them with tests.

### 9. Local models.dev cache

`fetchModelsDevCatalog()` hits `https://models.dev/api.json` (a large JSON) on **every refresh and every profile save**. One network hiccup degrades the whole flow. Fix: cache the catalog under the state dir with `fetchedAt`, 24h TTL, and stale-on-error fallback — refresh then works offline and doesn't depend on a remote for routine operations.

### 10. Bounded retries

Discovery and models.dev fetch have zero retry. Add bounded retry (1–2 attempts) only for network errors, 429, and 5xx; honor `Retry-After` when present. Never retry 4xx auth errors.

---

## Correctness notes (verified, lower priority)

- **KNOWN_APIS as adapters is intentional** — pi-ai ships those built-ins, so `api_unresolved` firing is the right signal for a typo'd protocol. Leave it.
- **Auth header precedence**: pi's model-registry builds `headers = { ...model.headers, ...providerHeaders, ...modelHeaders }` then applies `Authorization: Bearer` last when `authHeader` is true. A custom `Authorization` header in the profile loses to the generated bearer. Don't change the auth plumbing; add a **doctor warning** when a profile configures both `apiKey` and a custom `Authorization` header so the user knows which one wins.
- **Headers already support `$ENV` and `!command`** through `resolveProfileHeaders()`/`discoveryHeaders()`. The only string without interpolation is `baseUrl` — add `resolveApiKey`-style expansion there if you want it.
- **Custom per-profile `streamSimple` protocols: defer.** `registerProvider` supports it, but JSON config can't carry a function, so it means loading executable modules — a real trust/security surface with little payoff for the target user. Note it in the roadmap, don't build it.

---

## Test coverage to add before more discovery work

Only `config.test.ts` and `classify-hints.test.ts` exist; the discovery/registration core has none. Add:

- `parseEndpointModels()` — all response variants, object-keyed, nested `data.models`, duplicate ids, empty.
- Discovery URL joining/probing and auth-failure paths (never-probe-on-401/403).
- `confirmAndTestProfileModel()` — timeout, cancellation, zero-content stream is not success, effective-model selection.
- `buildParameterCandidates()` ranking (exact > normalized > fuzzy, pi-built-in > models.dev).
- `generateModelsConfig()` — policy includeOnly/exclude, overrides, unsourced/fuzzy issue emission.
- `mergeModelsConfig()` + the new recursive secret redaction from bug #1.

---

## Suggested order

1. Bug fixes #1, #2 (small, security/data-loss).
2. Test engine: #3 + #4 (hang, wrong-model, no per-model test).
3. Discovery: #6 modelsUrl, then #8 parsing with tests, then #7 probing.
4. models.dev cache (#9), retries (#10), health history (#5/5.5).
5. `/endpoints test` CLI + `--all` batch.
