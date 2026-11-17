# ADR-0033: Playbooks shape the maker and only strengthen the verifier

- Status: Accepted
- Date: 2026-10-21

## Context

Buyers think in kinds of work — "upgrade this dependency", "write tests for this module", "fix this incident" — and competitors ship templates for them (Devin's Playbooks, Factory's Droids).

## Decision

- §1 — A playbook is an organization-scoped, versioned entity: (`migrations/0045_playbook.sql`): a name, a kind, maker instructions, criteria, verifier requirements, and an optional default risk level and model preset.
- §2 — A playbook is copied, not referenced: — the model-preset rule (migrations/0033).
- §3 — The verifier requirements are strengthen-only, by construction.
- §4 — The verifier package owns the merge: `applyPlaybookToPolicy(base, requirements)` (`packages/verification/src/playbook-policy.ts`) is monotonic: every base check, flow and tool comes out unrenamed (a playbook name that collides gets a suffix, never the base's), and `checksRequired` and required stages are only ever OR-ed.
- §5 — Playbook criteria are added on top of the task's own, and never count as them.
- §6 — The maker prompt: gains a `## Playbook: <slug> (v<n>)` section before the criteria.
- §7 — Evidence says what was added.
- §8 — Who may write one: `playbooks.read` (Admin, Member) picks one when filing work; `playbooks.manage` (Admin; not given to a token unless asked for by name) writes them, because `extraChecks` are commands the verifier runs for every task that chooses the playbook.

§3–§4 (strengthen-only; the verifier package owns the merge) are enforced by `npm run invariant:check` (`scripts/invariant-check.mjs`, checks `adr-0033-*`).

## Consequences

- A playbook can make a run harder to pass, never easier.
- A playbook's `extraTools` are installed by the verifier's install phase after the repository's, under the same cap; a tool over the cap is recorded as refused, not dropped.
- Built-in wording is v1 and wants product review; improving it is a code change with a version bump, and tasks already filed keep the version they took.
- Out of scope: cross-organization sharing, playbook-specific repair prompts, choosing a playbook from issue text or an intake label, and a pure review mode without a maker.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Issue: [#390](https://github.com/jyothepro/orqon/issues/390)
- Leaves unchanged: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) (the
  verifier trusts the candidate's commits and nothing it says about its own checks),
  [ADR-0012](0012-m6-task-understanding-extract-first-generate-fallback.md) (extract first, generate
  and approve otherwise), [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)
  (no path around verification)
- Adds: two permissions to [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)'s
  list (`playbooks.read`, `playbooks.manage`), and one optional field to the evidence manifest
  (`manifest.playbook`) without changing `dev.orqon.evidence/v0`

### Context

Buyers think in kinds of work — "upgrade this dependency", "write tests for this module", "fix
this incident" — and competitors ship templates for them (Devin's Playbooks, Factory's Droids).
Every Windkeel task was generic: one prompt (`buildMakerPrompt`), one fixed pipeline. A person had
to rewrite the same instructions every time, and Windkeel could not say "a dependency upgrade gets
*these* checks".

A template is also an obvious way to weaken a gate: a "fast" template that skips security, a
template that ships its own criteria pre-approved, a template a repository can declare in its own
checkout. Windkeel's edge is the independent verifier; a template feature must not be the thing that
erodes it.

### Decision

1. **A playbook is an organization-scoped, versioned entity** (`migrations/0045_playbook.sql`): a
   name, a kind, maker instructions, criteria, verifier requirements, and an optional default risk
   level and model preset. Five built-ins (`code-review`, `migration`, `incident-fix`,
   `test-writing`, `dependency-upgrade`) live in code (`src/factory/playbooks-builtin.ts`) so a
   deploy can improve them; an organization copies one into a row to change it, and the row shadows
   the built-in by slug. `WINDKEEL_PLAYBOOKS_BUILTIN=0` turns the built-ins off.

2. **A playbook is copied, not referenced** — the model-preset rule (migrations/0033). Choosing one
   at task creation stores a snapshot on `engineering_task.playbook` (slug, version, instructions,
   criteria, verifier requirements, `builtin`). Editing or archiving the playbook afterwards changes
   no task and no run, and each edit bumps `version` so a snapshot says which one it took.

3. **The verifier requirements are strengthen-only, by construction.** Their type has exactly five
   fields: `extraChecks` (appended, named `playbook.<name>`), `checksRequired` (the literal `true`),
   `requireStages` (`browser`/`security`: a required stage that skips becomes a blocking finding),
   `extraFlows` and `extraTools` (under the repository's own name rules and tool cap). There is no
   field that could remove a check, switch `checksRequired` off, skip a stage or lower the gate
   level. The parser refuses unknown keys on save and again on read, so `{"checksRequired": false}`
   or `{"skipStages": [...]}` is a `400 invalid_playbook`, and a row edited to hold one fails on read
   rather than being trusted with the field dropped.

4. **The verifier package owns the merge.** `applyPlaybookToPolicy(base, requirements)`
   (`packages/verification/src/playbook-policy.ts`) is monotonic: every base check, flow and tool
   comes out unrenamed (a playbook name that collides gets a suffix, never the base's), and
   `checksRequired` and required stages are only ever OR-ed. The engine applies it to whichever
   policy it resolved — the caller's, or the base revision's (`loadTrustedConfig`) — so the
   trusted-config path, its drift evidence and its scripts overlay are unchanged. The requirements
   come from the factory's database through `VerificationRequest.playbook`, never from the
   candidate's checkout: ADR-0004's "the head cannot choose its own checks" still holds, and the
   head cannot choose a playbook either.

5. **Playbook criteria are added on top of the task's own, and never count as them.** They stay in
   the snapshot, not in `engineering_task.acceptance_criteria`, and are merged only where a run is
   held to them (`effectiveCriteria`: the maker's prompt, the verifier's criteria, the report), as
   `PB1`, `PB2`, … with `source.ref = "playbook:<slug>@<version>"`. The criteria gate sees only the
   author's own, so a description with none still takes ADR-0012's generation-then-approval route,
   and nothing about a playbook approves anything. (Maintainer decision on #390.)

6. **The maker prompt** gains a `## Playbook: <slug> (v<n>)` section before the criteria. A task
   without a playbook gets byte-identical output to before. Repair turns are unchanged.

7. **Evidence says what was added.** The manifest records `playbook: { slug, version, builtin,
   added_checks, added_flows, added_tools, checks_required, required_stages, added_criteria }`; the
   run report and the PR summary list the same, so a reviewer can see the run was held to *more*.
   The field is optional and the format string is unchanged: a package without it reads as before,
   and `verify-package` recomputes the verdict from evidence as it always has.

8. **Who may write one.** `playbooks.read` (Admin, Member) picks one when filing work;
   `playbooks.manage` (Admin; not given to a token unless asked for by name) writes them, because
   `extraChecks` are commands the verifier runs for every task that chooses the playbook. They are
   operator-trusted, as an injected policy is, and run argv-style in the verifier sandbox like the
   repository's own checks.

   Security sign-off (maintainer, 2026-10-27, [#420](https://github.com/jyothepro/orqon/issues/420)):
   arbitrary `extraChecks` are allowed **because they run only inside the verifier sandbox**, under
   the same egress policy and with no secrets beyond what the repository's own checks get. Running
   them anywhere else, or granting them more, needs a new decision. Requiring an org admin to
   approve each playbook's checks before they first run is planned (#420, backlog).

### Consequences

- A playbook can make a run harder to pass, never easier. A `dependency-upgrade` task on a verifier
  without scanners now fails (security required, and it skipped) where a plain task would warn —
  that is the point, and the finding says why.
- A playbook's `extraTools` are installed by the verifier's install phase after the repository's,
  under the same cap; a tool over the cap is recorded as refused, not dropped.
- Built-in wording is v1 and wants product review; improving it is a code change with a version
  bump, and tasks already filed keep the version they took.
- Out of scope: cross-organization sharing, playbook-specific repair prompts, choosing a playbook
  from issue text or an intake label, and a pure review mode without a maker.
