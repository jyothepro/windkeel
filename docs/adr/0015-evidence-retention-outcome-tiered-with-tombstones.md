# ADR-0015: Evidence retention is outcome-tiered, with tombstones for pruned packages

- Status: Accepted
- Date: 2026-08-18

## Context

ADR-0008 puts evidence packages in Supabase Storage with `VerificationRun.evidence_package_ref` holding bucket + key; ADR-0009 links them from the sticky PR comment and the check run, so those links live on in merged PR history.

## Decision

**The verdict of record is kept indefinitely; superseded intermediate packages expire after 90 days; pruning is whole-package and always leaves a tombstone.**

- §1 — Two tiers.
- §2 — Pruning is whole-package.
- §3 — Every prune leaves a tombstone.

## Consequences

- Storage grows with merged and terminal work rather than with total verification attempts, which is the axis that should grow — a run that repaired three times eventually costs the same as one that passed first try.
- The audit claim does not decay: an evidence link in a two-year-old merged PR still resolves, which is what makes "verified engineering work" mean anything after the fact.
- The pruning job is a scheduled sweep over `VerificationRun` rows — straightforward to write, and straightforward to get wrong.
- Tombstones make the system honest about its own gaps rather than silently lossy — the same principle the replay harness already applies to unevaluated cases.

**Later changes** (full text in Background):

