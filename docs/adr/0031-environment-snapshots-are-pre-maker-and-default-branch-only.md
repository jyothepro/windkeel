# ADR-0031: Environment snapshots are pre-maker and default-branch-only

- Status: Accepted
- Date: 2026-10-21

## Context

Every run creates a maker sandbox and one fresh verifier sandbox per verification cycle (ADR-0004), and each clones the repository and runs `npm ci` / `pip install` / `go mod download` (`src/sandbox/dependencies.ts`) from nothing.

## Decision

- §1 — What a snapshot is built from — and only this.
- §2 — Where it is built: a setup sandbox.
- §3 — What a restore still does, for maker and verifier alike.
- §4 — Is verifier reuse still a "fresh sandbox"?: Yes, and this is the claim ADR-0004 makes: a new VM per verification, whose disk predates any maker involvement and whose working tree is fetched from the remote at the candidate SHA.
- §5 — Secrets on disk fail the build, always: A snapshot is restored into maker sandboxes, which are assumed hostile (ADR-0014).
- §6 — The key, and invalidation.
- §7 — Who builds, and when: Nobody waits.
- §8 — Off by default: `WINDKEEL_ENVIRONMENT_SNAPSHOTS` defaults to `false` until the Vercel restore path is proven live.

## Consequences

- Warm maker and verifier boots on repositories whose install inputs have not changed since the snapshot, and repositories that need a declared bootstrap can be built at all.
- A second copy of the repository's secrets' *effects* exists on disk for up to the TTL.
- Setup runs default-branch repository code with the secrets — ADR-0014 §5's trust level, applied to one more set of commands the repository declares.
- Snapshot storage is billed per GB-month; retention keeps it to two per repository per organization.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Issue: [#387](https://github.com/jyothepro/orqon/issues/387)
- Amends: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) Consequences (the
  "cache-able later" clause, now built), [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §5
  (secrets reach one more place: a setup sandbox's commands)
- Leaves unchanged: ADR-0004 §1 (the verifier never reuses, forks or snapshot-restores the **maker's**
  sandbox), [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)
  (nothing goes around verification)

### Context

Every run creates a maker sandbox and one fresh verifier sandbox per verification cycle (ADR-0004),
and each clones the repository and runs `npm ci` / `pip install` / `go mod download`
(`src/sandbox/dependencies.ts`) from nothing. On real repositories that is minutes per cycle, and a
repository that needs more than a lockfile install — a database, a codegen step, `make bootstrap` —
cannot be built at all, so the verifier reports on the factory instead of on the candidate.

ADR-0004's Consequences already name the legal path: "cache-able later via provider snapshots of a
*pre-maker* base image — caching is legitimate exactly when the cached state predates any maker
involvement." This ADR is that cache, and states the rule it is held to.

### Decision

1. **What a snapshot is built from — and only this.** (a) The repository at its **default
   branch's** HEAD at build time; (b) the `setup` declared in `windkeel.config.json` **at that same
   commit**, read from git (`revisionSource`), never from a candidate or a working tree; (c) the
   repository's own secrets. A candidate that edits `setup` is reported in `configDrift` and changes
   nothing until it is merged.

2. **Where it is built: a setup sandbox.** A third use of the sandbox seam, neither maker nor
   verifier: created with the verifier's role and permissions — a `contents: read` token, no
   operator model key (`operatorModelKey: false`) — never recorded on a `workspace` row and never
   handed to a worker. No maker process runs in it. `buildEnvironmentSnapshot` refuses to call
   `snapshot()` on a handle whose role is `maker`, and nothing else calls it.

3. **What a restore still does, for maker and verifier alike.** The provider restores the disk and
   then **fetches and checks out** the revision the workspace asked for from the git remote with
   that workspace's own per-role token (`SandboxCreateOptions.fromSnapshot`), so the working tree is
   the candidate's (or the default branch's), exactly as after a cold clone. Then:
   - the snapshot is used only if its commit **is an ancestor** of the checkout
     (`git merge-base --is-ancestor`); otherwise the sandbox is destroyed unused and provisioned cold;
   - the install is skipped **only** when none of its inputs — lockfiles, manifests, install
     configuration, `setup.cacheKeyFiles`, `windkeel.config.json` — differ between the snapshot's commit
     and the checkout (`installInputChanges`). A difference reinstalls: on a candidate tree **without
     the repository's secrets** (the change is the maker's), on the default branch as cold. "Could
     not tell" is a full install as cold;
   - declared `setup.services` start again (a snapshot keeps disk, not processes), from the setup at
     the snapshot's commit;
   - the verifier runs every check fresh. Nothing about the verdict's inputs comes from the snapshot
     except the installed environment the default branch produced.

4. **Is verifier reuse still a "fresh sandbox"?** Yes, and this is the claim ADR-0004 makes: a new
   VM per verification, whose disk predates any maker involvement and whose working tree is fetched
   from the remote at the candidate SHA. What ADR-0004 forbids — inheriting the *maker's* filesystem
   — is not possible here, because no snapshot is ever taken of a sandbox a maker ran in. The
   maintainer decided (2026-10-21) that **both maker and verifier may restore**. The operator's kill
   switch `WINDKEEL_SNAPSHOT_FOR_VERIFIER=false` forces every verifier cold while makers still restore.

