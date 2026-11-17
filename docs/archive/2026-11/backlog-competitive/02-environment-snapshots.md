# Per-repository environment setup, snapshotted once and reused by maker and verifier sandboxes

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why

Devin ("machine snapshots" / repo setup) and Factory.ai ("environment setup" droids) both let a
customer set up a repository's environment **once**. After that, every session boots warm with
dependencies, services and toolchains already in place. Windkeel cold-starts every sandbox. Each run
creates a maker sandbox and then **one fresh verifier sandbox per verification cycle** (ADR-0004),
and every one of them clones and runs `npm ci` / `pip install` / `go mod download`
(`src/sandbox/dependencies.ts`) from scratch. On real repositories this is minutes of latency and
cost per cycle. Repositories that need more than a lockfile install (a Postgres service, a codegen
step, a system package, a `make bootstrap`) cannot be built at all, so the verifier reports on the
factory instead of on the candidate.

Windkeel's edge is the **independent verifier**. ADR-0029's rule is that nothing goes around
verification. This feature has to make the verifier faster **without weakening its
independence**. ADR-0004 already marks the legal path (Consequences): *"cache-able later via
provider snapshots of a **pre-maker** base image — caching is legitimate exactly when the cached
state predates any maker involvement."* This issue builds exactly that, and nothing looser.

## Background the implementer needs

### Current architecture (real paths)

- **Sandbox seam:** `src/sandbox/provider.ts`
  - `SandboxProvider { name; capabilities; create(options); attach(options) }`
  - `SandboxCreateOptions { role, repoUrl, gitRevision?, env?, timeoutMs?, gitCredentials?, operatorModelKey? }`
  - `SandboxProviderCapabilities { credentialBrokering, phasedEgress, reattachable, isolatedFilesystem }`. A capability is something a caller can *ask about* before it relies on it. Follow that pattern.
  - `SandboxRole = "maker" | "verifier"`
- **Vercel provider:** `src/sandbox/vercel.ts`. `create()` calls `Sandbox.create({ source: { type: "git", ... }, persistent: true, name, ... })` and then narrows egress with `installPhasePolicy()`. The SDK also supports `source: { type: "snapshot", snapshotId }`. `sandbox.snapshot({ expiration })` **stops the VM (terminal)**. See `research/vercel-sandbox/findings.md` lines 19–30 and 93 (snapshot storage costs $0.08/GB-month).
- **Fake provider:** `src/sandbox/fake.ts`, `FakeSandboxProvider` (ADR-0016 local mode). It executes on the host via `spawnSync` and has `isolatedFilesystem: false`. Its `SandboxCallRecord` log is what tests assert against.
- **Provisioning:** `src/factory/workspace-service.ts` → `provisionWorkspace(pool, provider, input)`. In order, it:
  1. inserts the `workspace` row
  2. mints a per-role git credential
  3. calls `provider.create`
  4. runs `scrubCloneCredentials`
  5. pins `base_sha` from `git rev-parse HEAD`
  6. runs `detectEcosystems` and narrows to `installPhasePolicy({ecosystems,…})`
  7. runs `installDependencies` (with secrets), then `installDeclaredTools` / `installScanners` (`src/sandbox/system-tools.ts`)
  8. enters the execution phase (`src/sandbox/lifecycle.ts` `runInExecutionPhase`)
