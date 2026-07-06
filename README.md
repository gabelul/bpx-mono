<p align="center">
  <img src="https://raw.githubusercontent.com/gabelul/bpx-mono/main/.github/assets/hero.png" alt="Booplex pi extensions — a shelf of small handmade tools and little robot gadgets on a tinkerer's pegboard" width="100%">
</p>

# bpx-mono — Booplex pi extensions

Small, sharp extensions for [pi](https://pi.dev), the minimal terminal coding harness. The idea across all of them: pi stays lean and does the work; these add the bits I kept wishing it had. Each package is its own independently-installable extension — the monorepo just keeps them under one roof, one CI, and one release pipeline.

## Packages

### [@booplex/bpx-consult](packages/bpx-consult/) — a council of AI advisors for pi

Run a cheap, fast model as your working agent and keep a stronger, pricier one on the bench to steer it: a solo second opinion, a full council, or two models debating the hard calls. Senior judgment on tap, paid for only when it counts. Four modes (solo, council, debate, gut-check), auto-triggers for when the agent gets stuck, and a context engine that re-fits every consult to the advisor model's own window so it never dies mid-session. Grew out of an earlier advisor extension that kept overflowing its window — that fix was the seed, the council is where it went.

Install:

```bash
pi install npm:@booplex/bpx-consult
```

Full docs, modes, config, and the roadmap live in the [package README](packages/bpx-consult/README.md). The [SPEC](packages/bpx-consult/SPEC.md) has the design rationale.

## Release flow

Releases run through GitHub Actions via [release-please](https://github.com/googleapis/release-please) + OIDC trusted publishing to npm. Conventional commits (`feat:`, `fix:`) on main open a Release PR; merging it tags and publishes automatically. No tokens, no 2FA per release.

## Repo layout

```
bpx-mono/
  packages/
    bpx-consult/     # @booplex/bpx-consult (npm)
  .github/workflows/ # ci.yml + release.yml
  release-please-config.json
```

---

Built by Gabi @ [Booplex.com](https://booplex.com). MIT license.
