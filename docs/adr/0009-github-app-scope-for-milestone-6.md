# ADR-0009: The Milestone 6 GitHub App — permissions, events, triggers, and PR conventions

- Status: Accepted; amended by ADR-0019, ADR-0029 (proposed)
- Date: 2026-08-17

## Context

Plan §15 makes GitHub the first product integration — issue in, verified draft PR out — and §16 defines the evidence-oriented review surface, but neither pins the App's concrete scope.

## Decision

**The App is least-privilege for the M6 loop, triggered by the `windkeel` label, and reports through both a check run and a sticky evidence-summary comment.**

- §1 — Permissions.
- §2 — Webhook events: `issues`, `issue_comment`, `pull_request`.
- §3 — Trigger convention: adding the **`windkeel` label** to an open issue creates the `EngineeringTask` (`source_type: github_issue`, `source_reference`: the issue) and starts an `EngineeringRun`.
- §4 — Status surface — both, with distinct jobs.
- §5 — Branch and PR conventions: branches are `windkeel/issue-<number>-<slug>` from the repository's default branch.
- §6 — Forks and permission edges: v1 is **same-repo only** — events from forks are ignored, and runs never push to or open PRs from forks.

## Consequences

- The App can be registered once and left alone through M6: the permission list is the full M6 surface, and none of it is organization-scoped, so installation on the single account (ADR-0001) is the only setup step.
- Check run + sticky comment means the verdict is visible both to branch protection (machines) and to reviewers (humans) without comment spam; the sticky comment is the §16 surface and evolves with it.
- The `windkeel` label is the entire product trigger for M6 — no slash-command parser beyond `/windkeel cancel`, no UI.
- Ignoring forks closes the classic fork-PR credential hole for v1; supporting external contributors becomes an explicit later decision, not an accident.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-17
- Resolves: [#62 — Define the GitHub App scope for Milestone 6](https://github.com/jyothepro/orqon/issues/62) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed), §5: a person may merge from the console with their own GitHub user-to-server token, only the verified candidate, under branch protection. The App's client still never marks ready, approves or merges, and its installed permissions don't change.

### Context

Plan §15 makes GitHub the first product integration — issue in, verified draft PR out — and §16 defines the evidence-oriented review surface, but neither pins the App's concrete scope. The frame is already set: ADR-0001 means a single-account installation (no public multi-install before the Product UI milestone); ADR-0002 gives the webhook a permanent Vercel endpoint whose handler only validates, persists, and returns; ADR-0003 defines the run lifecycle the integration reports on.

The open choices: permissions, subscribed webhook events, the trigger convention, the status surface (check runs vs comments), branch and draft-PR conventions, and fork/permission edge behavior.

### Decision

**The App is least-privilege for the M6 loop, triggered by the `windkeel` label, and reports through both a check run and a sticky evidence-summary comment.**

1. **Permissions** (repository-level, nothing organization-level): Metadata read (mandatory), **Issues read/write** (ingest issues, post status comments), **Contents read/write** (clone, create branches, push candidate commits), **Pull requests read/write** (create draft PRs, edit the evidence comment), **Checks read/write** (publish the verdict as a check run). Nothing else — no Actions, no Administration, no Webhooks-management.
2. **Webhook events**: `issues`, `issue_comment`, `pull_request`. Handlers care about: `issues.labeled` (trigger), `issues.unlabeled` (cancellation), `issue_comment.created` (commands), `pull_request.closed` (merge/close → task completion). Everything else is persisted-and-ignored or dropped at ingress.

   > Amended by the maintainer's decision of 2026-10-27 (#432, recorded in ADR-0032's consequences): the App also subscribes to `pull_request_review` and `pull_request_review_comment`. `pull_request_review.submitted` (changes requested, or commented with text) and `pull_request_review_comment.created` on a pull request Windkeel opened become suggested repository-knowledge notes. No new permission.
3. **Trigger convention**: adding the **`windkeel` label** to an open issue creates the `EngineeringTask` (`source_type: github_issue`, `source_reference`: the issue) and starts an `EngineeringRun`. Re-labeling a task whose runs are all terminal starts a fresh run on the same task (ADR-0003: recovery is a new run). **Cancellation**: removing the label, or an issue comment `/windkeel cancel`, cancels the active run (operator cancellation → `CANCELLED`).

   > Amended by ADR-0012: the command list gains **`/windkeel approve`**, which advances a run holding at `WAITING_FOR_APPROVAL` (machine-generated acceptance criteria awaiting operator sign-off) to `PROVISIONING`. No new events; the existing `issue_comment` subscription carries it.
4. **Status surface — both, with distinct jobs**: a **check run** named `windkeel/verification` on the candidate head SHA carries the machine verdict (`pass`/`warn` → success/neutral, `fail` → failure) and links the evidence; **one sticky PR comment** carries the §16 human-readable evidence summary (criteria satisfied, stages, repair attempts, residual risk, cost) and is edited in place on re-verification — never a new comment per attempt. The **issue** gets brief comments at run start and at terminal states only.
5. **Branch and PR conventions**: branches are `windkeel/issue-<number>-<slug>` from the repository's default branch. PRs are **always draft**, titled from the task, body = evidence summary + `Resolves #<number>`; a human flips ready-for-review — the App never marks ready, approves, or merges (plan §1: humans stay the merge authority).
6. **Forks and permission edges**: v1 is **same-repo only** — events from forks are ignored, and runs never push to or open PRs from forks. A missing permission or a revoked installation discovered mid-run fails the run (`FAILED`, reason recorded) rather than degrading silently; the webhook secret is validated at the Vercel ingress before anything is persisted.

### Consequences

- The App can be registered once and left alone through M6: the permission list is the full M6 surface, and none of it is organization-scoped, so installation on the single account (ADR-0001) is the only setup step.
- Check run + sticky comment means the verdict is visible both to branch protection (machines) and to reviewers (humans) without comment spam; the sticky comment is the §16 surface and evolves with it.
- The `windkeel` label is the entire product trigger for M6 — no slash-command parser beyond `/windkeel cancel`, no UI. Richer commands belong to later milestones.
- Ignoring forks closes the classic fork-PR credential hole for v1; supporting external contributors becomes an explicit later decision, not an accident.
- The `pull_request.closed` subscription is what lets a human merge/close drive the task to its terminal status (ADR-0003's `WAITING_FOR_HUMAN` exits) without polling.
