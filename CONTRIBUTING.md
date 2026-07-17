# Contributing to bpx-mono

Thanks for wanting to poke at this. Booplex pi extensions is a small, opinionated set of tools, and I'm happy to have help — bug reports, fixes, whole new extensions, all welcome. Here's how it fits together so you don't have to reverse-engineer it.

## Ground rules

- **Conventional commit titles.** `feat:`, `fix:`, `docs:`, `chore:` — they're not decoration, they drive the release pipeline (below). A PR titled "updated stuff" makes the robot sad and me grumpy.
- **Each extension owns its own tests and docs.** Work happens in `packages/<name>/`. Start there, keep it self-contained.
- **Read the extension's SPEC before you change behaviour.** e.g. [`packages/bpx-consult/SPEC.md`](packages/bpx-consult/SPEC.md) has the design rationale and the invariants that aren't allowed to break — the window-fit guarantee especially.
- **This is a pi extension repo.** Check [pi's docs](https://pi.dev/docs/latest) before assuming how pi's API works. It moves, and guessing burns time.

## Repo layout

```
bpx-mono/
  packages/
    bpx-consult/       # @booplex/bpx-consult — the advisor
  .github/workflows/   # ci.yml + release.yml
  release-please-config.json
```

Each package under `packages/` is an independently-published npm extension. The monorepo shares CI and the release pipeline; nothing else is coupled — an extension shouldn't reach into a sibling.

## Running tests

Each package uses [vitest](https://vitest.dev):

```bash
cd packages/bpx-consult
pnpm test        # or: vitest run
```

Keep `tsc` clean and the tests green before you open a PR. If you touched a context-fitting or window path, prove the §I invariant still holds — every advisor call has to fit its target model's window.

## How releases work

You don't cut releases by hand, and neither do I — [release-please](https://github.com/googleapis/release-please) does it off your commit messages. Conventional commits on `main` accumulate into a Release PR; when that PR is merged, the version is tagged and published to npm with signed provenance over OIDC. No long-lived tokens, no per-release 2FA dance.

Which is exactly why the commit titles matter: `feat:` bumps a minor, `fix:` bumps a patch, and "updated stuff" bumps nothing and helps no one.

### Keeping docs honest (the part that bites)

The package README and SPEC drift most often not from *forgetting* to update them, but from updating the **feature bullet** and missing a sibling section that repeats the old claim (this has shipped contradictions more than once). Before you declare a capability change done:

1. **Grep every `.md` for the OLD claim, not just the section you edited.** If you changed something from "config-file-only" to "menu-reachable," search the whole repo for "config-file-only" — there's likely a second mention.
2. **`cd packages/bpx-consult && pnpm test` must stay green.** Two CI guards fail the build on doc problems: `tests/docs-stale.test.ts` (no known-stale phrases like `config-file-only`, `solo only`, `32k fallback`, dead `whats-not-in-v1` anchors) and `tests/docs-voice.test.ts` (no banned AI-slop tells like `delve`, `leverage`, `robust`, `let's dive`). Both are living lists — add phrases/tells as capabilities and voice rules evolve.
3. **The root `README.md` stays evergreen on purpose** — high-level only, no feature specifics, no version-pegged claims. Don't add feature detail there; it belongs in the package README. Evergreen is what keeps the root from drifting release-to-release.

The discipline goal is mechanical, not memory-based: a checklist I can ignore, a failing CI test I can't.

## Questions

Open an issue, or find me at [Booplex.com](https://booplex.com).
