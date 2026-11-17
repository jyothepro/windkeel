# ADR-0005: The monorepo split lands with the control plane, not before

- Status: Accepted
- Date: 2026-08-14

## Context

Plan §22 sketches a target monorepo (`apps/`, `packages/`) and says "migrate incrementally", without saying when incrementally starts.

## Decision

**The repository stays a single package until the control plane lands. The first control-plane code is the trigger: npm workspaces arrive with it, and the first split is `packages/verification`.**

- §1 — No workspace split before Milestone 1 code: Until the trigger, §22's boundaries are enforced as directory discipline inside `src/` — new factory-domain code goes in its own top-level `src/` directories (e.g. `src/domain/`), never entangled with the engine.
- §2 — The trigger is the first deployable that is not the CLI/Action: — per ADR-0002, the ingress app or the worker container, whichever lands first.
- §3 — The first split is `packages/verification`: today's engine surface (`src/engine/`, `src/evidence/`, `src/exec/`, `src/attest/` and what they depend on) moves out of the root as a workspace package that keeps the zero-runtime-dependency property — enforced by its own `package.json`.
- §4 — What stays put: the CLI and the GitHub Action remain in the root package, `npm run build` keeps producing `dist/cli.js` where the end-to-end tests and the Action's `dist` distribution expect it.
- §5 — Everything else in §22: (`packages/agents/*`, `models/*`, `sandboxes/*`, `integrations/*`, …) splits out only when a second consumer or a deployable needs the boundary — the same rule applied repeatedly, not a scheduled migration.

## Consequences

- Milestone 1 domain-model work starts immediately with no restructuring gate in front of it.
- The split happens exactly once, for a reason, with the dependency direction it must enforce already known: `apps/*` → `packages/verification`, never the reverse.
- The zero-dependency engine keeps its property by construction after the split (its own manifest), instead of by vigilance in a shared one.
- Cost accepted: the split lands mid-route (M1–M2) rather than in a quiet moment; the mitigations are the small codebase and the directory discipline in (1), which makes the eventual `git mv` mostly mechanical.

**Later changes** (full text in Background):