- Amendment, 2026-10-20 — stored captures expire after 30 days ([#288](https://github.com/jyothepro/orqon/issues/288))

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-18
- Resolves: [#78 — Decide the evidence-package retention policy](https://github.com/jyothepro/orqon/issues/78) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

ADR-0008 puts evidence packages in Supabase Storage with `VerificationRun.evidence_package_ref` holding bucket + key; ADR-0009 links them from the sticky PR comment and the check run, so those links live on in merged PR history. ADR-0001 means storage is one person's bill. What was never decided is how long packages live.

Two properties of the artifact constrain the answer:

- **Packages are sealed and signed as a unit** (`src/evidence/package.ts`: `seal()` hashes the spine and signs the digest). Deleting individual files inside a package — the tempting move, since Playwright traces and screenshots dominate the bytes while manifest/verdict/mapping are tiny — leaves an object that no longer verifies. Retention decisions must be whole-package.
- **Not all packages carry the same weight.** A run that repaired twice produces three verification packages, but only the last one is the verdict of record; the earlier two exist to explain how the loop got there. A merged PR's evidence link points at exactly one package, and that is the one the product's audit claim rests on.

### Decision

**The verdict of record is kept indefinitely; superseded intermediate packages expire after 90 days; pruning is whole-package and always leaves a tombstone.**

#### 1. Two tiers

- **Verdict of record — indefinite.** The final `VerificationRun` of any `EngineeringRun` that reached a terminal state (ADR-0003: `COMPLETED`, `FAILED`, `CANCELLED`, `MAX_REPAIR_ATTEMPTS_REACHED`) is never pruned by policy. This is the package the PR comment and check run link to, and the one that answers "what was this merge actually verified against" years later.
- **Superseded packages — 90 days.** Verification packages from earlier repair cycles of the same run are pruned 90 days after their `VerificationRun` completes. They explain a repair loop, which is a question asked within weeks of the run, not years.

A run still in flight prunes nothing: "superseded" is only knowable once a later `VerificationRun` for the same `EngineeringRun` exists.

#### 2. Pruning is whole-package

A package is deleted entirely or kept entirely. No file-level tiering, no "keep the spine, drop the traces" — the seal covers the whole directory, and a partially pruned package would fail `windkeel verify-package` while still looking like evidence. A package that cannot be verified is worse than one that is honestly gone.

#### 3. Every prune leaves a tombstone

Pruning nulls `evidence_package_ref` and records on the `VerificationRun`:

- **`evidence_pruned_at`** — when policy removed it.
- **`evidence_manifest_digest`** — the sealed package's digest, captured at seal time and retained forever.

So a stale link in an old PR resolves to "pruned on 2026-11-14 by retention policy; manifest digest `sha256:…`" rather than a bare 404. The row still proves a package existed, what it hashed to, and that its absence was deliberate. Retaining the digest also means a package restored from an external backup can be proven to be the same package.

`evidence_manifest_digest` is written for **every** verification, pruned or not — a digest recorded only at prune time would be a digest of whatever was in storage then, which is exactly the thing it is supposed to attest to.

#### Amendment to ADR-0003

`VerificationRun` gains `evidence_pruned_at` and `evidence_manifest_digest`, and `evidence_package_ref` becomes nullable with a defined meaning: null plus a non-null `evidence_pruned_at` is "pruned by policy", null with neither is "no package produced". No states, transitions, or other entities change.

### Consequences

- Storage grows with merged and terminal work rather than with total verification attempts, which is the axis that should grow — a run that repaired three times eventually costs the same as one that passed first try.
- The audit claim does not decay: an evidence link in a two-year-old merged PR still resolves, which is what makes "verified engineering work" mean anything after the fact.
- The pruning job is a scheduled sweep over `VerificationRun` rows — straightforward to write, and straightforward to get wrong. It must join to confirm a later `VerificationRun` exists for the same `EngineeringRun` before deleting anything; a bug that treats a sole verification as superseded destroys the record it was meant to protect. That query deserves a test with a single-verification run as its fixture.
- Tombstones make the system honest about its own gaps rather than silently lossy — the same principle the replay harness already applies to unevaluated cases.
- 90 days is policy configuration, not a constant: the number can move without a new ADR; the two-tier structure and the whole-package rule cannot.
- Retention interacts with #80's ledger: `cost_event` and `run_state_transition` rows are small and are **not** covered by this policy — they stay as long as the run does. Pruning them is a separate decision if it ever becomes one.

### Amendment, 2026-10-20 — stored captures expire after 30 days ([#288](https://github.com/jyothepro/orqon/issues/288))

`POST /v1/runs/{id}/capture` (#286) stores a maker sandbox's scratch directory — the agent's own transcript — in the evidence bucket under `captures/<run-id>/`. This ADR's sweep found evidence through `verification_run.evidence_package_ref`, and a capture had no row, so captures were never pruned. A JSONL transcript is capped at 32 MiB per file and a repair loop writes one per turn.

- **Window: 30 days from capture.** A capture is diagnostic, never the verdict of record: it is pulled out to answer a question about a run while the question is live, which is weeks, and the verdict it might be asked to explain is the sealed package §1 keeps indefinitely. Shorter than §1's 90 days for superseded packages for that reason, and not tied to the run's evidence ("until the run's evidence is pruned"), because a verdict of record is never pruned and that would make captures indefinite too. Like the 90, it is policy configuration — `CAPTURE_RETENTION_DAYS` in `src/factory/capture-retention.ts`, overridable per call the way `DEFAULT_RETENTION_DAYS` is — and can move without a new ADR.
- **Anchor: a `run_capture` row** (migration 0037): run id, bucket, object key prefix, byte total, `captured_at`, `pruned_at`. One per run, because a later capture overwrites the same key; re-capturing replaces the row and restarts the window. A row rather than the object store's `LastModified`, for the reason §3 keeps rows: the API can answer from Postgres without a bucket scan, and the age is the capture's, not whatever last touched an object.
- **Sweep: the same tick, under the same advisory lock**, after the evidence prune. Objects first, then `pruned_at`: the ordering `pruneVerificationRun` uses, for its reason — an interrupted sweep leaves a row that still qualifies and is finished on the next tick, never objects no row names. The sweep's log line reports `capturesPruned`.
- **Captures are whole-directory, like packages (§2)**, and a pruned capture keeps its row, as a pruned package keeps its tombstone (§3): `GET /v1/runs/{id}/capture` answers `state: "pruned"` with `prunedAt`, not an empty list that reads as "never captured" — the distinction `GET …/evidence` makes between `pruned` and `never_produced`. A captured file of a pruned capture is `409 capture_pruned`, as a pruned package's file is `409 no_package`.
- **Captures that predate `run_capture` are unknown to the sweep and kept.** No backfill: inferring their age would take `LastModified` from a scan of `captures/`, the thing the row exists to avoid, for the few captures stored between #286 and 0037. The API reports them `stored` with null dates. Re-capturing such a run brings it under the window; otherwise an operator removes them by hand if they matter.

§1–§3 for evidence packages are unchanged.
