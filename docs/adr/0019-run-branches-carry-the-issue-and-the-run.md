# ADR-0019: A run's branch names the issue *and* the run

- Status: Accepted
- Date: 2026-09-06

## Context

Two branch conventions were written a milestone apart and disagree.

## Decision

**A GitHub-sourced run's branch is `windkeel/issue-<number>-<slug>-<run-discriminator>`; everything else keeps `windkeel/run/<engineeringRunId>`.**

- §1 — The **issue number and a slug of the task title** carry §5's intent: a branch says what it is for, at a glance, in a branch list.
- §2 — The **run discriminator** — the first eight hex characters of the run id — makes the name unique per run, so ADR-0009 §3's fresh-run-on-the-same-task cannot collide with an earlier run's branch or its open pull request.
- §3 — The **local path is unchanged**.
- §4 — The guard property is untouched.

## Consequences

- ADR-0009 §5's branch pattern is superseded by the pattern above.
- Branch names are longer, and the slug is bounded at 40 characters so a discursive issue title cannot produce a ref that is awkward to type or display.
- "Which run wrote this branch?" is answerable from the branch name alone, which matters when a repository accumulates branches from several runs of the same issue.
- A run that is re-driven (a redelivered job) recomputes the same name, so the pull-request find-first in `PR_CREATING` still has a stable natural key.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-06
- Amends: [ADR-0009](0009-github-app-scope-for-milestone-6.md) §5 (branch and PR conventions)
- Arises from: [#162 — M6.9](https://github.com/jyothepro/orqon/issues/162), Milestone 6

### Context

Two branch conventions were written a milestone apart and disagree.

ADR-0009 §5 says branches are `windkeel/issue-<number>-<slug>`, cut from the default branch. Milestone
4.5's candidate capture, which had no issue to name anything after, computes
`windkeel/run/<engineeringRunId>` and guards it: the name is derived from data the run owns, never
passed in, matched exactly by `assertRunBranch`, with protected refs refused, an explicit refspec,
and no `--force`. That guard is the reason a model-authored shell command cannot make the factory
write to `main`.

Milestone 6.9 opens the pull request, so the two conventions finally meet on one branch name.

The difference is not cosmetic. ADR-0009 §3 says re-labelling an issue whose runs are all terminal
starts a **fresh run on the same task**. Under §5's name, that second run computes the *same*
branch as the first and pushes onto it — a fast-forward over another run's candidate, on a branch
whose pull request may already be open and under review. That is precisely the class of accident
`assertRunBranch` exists to make impossible, and adopting §5 literally would have re-introduced it
through the front door.

Under the M4.5 name the collision cannot happen, but a human scanning a repository's branches sees
`windkeel/run/6f1c2b9e-…` and learns nothing — which is the readability §5 was reaching for.

### Decision

**A GitHub-sourced run's branch is `windkeel/issue-<number>-<slug>-<run-discriminator>`; everything
else keeps `windkeel/run/<engineeringRunId>`.**

1. The **issue number and a slug of the task title** carry §5's intent: a branch says what it is
   for, at a glance, in a branch list.
2. The **run discriminator** — the first eight hex characters of the run id — makes the name
   unique per run, so ADR-0009 §3's fresh-run-on-the-same-task cannot collide with an earlier
   run's branch or its open pull request.
3. The **local path is unchanged**. A task created by the CLI (ADR-0016's hermetic mode) has no
   issue to name a branch after and its branches are read by nobody, so `windkeel/run/<id>` stays.
4. **The guard property is untouched**, and this is the non-negotiable part: the branch is
   computed from data the run owns (its id and its task), never accepted as input; `assertRunBranch`
   recomputes and matches it exactly; protected refs are refused; the push is still an explicit
   refspec with no `--force`. The computation moved to `src/factory/workflow/branch.ts`; the rule
   did not change.

### Consequences

- ADR-0009 §5's branch pattern is superseded by the pattern above. Everything else in §5 — draft
  PRs only, title from the task, body = evidence summary + `Resolves #<n>`, a human flips ready —
  stands unchanged.
- Branch names are longer, and the slug is bounded at 40 characters so a discursive issue title
  cannot produce a ref that is awkward to type or display.
- "Which run wrote this branch?" is answerable from the branch name alone, which matters when a
  repository accumulates branches from several runs of the same issue.
- A run that is re-driven (a redelivered job) recomputes the same name, so the pull-request
  find-first in `PR_CREATING` still has a stable natural key.