- **Dependency install:** `src/sandbox/dependencies.ts`: `detectEcosystems`, `installDependencies(handle, InstallOptions)` (never throws; returns `DependencyInstall`), and `installConfigChanges(handle, base)`. The last one diffs install config (lockfiles, `.npmrc`, `packageManager`) between the trusted base and the candidate. When it finds changes, the candidate install runs **without** secrets.
- **Stage handlers:** `src/factory/workflow/handlers/provisioning.ts` (maker), `verifying.ts` (verifier; it calls `provisionWorkspace` with a fresh clone at the candidate) and `install-secrets.ts` (`installSecretsFor(deps, engineeringRunId)`, the only handler code that opens sealed secrets).
- **Repository secrets:** `migrations/0020_repository_secret.sql` and `src/factory/repository-secrets.ts`
  - `putRepositorySecret` / `listRepositorySecrets` / `deleteRepositorySecret` (ingress side; it cannot read values)
  - `resolveRepositorySecrets` (worker side; takes the private key)
  - `RESERVED_KEYS` + `KEY_SHAPE` refuse `PATH`, `NODE_OPTIONS`, `CODEX_API_KEY`, and any name prefixed `WINDKEEL_`
  - API routes in `apps/ingress/src/api/route.ts` (`/v1/repositories/:repositoryId/secrets…`)
  - Console page `apps/console/app/(console)/repositories/[id]/page.tsx`
- **Repository config:** `packages/verification/src/config.ts`. `WindkeelConfig` is read from `windkeel.config.json` (`checks`, `flows`, `tools: SystemToolSpec[]`). `loadTrustedConfig` reads config from the **trusted base revision** (`revisionSource`) so a maker cannot rewrite it. `configDrift(base, head)` reports what changed.
- **Repository entity:** `src/factory/repository-entity.ts` (ADR-0018: a repository is an entity resolved per task) and `migrations/0005_repository.sql`.
- **Workspace row:** `migrations/0001_factory_schema.sql` `workspace (role, sandbox_provider, provider_handle, base_sha, status, expires_at)`.
- **Worker config/env flags:** `src/factory/worker-config.ts`. All flags are `WINDKEEL_*`, e.g. `WINDKEEL_INSTALL_SCANNERS` (via the `boolean(env, name, default)` helper).
- **Migrations:** plain SQL in `migrations/`. The latest is `0036_run_merge_claim.sql`; the next free number is **0037**. `test/migrate.test.js` checks ordering.

### Relevant ADRs (1–2 lines each)

- **ADR-0004:** the verifier runs in a fresh sandbox and trusts only the candidate git commits. It never reuses, forks or snapshot-restores the **maker's** sandbox. Caching is legal only for state that predates any maker involvement.
- **ADR-0014:** maker assumed hostile. Keys are brokered, git tokens are scoped per role, and egress is phased (install phase open to registries, execution phase narrow). §5: repository secrets go into the install command's env only.
- **ADR-0016:** local development is hermetic by default. Everything must work against `FakeSandboxProvider` / `FakeGitHubClient` with no cloud credentials.
- **ADR-0018:** repository is an entity resolved per task. Snapshots hang off `repository.id`.
- **ADR-0020 / ADR-0021:** the control plane is Vercel end to end, and Vercel Workflow backs `WorkflowProvider`. Each stage can run in a different process, so snapshot ids must live in Postgres, not memory.
- **ADR-0029:** integrated-assistant features are allowed, but the verifier stays the gate and there is no path around verification.

### Test conventions

- Tests are `node --test` files in `test/*.test.js`. They import from `dist/` (`npm test` builds first).
- Unit tests use `FakeSandboxProvider` and fixture repos (`test/helpers.js`: `bareFixtureRepo`, `tempDir`, `TEST_POOL`, `seedFixtureRepository`).
- Postgres-backed tests skip without `DATABASE_URL` (see `test/helpers.js`).
- End-to-end loops: `test/e2e-github-loop.test.js` and `test/e2e-factory-loop.test.js` (`startFactory` from `test/factory-stack.js`, `ScriptedWorkerAdapter`, `FakeGitHubClient`, the workflow runtime helpers in `test/workflow-runtime.js`).
- Models to copy: `test/sandbox-dependencies.test.js`, `test/sandbox-network-phase.test.js`, `test/repository-secrets.test.js`, `test/verification-boundary.test.js`.
- Browser tests: `test/console-browser.js` helpers (see `test/console-models-browser.test.js`).

## Scope