5. **Secrets on disk fail the build, always.** A snapshot is restored into maker sandboxes, which
   are assumed hostile (ADR-0014). Before `snapshot()`, every file under the checkout is searched for
   every recognisable form of every secret value (`redact.ts`'s `secretForms`: raw, URL-encoded,
   base64 at each alignment). A hit fails the build with the secret's **name** and the file paths,
   never the value. The scan is mandatory; there is no flag that skips it. `setup.commands` must not
   persist credentials (a `.npmrc` with a literal token, say); a registry credential belongs in the
   environment, where npm and its kin already read it.

   **The whole disk a snapshot keeps (#433).** A Vercel snapshot is the VM's whole disk, so on a
   provider with a filesystem of its own the scan also covers the setup user's `$HOME` and
   `/etc`, `/tmp`, `/var/tmp`, `/usr/local/etc`, `/opt`, `/var/lib` and `/root` where present
   (`leakScanRoots`). The pseudo filesystems `/proc`, `/sys`, `/dev` and `/run` are never roots —
   they are not on the snapshotted disk, and `/proc` holds the scan's own environment, which carries
   every pattern. Nothing large is excluded; the time is bounded instead (one `grep` across all roots
   and all values, then one per secret over just the hit files to name them, under a 15-minute
   `timeout`), and the duration is in the build log and the snapshot's detail. Patterns travel only
   in the scan's environment, never argv or a file.

   **A scan that could not look is not clean.** The scan runs as root where the sandbox allows it
   (directly, or through passwordless `sudo` with the patterns kept in the environment). Where it
   cannot, it runs as the sandbox user, and a root it could not enter, a file inside a searched root
   it could not read, or a timeout fails the build, **named** (path and reason, never content). We
   chose this over skipping unreadable files: a file the scan could not open is one it cannot vouch
   for, and a snapshot restores it into every maker sandbox. A root that does not exist is skipped —
   nothing there can be snapshotted. A multi-line secret is searched for by its longest line, since
   a lone `-----BEGIN …-----` header would match every certificate on the disk.

   **Setup's untracked output is excluded file by file.** What setup leaves untracked in the checkout
   is listed in `.git/info/exclude` so a restored maker's capture does not commit it — one line per
   *file*, never per directory, because an excluded directory would also hide a file the maker later
   creates inside it and silently drop it from the candidate. More than 5,000 such files fails the
   build with a request to `.gitignore` the output directory instead.

6. **The key, and invalidation.** The cache key is a sha256 over a canonical JSON of
   `SNAPSHOT_FORMAT_VERSION`, the provider and its image, the canonicalised `setup`, the **blob SHAs**
   of every install input plus `setup.cacheKeyFiles` and `windkeel.config.json`, and the sorted
   `(key, updated_at)` of the repository's secrets — never a value. Blob SHAs, not the commit, so an
   ordinary source commit does not invalidate. Putting or deleting a repository secret marks that
   organization's snapshots `invalidated` in the same call. A snapshot belongs to one organization,
   because it was built with that organization's secrets (ADR-0024 §3).

7. **Who builds, and when.** Nobody waits. A run that provisions cold records a build request (an
   intent, ADR-0023); `POST /v1/repositories/{id}/environment/rebuild` records or starts one. Builds
   run on the stage deployment as their own one-step Workflow (`orqonBuildEnvironmentSnapshotFlow`),
   because only the stage side holds the private key the secrets need; the sweep dispatches queued
   requests by id and never opens a secret. The partial unique index on
   `(organization, repository, provider, key) where status in ('building','ready')` is the build lock.
   A ready snapshot lives `WINDKEEL_SNAPSHOT_TTL_DAYS` (14); the sweep keeps the newest two per
   repository and deletes the provider snapshots of the rest.

8. **Off by default.** `WINDKEEL_ENVIRONMENT_SNAPSHOTS` defaults to `false` until the Vercel restore
   path is proven live. Off, provisioning is unchanged: no row is written, no column is set, and the
   run report and verification rows read exactly as before.

### Consequences

- Warm maker and verifier boots on repositories whose install inputs have not changed since the
  snapshot, and repositories that need a declared bootstrap can be built at all.
- A second copy of the repository's secrets' *effects* exists on disk for up to the TTL. The leak
  scan bounds what that can contain to what the scan cannot recognise — an arbitrary transformation
  of a value is invisible to it, as `redact.ts` says of itself. That residual is accepted for maker
  restores by the maintainer's decision; `WINDKEEL_SNAPSHOT_FOR_VERIFIER` does not change it, because
  the maker restores either way.
- Setup runs default-branch repository code with the secrets — ADR-0014 §5's trust level, applied to
  one more set of commands the repository declares.
- Snapshot storage is billed per GB-month; retention keeps it to two per repository per organization.
- The Vercel restore-then-fetch path, snapshot size limits, and whether deleting a stopped sandbox
  deletes its snapshots are not yet verified live; that spike gates turning the flag on.
- The first run on a repository is always cold.
