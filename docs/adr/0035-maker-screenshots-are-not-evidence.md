# ADR-0035: Maker screenshots are not evidence

- Status: Accepted
- Date: 2026-10-21

## Context

The maker builds UI blind: it can run commands and tests, but the first time anyone sees a page is the verifier's browser stage, or a reviewer.

## Decision

- §1 — The maker gets a headless browser: `windkeel-browse` (a sandbox-local, argv-only helper over `playwright-core` and the Chromium headless shell) is installed in the maker's *install* phase when the repository declares `flows` or `makerBrowser.enabled`, unless the operator's kill switch `WINDKEEL_MAKER_BROWSER=off` is set.
- §2 — Screenshots are maker-authored, untrusted, and never evidence.
- §3 — They never reach the candidate: `.windkeel/browser/` is excluded in the maker's checkout and removed from the index by the candidate capture, so the verifier's input is the code change alone.
- §4 — People see them labelled: On the run page ("Maker screenshots — not verification evidence") and, by the maintainer's decision, in a **separate PR comment** headed as the maker's and unverified.

## Consequences

- The verifier's output is byte-identical with or without maker screenshots, because its input is.
- A maker sandbox for a UI repository pays a Chromium install per run until environment snapshots bake it in; the kill switch trades that away.
- A hostile maker can show people a misleading picture.
- Storage is bounded per run — at most `WINDKEEL_MAKER_SCREENSHOT_MAX` (default 50) screenshots of at most 4 MB each — and, since the 2026-10-27 amendment below, in time: 30 days.

**Later changes** (full text in Background):

- Amendment, 2026-10-27 — screenshots expire after 30 days ([#421](https://github.com/jyothepro/orqon/issues/421))

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Issue: [#392](https://github.com/jyothepro/orqon/issues/392)
- Leaves unchanged: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) (the gate),
  [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §3 (execution-phase egress),
  [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (the verifier stays the gate)

### Context

The maker builds UI blind: it can run commands and tests, but the first time anyone sees a page is
the verifier's browser stage, or a reviewer. Devin and Factory give their agents a browser. Giving
Windkeel's maker one closes that gap and should cut repair turns on UI work — but a screenshot the maker
took is the maker's say-so about its own work, and ADR-0014 assumes the maker is compromised.

### Decision

1. **The maker gets a headless browser.** `windkeel-browse` (a sandbox-local, argv-only helper over
   `playwright-core` and the Chromium headless shell) is installed in the maker's *install* phase when
   the repository declares `flows` or `makerBrowser.enabled`, unless the operator's kill switch
   `WINDKEEL_MAKER_BROWSER=off` is set. It opens only `http://` pages on loopback names and aborts every
   other request. Execution-phase egress is unchanged. An install failure is a `browser_unavailable`
   note on the feed, never a failed run.
2. **Screenshots are maker-authored, untrusted, and never evidence.** They are harvested out of
   `.windkeel/browser/` after each turn (safe paths, PNG signature, size and count caps), stored under
   `maker-browser/<run>/<sha256>.png` — apart from every evidence key — and recorded in
   `maker_screenshot` with a `screenshot` event on the run's feed. Nothing that verifies reads them:
   not the verifier, not the evidence package, not `hashes.json`, not the verdict.
3. **They never reach the candidate.** `.windkeel/browser/` is excluded in the maker's checkout and
   removed from the index by the candidate capture, so the verifier's input is the code change alone.
4. **People see them labelled.** On the run page ("Maker screenshots — not verification evidence")
   and, by the maintainer's decision, in a **separate PR comment** headed as the maker's and
   unverified. The PR description and the evidence comment stay the verifier's.

### Consequences

- The verifier's output is byte-identical with or without maker screenshots, because its input is.
- A maker sandbox for a UI repository pays a Chromium install per run until environment snapshots
  bake it in; the kill switch trades that away.
- A hostile maker can show people a misleading picture. That is why it is labelled as the maker's,
  linked rather than embedded in the PR, and never allowed to stand in for the verifier's browser stage.
- Storage is bounded per run — at most `WINDKEEL_MAKER_SCREENSHOT_MAX` (default 50) screenshots of at
  most 4 MB each — and, since the 2026-10-27 amendment below, in time: 30 days.
- Live browser streaming to a person (VNC/CDP) remains out of scope, with ADR-0029's takeover.

### Amendment, 2026-10-27 — screenshots expire after 30 days ([#421](https://github.com/jyothepro/orqon/issues/421))

By the maintainer's decision, maker screenshots are kept for **30 days** and then deleted by
[ADR-0015](0015-evidence-retention-outcome-tiered-with-tombstones.md)'s retention sweep — the stored
objects, not only the rows.

- **Window: 30 days, the capture tier's** (ADR-0015's 2026-10-20 amendment). A screenshot is
  diagnostic and never evidence (§2), so the reasoning that shortens a capture's window applies
  unchanged. Like that one it is policy configuration — `MAKER_SCREENSHOT_RETENTION_DAYS` in
  `src/factory/maker-screenshot-retention.ts`, overridable per call — and can move without a new ADR.
- **Per run, from the run's newest screenshot.** A run's objects are one prefix,
  `maker-browser/<run>/`, and that prefix is the unit the store deletes, so a run's screenshots go
  together once its last one is 30 days old. A run's set is never half-pruned; its first screenshot
  outlives the window by at most the run's length.
- **Same sweep, same lock, after captures.** Objects first, then rows — the ordering every prune in
  ADR-0015 uses, so an interrupted sweep leaves rows that still qualify and are finished on the next
  tick, never objects no row names. A stopping sweep finishes the run it is on. The sweep's log line
  reports `makerScreenshotsPruned`. `maker_screenshot` rows carry no bucket, so the sweep is given the
  evidence bucket (`S3_BUCKET`) they were harvested into; without it the tick reports screenshots
  skipped, with the reason, rather than zero pruned.
- **Rows are deleted, not tombstoned.** A screenshot row only points at its object and carries the
  maker's caption; unlike an evidence package or a capture, nothing needs to say "this existed and was
  pruned". The run's `screenshot` feed events stay as its history, and an expired screenshot's file
  route answers 404.

§1–§4 are unchanged: none of this touches evidence, the verifier, or any verdict.