**In:**
1. A declared setup section in `windkeel.config.json`: setup commands, services, and the env var names that must come from repository secrets.
2. A **setup sandbox** (a third, non-maker, non-verifier use) that clones the repository at its default-branch base SHA, runs dependency install + declared setup with repository secrets, scrubs, and is snapshotted.
3. A `environment_snapshot` table, plus a cache key and invalidation rules.
4. Maker and verifier provisioning restore from a matching snapshot when one exists, and fall back to today's cold path otherwise.
5. Detection / auto-generation of a proposed setup config (a heuristic draft, offered as a suggestion, never auto-committed).
6. API, CLI and console surface: view status, rebuild, invalidate.

**Out of scope:**
- Snapshotting the maker's sandbox mid-run or after work (illegal under ADR-0004).
- Cloudflare / other providers (M15). Only Vercel and the fake implement it.
- Docker-compose orchestration beyond running declared commands. Services are started by declared commands.
- LLM-driven setup agents (possible follow-up under 05-agent-types-playbooks).
- Billing for snapshot storage (09-billing-onboarding).

## Design

### Trust rule (the invariant every reviewer will check)

A snapshot is built **only** from:
- (a) the repository at a commit on its **default branch** (`repository.default_branch` HEAD at build time)
- (b) the setup declared in `windkeel.config.json` **at that same commit**, read via `loadTrustedConfig` / `revisionSource`, never from a candidate
- (c) repository secrets