- Amendment, 2026-09-24 — §4 is superseded: the CLI leaves the root package

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-14
- Resolves: [#58 — Decide the monorepo migration strategy](https://github.com/jyothepro/orqon/issues/58) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §22 sketches a target monorepo (`apps/`, `packages/`) and says "migrate incrementally", without saying when incrementally starts. Reality on `main` today: a single package, `src/` compiled to `dist/`, **zero runtime dependencies**, Node >= 20 ESM, tests that drive `dist/cli.js` end-to-end, and a GitHub Action distributed as the committed `dist/`. That combination is a working contract worth protecting; a workspace split has real churn cost against it and — while there is only one deployable — zero payoff.

The payoff appears the moment a second deployable exists. ADR-0002 schedules exactly that: a Vercel ingress app and a worker container, each with runtime dependencies (`@vercel/sandbox`, an orchestration backing, a Postgres client) that must never leak into the zero-dependency verification engine or the Action's `dist`.

Options considered: split now before Milestone 1 (cheapest mechanically, but pure churn until the second deployable exists), split when the control plane lands (the trigger is already scheduled and the boundary it forces is the one worth enforcing), or wait until it hurts (with the control plane arriving at M1–M2, the pain is already visible — deferring past the trigger means doing the split mid-milestone).

### Decision

**The repository stays a single package until the control plane lands. The first control-plane code is the trigger: npm workspaces arrive with it, and the first split is `packages/verification`.**

Concretely:

1. **No workspace split before Milestone 1 code.** Until the trigger, §22's boundaries are enforced as directory discipline inside `src/` — new factory-domain code goes in its own top-level `src/` directories (e.g. `src/domain/`), never entangled with the engine.
2. **The trigger is the first deployable that is not the CLI/Action** — per ADR-0002, the ingress app or the worker container, whichever lands first. That commit-series adopts npm workspaces.
3. **The first split is `packages/verification`**: today's engine surface (`src/engine/`, `src/evidence/`, `src/exec/`, `src/attest/` and what they depend on) moves out of the root as a workspace package that keeps the zero-runtime-dependency property — enforced by its own `package.json`. The control plane apps (`apps/`) depend on it; it depends on nothing.
4. **What stays put:** the CLI and the GitHub Action remain in the root package, `npm run build` keeps producing `dist/cli.js` where the end-to-end tests and the Action's `dist` distribution expect it. The test contract — tests drive `dist/cli.js` — is preserved across the split; a split that breaks it is wrong by definition.
5. **Everything else in §22** (`packages/agents/*`, `models/*`, `sandboxes/*`, `integrations/*`, …) splits out only when a second consumer or a deployable needs the boundary — the same rule applied repeatedly, not a scheduled migration.

### Consequences

- Milestone 1 domain-model work starts immediately with no restructuring gate in front of it.
- The split happens exactly once, for a reason, with the dependency direction it must enforce already known: `apps/*` → `packages/verification`, never the reverse.
- The zero-dependency engine keeps its property by construction after the split (its own manifest), instead of by vigilance in a shared one.
- Cost accepted: the split lands mid-route (M1–M2) rather than in a quiet moment; the mitigations are the small codebase and the directory discipline in (1), which makes the eventual `git mv` mostly mechanical.
- The GitHub Action's committed-`dist` distribution and the e2e test contract are explicitly protected invariants; any workspace tooling that breaks either is disqualified.

### Amendment, 2026-09-24 — §4 is superseded: the CLI leaves the root package

§4 said the CLI and the GitHub Action stay in the root package, that `npm run build` keeps
producing `dist/cli.js`, and that **"a split that breaks it is wrong by definition."** That is
now done anyway, and the reason is worth recording rather than quietly reversing.

**§4's premise was that the root package *is* the CLI.** On 2026-07-26, when `bin: { windkeel }` was
declared, that was exactly true: the repository was a verification engine and a command line over
it, so publishing the root published the product, and moving the CLI out would have split a thing
that had no seam in it.

Then the factory grew inside the same manifest. `pg` (2026-08-25), `@aws-sdk/client-s3`
(2026-08-26), `@vercel/sandbox` (2026-08-29), `workflow` (2026-09-16) — each added by a commit that
genuinely needed it, none wrong in isolation. But `bin` and `dependencies` live in one file, and
npm resolves a dependency tree from the manifest you install rather than from the imports your code
reaches. So `npm i -g windkeel` came to mean **264 MB across 495 packages**, including TypeScript
5.6.3 and a 26 MB `@swc/core` binary, pulled in by the Workflow SDK's TypeScript plugin — paid by
every contributor running `windkeel verify` against a checkout, which opens no socket at all.

Nobody noticed because nobody installs it: this repository is always used from a checkout
(`npm run windkeel`, `node dist/cli.js`). The same shape as the object store before
[#276](https://github.com/jyothepro/orqon/issues/276) — an unexercised path does not report its own
breakage.

**So the split that §4 called wrong by definition is the one that makes the package installable.**
Concretely:

1. **`packages/cli` takes the name `windkeel`** and the `bin`, and declares exactly one dependency:
   `@windkeel/verification`, which itself declares none. The published tarball is 48 kB.
2. **The root becomes `@windkeel/factory`, `private: true`**, and keeps every driver. It is never
   published, so what it declares costs nobody an install.
3. **The operator commands move with the drivers**, under a second, unpublished binary
   `windkeel-admin`: `metrics`, `doctor`, `reap`, `task`, `run report`, `run capture`. They need a
   *direct* Postgres connection (ADR-0008 §1), which is not a thing a published CLI should want.
   [ADR-0023](0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md)
   §10 puts them on the API eventually; until then an operator runs them from the checkout they are
   already deploying from.
4. **`npm run build` now produces `packages/cli/dist/cli.js`**, and `action.yml` was updated in the
   same commit. §4's real concern — the Action must not reference a path the build does not produce
   — is now enforced by a test that checks *both halves against each other*, which the old one
   could not: it asserted the file existed and trusted `action.yml` to agree.
5. **§5 is unchanged and was followed.** "Everything else splits out only when a second consumer or
   a deployable needs the boundary." A publishable artifact is that second consumer. This is §5
   applied, not an exception to it.

**What makes this durable rather than a thing to rediscover.** The reason §4 held for two months
after it stopped being true is that nothing checked it. `test/published-cli-weight.test.js` now
asserts the published package's dependency closure contains no driver, so the next milestone that
needs a new SDK — ADR-0008 §2 already names Cloudflare R2 as one — cannot quietly add it to the
thing users install.

**Reversal condition.** If the operator commands move onto the API (ADR-0023 §10) and
`@windkeel/factory` stops being a thing anyone runs directly, the second binary disappears and this
becomes a two-package repository plus deployables. Nothing here prevents that; it is the next step,
not a contradiction.
