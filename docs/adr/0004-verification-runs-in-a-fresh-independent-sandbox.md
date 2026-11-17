# ADR-0004: Verification runs in a fresh independent sandbox and trusts only the candidate git commits

- Status: Accepted; amended by ADR-0017, ADR-0031
- Date: 2026-08-14

## Context

Plan §13 draws the trust boundary — maker above, verifier below — and calls independent verification Windkeel's strongest differentiated subsystem, but does not say where the verifier physically runs.

## Decision

**Every `VerificationRun` executes in its own freshly created sandbox, physically separate from the maker's. The verifier trusts exactly one thing from the maker: the content of the candidate git commits. Everything else it re-establishes itself.**

- §1 — Placement: The control plane (the factory service, per ADR-0002 in the worker container) creates a new verifier sandbox for each `VerificationRun` — never reusing, forking, or snapshot-restoring the maker's sandbox.
- §2 — What the verifier trusts: the git commits and nothing else: The committed tree at `candidate_sha` *is* the artifact under review — trusting its content is not a concession, it is the job.
- §3 — Credential separation enforces the boundary physically: Checker credentials — the reviewer/checker model keys, the verifier's git credentials — are injected only into the verifier sandbox, or kept out of sandboxes entirely via the provider's egress credential brokering.
- §4 — The evidence package stays out of both sandboxes' control.

## Consequences

- The Milestone 2 `SandboxProvider` must serve two roles per run — maker and verifier workspaces (`Workspace.role`, ADR-0003) — and the sandbox-backed `ExecutionEnvironment` is built once and reused for every verification.
- Each repair cycle costs one additional sandbox creation and a cold dependency install (cache-able later via provider snapshots of a *pre-maker* base image — caching is legitimate exactly when the cached state predates any maker involvement).
- The candidate must reach the verifier through git (pushed branch or bundle fetched from the maker workspace by the control plane) — the diff-shaped alternative of copying files across is illegal by construction.
- The independence claim in Windkeel's product story becomes checkable infrastructure: separate VM, separate credentials, separate network policy, clean clone — auditable per run from `Workspace` rows.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-14
- Resolves: [#57 — Decide verification placement and independence topology](https://github.com/jyothepro/orqon/issues/57) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §13 draws the trust boundary — maker above, verifier below — and calls independent verification Windkeel's strongest differentiated subsystem, but does not say where the verifier physically runs. Three placements were on the table:

1. **Reuse the maker's sandbox** after the worker exits (or fork its snapshot). Cheapest and fastest — but the verifier then inherits the maker's filesystem: poisoned `node_modules`, git hooks, a tampered test runner or `PATH`, a doctored toolchain. A maker that can shape the verifier's environment can manufacture a pass, which hollows out the boundary §13 exists to enforce. The [Vercel Sandbox findings](../../research/vercel-sandbox/findings.md) add a mechanical problem: `snapshot()` is terminal — it stops the VM — so "verify in the same session" and "fork the snapshot" are both really "inherit the maker's disk".
2. **Run verification in the control plane.** Verification executes untrusted repository code — tests, builds, browser flows — which must not run un-sandboxed beside Windkeel's credentials and database (§19: one isolated sandbox per execution context).
3. **A fresh independent sandbox per verification.** The engine on `main` was built for exactly this seam: `VerificationRequest.execEnv` is an `ExecutionEnvironment` (`src/exec/environment.ts`), and a sandbox-backed implementation is the expected Milestone 2 shape.

Cost of the fresh sandbox is not a deciding factor: ~$0.05–0.14 per 20-minute verification pass at realistic utilization.

### Decision

**Every `VerificationRun` executes in its own freshly created sandbox, physically separate from the maker's. The verifier trusts exactly one thing from the maker: the content of the candidate git commits. Everything else it re-establishes itself.**

Concretely:

1. **Placement.** The control plane (the factory service, per ADR-0002 in the worker container) creates a new verifier sandbox for each `VerificationRun` — never reusing, forking, or snapshot-restoring the maker's sandbox. The verifier sandbox clones the repository from the git remote at `base_sha` and fetches the candidate commits (`candidate_sha`); it takes no filesystem state from the maker's environment.
2. **What the verifier trusts: the git commits and nothing else.** The committed tree at `candidate_sha` *is* the artifact under review — trusting its content is not a concession, it is the job. Untracked files, installed dependencies, build outputs, environment variables, shell configuration, and git hooks from the maker's sandbox are all untrusted and never transferred. The verifier re-installs dependencies from the committed lockfiles, re-builds, and re-runs everything from the clean clone.
3. **Credential separation enforces the boundary physically.** Checker credentials — the reviewer/checker model keys, the verifier's git credentials — are injected only into the verifier sandbox, or kept out of sandboxes entirely via the provider's egress credential brokering. The maker sandbox never holds them, so a maker cannot impersonate its own checker. Maker and verifier sandboxes get independent network policies.
4. **The evidence package stays out of both sandboxes' control.** As `src/exec/environment.ts` already states: the package the engine writes is the verifier's own product, produced host-side by the engine — the maker has no path to it, and the verifier sandbox is only the place where commands run.

### Consequences

- The Milestone 2 `SandboxProvider` must serve two roles per run — maker and verifier workspaces (`Workspace.role`, ADR-0003) — and the sandbox-backed `ExecutionEnvironment` is built once and reused for every verification.
- Each repair cycle costs one additional sandbox creation and a cold dependency install (cache-able later via provider snapshots of a *pre-maker* base image — caching is legitimate exactly when the cached state predates any maker involvement). *Amended by [ADR-0031](0031-environment-snapshots-are-pre-maker-and-default-branch-only.md): that cache exists — snapshots built only on the default branch in a setup sandbox no maker ran in, restored only under a checkout that descends from them, behind `WINDKEEL_ENVIRONMENT_SNAPSHOTS` and `WINDKEEL_SNAPSHOT_FOR_VERIFIER`.*
- The candidate must reach the verifier through git (pushed branch or bundle fetched from the maker workspace by the control plane) — the diff-shaped alternative of copying files across is illegal by construction.
- The independence claim in Windkeel's product story becomes checkable infrastructure: separate VM, separate credentials, separate network policy, clean clone — auditable per run from `Workspace` rows.
- Verification latency includes sandbox boot + clone + install; §20 cost accounting should attribute maker and verifier sandbox costs separately (both hang off the `EngineeringRun`).