No maker process ever runs in a setup sandbox. A snapshot never comes from a sandbox that has had role `maker`. A verifier restoring a snapshot still:
1. fetches `candidate_sha` from the git remote
2. checks it out (the working tree is the candidate's)
3. runs `installConfigChanges(handle, snapshotBaseSha)`. If install config changed, it re-runs `installDependencies` with `candidate: true` semantics (no secrets), exactly as today.
4. runs every check fresh

The evidence package records `environment.snapshotId`, `environment.snapshotKey` and `environment.mode = "snapshot" | "cold"`.

### Config (`windkeel.config.json`, new optional key)

```jsonc
{
  "setup": {
    "commands": [                       // run in order, in the install phase, cwd = checkout
      { "name": "bootstrap", "run": "make bootstrap", "timeoutSec": 900 }
    ],
    "services": [                       // started on every restore, before the execution phase
      { "name": "postgres", "start": "pg_ctl -D /var/lib/pg start", "ready": "pg_isready", "readyTimeoutSec": 60 }
    ],
    "secrets": ["NPM_TOKEN"],           // repository-secret names required; missing => setup fails loudly
    "egress": ["registry.example.com"], // extra install-phase hosts
    "cacheKeyFiles": ["scripts/bootstrap.sh"] // extra files whose content invalidates the snapshot
  }
}
```

- Extend `WindkeelConfig` in `packages/verification/src/config.ts` with `setup?: SetupSpec`. Validate with the same reject-and-record pattern as `rejectedEntries`. Command `name` must match `ENTRY_NAME`, `run` is a string run via `sh -c`, and timeouts are bounded (max 3600 s).
- `setup.secrets` names must pass `assertSecretKey` (from `repository-secrets.ts`).

### Data model: new file `migrations/0037_environment_snapshot.sql`

```sql
create table environment_snapshot (
  id                 uuid primary key default gen_random_uuid(),
  repository_id      uuid not null references repository (id) on delete cascade,
  sandbox_provider   text not null,
  cache_key          text not null,          -- sha256 hex, see below
  base_sha           text not null,          -- commit the setup sandbox was built at
  provider_snapshot_id text,                 -- null until ready
  status             text not null check (status in ('building','ready','failed','invalidated','expired')),
  detail             text,                   -- install/setup outcome summary (names only, never values)
  setup_log_ref      text,                   -- evidence-storage key for the full setup transcript
  size_bytes         bigint,
  built_by           text not null,          -- token subject / 'system'
  created_at         timestamptz not null default now(),
  ready_at           timestamptz,
  expires_at         timestamptz,
  last_used_at       timestamptz
);
create unique index environment_snapshot_ready_key_idx
  on environment_snapshot (repository_id, sandbox_provider, cache_key) where status in ('building','ready');
alter table workspace add column environment_snapshot_id uuid references environment_snapshot (id);
```

The partial unique index acts as the build lock: only one `building` row per key, so concurrent runs cannot double-build.

### Cache key (new file `src/sandbox/environment-snapshot.ts`)

`sha256` over a canonical JSON of:
- `SNAPSHOT_FORMAT_VERSION` (constant, bump to invalidate everything)
- provider name and image identifier
- the `setup` block (canonicalised)
- the blob SHAs (`git rev-parse <base>:<path>`) of every path in `INSTALL_CONFIG_PATHSPECS` (exported from `dependencies.ts`) plus `setup.cacheKeyFiles` plus `windkeel.config.json`
- the sorted `(key, updated_at)` of the repository's secrets (never values)

A change to any of these is a miss. Keying on blob SHAs rather than `base_sha` means that ordinary source commits on main do **not** invalidate.

### Interfaces

- `SandboxProviderCapabilities.snapshots: boolean`
- New optional `SandboxCreateOptions.fromSnapshot?: string`. The provider restores, then `git fetch`es and checks out `gitRevision` using the per-role credential. For Vercel this is `source: { type: "snapshot", snapshotId }` followed by a hardened fetch/checkout.
- New `SandboxHandle.snapshot?(opts: { expirationMs: number }): Promise<{ snapshotId: string; sizeBytes?: number }>`. Terminal.
- `FakeSandboxProvider`: `snapshots: true`. `snapshot()` copies the checkout dir to `<tmp>/fake-snapshots/<id>`, and `create({fromSnapshot})` copies it back. Both are recorded in `SandboxCallRecord` (`{kind:"snapshot"}`, `{kind:"create", fromSnapshot}`).
- New module `src/factory/environment-snapshots.ts`:
  - `computeSnapshotKey(...)`
  - `findReadySnapshot(pool, repositoryId, provider, key)`
  - `buildEnvironmentSnapshot(pool, provider, deps, repositoryId)`, which:
    1. claims the row
    2. provisions a setup sandbox with role `verifier` permissions (read-only git token; never the maker's model key, `operatorModelKey: false`)
    3. runs installs + `setup.commands` with secrets
    4. calls `scrubCloneCredentials` and removes any file written under `$HOME` that matches a secret value (reuse `src/sandbox/redact.ts`)
    5. calls `snapshot()`
    6. marks the row `ready`
  - `invalidateSnapshots(pool, repositoryId, reason)`
- `provisionWorkspace` gains `input.environmentSnapshot?: { id; providerSnapshotId; baseSha }`. When present it passes `fromSnapshot`, records `workspace.environment_snapshot_id`, skips `installDependencies` **only if** `installConfigChanges(handle, snapshot.baseSha)` returns `[]`, always runs `setup.services`, and still runs scanners. When `installConfigChanges` returns `null` (unknown), it falls back to a full install.

### Triggers and invalidation

- **Build:** lazily on the first run that misses (that run proceeds cold, and the build is enqueued as a separate workflow so it does not hold up the run). Also on demand via the API.
- **Invalidate:**
  - when a repository secret is put or deleted (`putRepositorySecret` / `deleteRepositorySecret` mark `invalidated`)
  - when the key changes (natural miss)
  - when `SNAPSHOT_FORMAT_VERSION` is bumped
  - on manual API call
- **Expiry:** `expires_at = ready_at + WINDKEEL_SNAPSHOT_TTL_DAYS` (default 14). A sweep under `src/factory/sweeps/` marks expired rows and deletes provider snapshots. Keep the last 2 ready rows per repository.

### Detection / auto-generation

New file `src/factory/setup-detection.ts`. `proposeSetup(handle)` inspects the checkout:
- lockfiles (already covered)
- `Makefile` targets named `bootstrap|setup|deps`
- `scripts/setup*`, `bin/setup`
- `docker-compose.yml` services (postgres/redis map to suggested service entries)
- `.tool-versions` / `.nvmrc`
- `.devcontainer/devcontainer.json` `postCreateCommand`

It returns `{ setup: SetupSpec, reasons: string[] }`. It is exposed read-only through the API and console as a **suggested `windkeel.config.json` patch**. It is never applied automatically, and it never runs commands it proposes.

### API (`apps/ingress/src/api/route.ts`, same `SECRETS`-style permission guard; reads direct, writes as intents per ADR-0023)

- `GET  /v1/repositories/:repositoryId/environment` returns the current snapshot rows (status, key, base_sha, size, ready_at, detail) and the proposed setup.
- `POST /v1/repositories/:repositoryId/environment/rebuild` (command)
- `POST /v1/repositories/:repositoryId/environment/invalidate` (command)

### CLI / console

- CLI (`packages/cli`): `windkeel env status|rebuild|invalidate --repo <owner/name>`
- Console: an "Environment" section on `apps/console/app/(console)/repositories/[id]/page.tsx` showing status, last build log link, Rebuild / Invalidate buttons, and the suggested config.
- The run page shows "warm (snapshot …)" or "cold" per workspace.

### Flags

- `WINDKEEL_ENVIRONMENT_SNAPSHOTS` (default `false` until proven live; reads via `boolean()` in `worker-config.ts`)
- `WINDKEEL_SNAPSHOT_TTL_DAYS` (default 14)
- `WINDKEEL_SNAPSHOT_FOR_VERIFIER` (default `true`; an escape hatch that lets an operator force a cold verifier)

### Security considerations

- A snapshot's disk may contain artifacts produced with secrets (e.g., a `.npmrc` written by setup). It is restored into **maker** sandboxes, which are assumed hostile. **Default: fail the build if any secret value appears in any file under the checkout or `$HOME`** (scan with the redact helper). Document that `setup.commands` must not persist credentials.
- Setup runs repository code from the default branch only. That is the ADR-0014 §5 trust level, so it is acceptable.
- A snapshot is restored for the verifier only when its `base_sha` is an ancestor of the candidate (`git merge-base --is-ancestor`). Otherwise cold.
- The provider snapshot is created from a setup sandbox whose id is never written to any `workspace` row with role `maker`. Assert this in a test.

## Implementation steps

1. Add `0037_environment_snapshot.sql`, plus repository functions in new `src/factory/environment-snapshots.ts` (insert/claim/markReady/markFailed/find/invalidate). Unit tests on Postgres.
2. Extend `WindkeelConfig` with `setup` plus validation in `packages/verification/src/config.ts`. Unit tests.
3. Add `computeSnapshotKey` (new `src/sandbox/environment-snapshot.ts`) and export `INSTALL_CONFIG_PATHSPECS` if it isn't already. Unit tests.
4. Add the `snapshots` capability, `fromSnapshot` and `snapshot()` to `provider.ts`. Implement them in `FakeSandboxProvider`. Have `VercelSandboxProvider` declare them, with the implementation behind a guard. Tests in `test/sandbox-fake.test.js` and `test/sandbox-vercel.test.js` (SDK mocked as existing tests do).
5. Add `buildEnvironmentSnapshot` with the secret-leak scan. Unit tests with the fake.
6. Wire `provisionWorkspace`: restore path, `installConfigChanges` gate, services start, `workspace.environment_snapshot_id`.
7. Wire `handlers/provisioning.ts` and `handlers/verifying.ts`: look up a ready snapshot when the flag is on, and enqueue a build on a miss (a new workflow step in `src/factory/workflow/`).
8. Invalidate on secret put/delete in `repository-secrets.ts`. Add an expiry sweep in `src/factory/sweeps/`.
9. Record environment mode, snapshot id and key in the evidence package / run report (`src/factory/run-report.ts`).
10. Add `setup-detection.ts` and `proposeSetup`.
11. Add API routes, CLI commands, and the console section.
12. Docs: update `docs/running-the-factory.md` and add ADR-0030 "Environment snapshots are pre-maker and default-branch-only", amending ADR-0004's Consequences. Note: `test/adr.test.js` validates ADR format.

Recommended PR split:
- **PR A** = steps 1–4
- **PR B** = steps 5–9 (+ ADR)
- **PR C** = steps 10–11

Each PR has its own done condition below.

## Done condition

- **PR A:**
  - migration 0037 applies cleanly on an empty DB and on one migrated to 0036
  - `WindkeelConfig.setup` parses and rejects invalid entries into `rejectedEntries`
  - the cache key is deterministic and changes for each listed input
  - `FakeSandboxProvider` can snapshot and restore
- **PR B:**
  - With `WINDKEEL_ENVIRONMENT_SNAPSHOTS=true`, the first run on a repository is cold and triggers a build. The second run's maker **and** verifier workspaces have `environment_snapshot_id` set and skip `installDependencies` (the `SandboxCallRecord` shows no install command).
  - A candidate that edits `package-lock.json` causes the verifier to re-install without secrets, even with a snapshot.
  - The verifier never restores a snapshot whose `base_sha` is not an ancestor of the candidate.
  - Putting or deleting a repository secret marks ready snapshots `invalidated`.
  - A setup that writes a secret value to disk produces a `failed` snapshot with a detail naming the secret key (not the value).
  - No snapshot is ever created from a handle with role `maker` (asserted).
  - With the flag off, behaviour is byte-identical to today: the existing suite passes unchanged.
  - The run report shows environment mode.
- **PR C:**
  - `proposeSetup` returns the expected suggestions for the fixtures
  - the API endpoints enforce permissions
  - the CLI commands work
  - the console section renders status and the buttons issue commands
- **All:** `npm test` is green, and ADR-0030 is accepted by `test/adr.test.js`.

## How to verify the done condition

```bash
cd /home/user/windkeel
docker compose up -d            # local Postgres per docker-compose.yml (ADR-0016)
export DATABASE_URL=postgres://...   # as in docs/running-the-factory.md
npm test                         # builds then runs node --test test/*.test.js
node --test test/environment-snapshots.test.js test/environment-snapshot-key.test.js \
  test/setup-config.test.js test/e2e-environment-snapshot.test.js test/sandbox-fake.test.js
```

Every listed test should report `# pass N`, `# fail 0`, and no `skip` on the Postgres-backed ones when `DATABASE_URL` is set.

Live (manual, needs a human with Vercel creds):
1. Set `WINDKEEL_ENVIRONMENT_SNAPSHOTS=true` on a deployed worker.
2. Run two tasks against a repo with a private-registry dependency.
3. Confirm in `workspace` rows that run 2 has `environment_snapshot_id` set.
4. Confirm the provisioning duration dropped (stage timing in the run report).

This depends on 01-live-proof.

## Tests required

### Unit tests

- `test/environment-snapshot-key.test.js` (new)
  - deterministic for identical inputs
  - changes on: lockfile blob change, `setup` change, a `cacheKeyFiles` content change, secret `updated_at` change, provider change, format-version bump
  - unchanged on a non-config source commit
  - secret values are never inputs (property: same key when only a value changes but `updated_at` is stubbed equal)
- `test/setup-config.test.js` (new)
  - valid setup parses
  - bad names, oversized timeouts and non-string `run` are rejected into `rejectedEntries`
  - a reserved secret name in `setup.secrets` is rejected
  - setup is read from the trusted base, and `configDrift` reports a candidate-only `setup` change without it being used
- `test/environment-snapshots.test.js` (new, Postgres)
  - claim lock: two concurrent claims leave exactly one `building` row
  - `markReady`, `findReadySnapshot`
  - invalidate on secret put/delete
  - expiry sweep keeps the last 2 rows
  - a failed build leaves no `ready` row
- `test/sandbox-fake.test.js` (extend): snapshot/restore round-trip of the files; restore then checkout of a different revision.
- `test/sandbox-vercel.test.js` (extend): `fromSnapshot` maps to `source:{type:"snapshot"}`; fetch/checkout uses hardened git; `snapshot()` passes `expiration`.
- `test/workspace-service.test.js` (extend):
  - the restore path skips install when `installConfigChanges` returns `[]`
  - it does a full install on `null`
  - it does a no-secrets install on changed config
  - services start and readiness timeout are reported, not thrown
- `test/environment-snapshot-build.test.js` (new):
  - the secret-leak scan fails the build
  - credentials are scrubbed
  - `operatorModelKey:false` and a read token are used
  - a missing required secret fails with a named reason
- `test/setup-detection.test.js` (new): fixtures for a Makefile bootstrap, docker-compose postgres, devcontainer postCreate, and an empty repo (no suggestions).
- `test/api-endpoints.test.js` / `test/api-routing.test.js` (extend): new routes, permission refusal, commands recorded as intents.
- `test/verification-boundary.test.js` (extend): no snapshot from a maker handle; the verifier refuses a non-ancestor snapshot.

### Integration / e2e

- `test/e2e-environment-snapshot.test.js` (new). Model it on `test/e2e-github-loop.test.js` (`startFactory`, `FakeGitHubClient`, `FakeSandboxProvider`, `ScriptedWorkerAdapter`, `seedFixtureRepository`):
  1. run 1 is cold and the build completes
  2. run 2 is warm for maker and verifier and the verdict is identical to the cold verdict
  3. run 3's scripted maker edits the lockfile, so the verifier reinstalls without secrets
  4. a secret is updated, so run 4 is cold again
  5. with the flag off there are no snapshot rows
- Existing suites (`e2e-factory-loop`, `e2e-repair-loop`, `e2e-m9-byok`) must pass unchanged with the flag off.

### Browser

- `test/console-environment-browser.test.js` (new, pattern of `test/console-models-browser.test.js` with `test/console-browser.js` helpers): the repository page shows the Environment section; Rebuild posts the command; status updates; the suggested config renders.

## Risks & open questions

1. **Secrets baked into a snapshot that the maker then restores.** Default: the leak scan fails the build. An alternative would be to restore snapshots for the verifier only. Human decision needed: is maker reuse worth the residual risk? Proposed default: allow it with the scan.
2. **Does verifier reuse dilute ADR-0004's "fresh sandbox" claim?** It is still a fresh VM, built from pre-maker, default-branch state. ADR-0030 must state this explicitly. Proposed default: allowed. `WINDKEEL_SNAPSHOT_FOR_VERIFIER=false` is the escape hatch. Human sign-off required on the ADR.
3. **Vercel snapshot restore + re-fetch semantics are unverified live.** Needs a spike, plus snapshot size/cost limits. Default TTL is 14 days and we keep the last 2.
4. **The build blocks nothing, so the first run is always cold.** An alternative is a synchronous build. Default: async.
5. **Services (e.g., Postgres) inside Firecracker VMs** must be restarted on every restore, because a snapshot does not keep processes. Already in the design.
6. **Auto-generated setup** might suggest unsafe commands. It is suggestion-only, and a human commits it.

## Suggested labels and dependencies

- Labels: `ready-for-human` (ADR-0030 sign-off on risks 1–2). After sign-off: PR A `ready-for-agent`, PR B `ready-for-agent`, PR C `ready-for-agent`.
- Blocked by: **01-live-proof** for the live verification only. The code can land behind the flag first.
- Related: 03-repo-knowledge-memory (can feed detection), 06-parallel-and-batch (warm starts matter most there), 09-billing-onboarding (snapshot storage cost), 10-multi-harness (the snapshot must be harness-agnostic: no harness binaries in the key except via the image id).
