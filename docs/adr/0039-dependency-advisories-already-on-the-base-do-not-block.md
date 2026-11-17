# ADR-0039: Dependency advisories already on the base revision are reported, not blocking

- Status: Accepted
- Date: 2026-10-26

## Context

The security stage's dependency scan (osv-scanner) blocked on every HIGH or CRITICAL advisory in the tree, with the failure scenario "as shipped by this change".

## Decision

- §1 — An advisory present on the base revision does not block: The verdict judges the change.
- §2 — Only what the change introduces blocks: — a new vulnerable package, a new manifest, or a version change that brings in an advisory the base did not have.
- §3 — The baseline fails closed.
- §4 — The base is scanned only when the head has something blocking: so a clean repository pays nothing.

## Consequences

- A change can no longer be failed for a vulnerability it did not introduce, and a repository's existing advisories are visible in every evidence package without stopping work on it.
- A change that *bumps* a vulnerable package to another vulnerable version of the same advisory is not blocked for it — the advisory was already there.
- Pre-existing advisories are the repository owner's to fix as their own change.
- Secret scanning (gitleaks) and pattern scanning (semgrep) are not baselined by this decision.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-26
- Decided by: the maintainer, 2026-10-26, after the content-machine#98 production run
- Touches: `packages/verification/src/stages/security.ts` (`osvScanner`, `baselineAdvisories`)

### Context

The security stage's dependency scan (osv-scanner) blocked on every HIGH or CRITICAL advisory in the
tree, with the failure scenario "as shipped by this change". It had no idea what the change shipped:
it scanned the head and nothing else.

On 2026-10-26 the first production run to get all the way to VERIFYING — content-machine#98, a
README-only change whose acceptance criteria forbid touching any other file — passed every criterion
and every check and was failed for `zod`'s GHSA-mrhx-c7xc-m3w5 (HIGH), which `main` already shipped.
The repair turn correctly changed nothing, and the run stopped at MAX_REPAIR_ATTEMPTS_REACHED. Any
repository with one unpatched dependency could never produce a pull request, whatever the task.

### Decision

1. **An advisory present on the base revision does not block.** The verdict judges the change. A
   head advisory whose `(manifest path, ecosystem, package, advisory id)` also appears in a scan of
   the base revision is recorded `non_blocking`, its claim saying it is already on the base and not
   introduced by the change. It stays in the evidence and the summary: reported, not enforced.
2. **Only what the change introduces blocks** — a new vulnerable package, a new manifest, or a
   version change that brings in an advisory the base did not have. Severity rules are otherwise
   unchanged (critical/high block).
3. **The baseline fails closed.** No base revision, a base that cannot be exported, or a base scan
   that does not complete leaves every advisory blocking, and the scanner's note says the baseline
   was unavailable and why — "nothing pre-existing" and "could not tell" never read alike.
4. **The base is scanned only when the head has something blocking**, so a clean repository pays
   nothing. It is exported with `git archive` into a scratch directory rather than checked out, so
   the checkout under review is untouched, and scanned with the same Gate-owned config and offline
   database as the head (ORQ-16 still applies to both).

### Consequences

- A change can no longer be failed for a vulnerability it did not introduce, and a repository's
  existing advisories are visible in every evidence package without stopping work on it.
- A change that *bumps* a vulnerable package to another vulnerable version of the same advisory is
  not blocked for it — the advisory was already there. A change that fixes one simply no longer
  reports it.
- Pre-existing advisories are the repository owner's to fix as their own change. Windkeel does not open
  that change on its own.
- Secret scanning (gitleaks) and pattern scanning (semgrep) are not baselined by this decision.
