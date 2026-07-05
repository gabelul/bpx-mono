# bpx-mono

Booplex pi extensions — a monorepo of [pi](https://pi.dev) coding-agent extensions. Each package is independently installable; the mono just keeps them under one repo and one release pipeline.

## Packages

### [@booplex/bpx-consult](packages/bpx-consult/) — a council of AI advisors for pi

One advisor when you want speed, several debating when the call actually matters. Four modes — solo, council, debate, gut-check — plus a context engine that fits the conversation to the advisor model's actual window (the bug that made me build this in the first place). Built to replace rpiv-advisor after it kept dying with "context window exceeded" mid-session.

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
