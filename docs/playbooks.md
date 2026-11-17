# Playbooks

A playbook is a reusable kind of work: instructions for the maker, criteria added to the task's
own, and verifier requirements that only ever make verification stricter. The decision record is
[ADR-0033](adr/0033-playbooks-shape-the-maker-and-only-strengthen-the-verifier.md).

## Built-ins

| slug | what the maker is told | added criteria | the verifier will also |
|---|---|---|---|
| `dependency-upgrade` | Upgrade only the named package(s), read the changelog, update the lockfile, no unrelated changes | Lockfile consistent with the manifest; existing test suite passes | fail when the repo declares no checks; require the security stage |
| `test-writing` | Add tests only; no production change unless a test reveals a bug | New tests exercise the behaviour; no production change unless justified | fail when the repo declares no checks |
| `incident-fix` | Reproduce with a failing test first, minimal fix, state the root cause | A regression test reproduces the incident and passes after the fix | fail when the repo declares no checks |
| `migration` | Mechanical, incremental, behaviour identical, every call site | No behaviour change: existing tests pass unchanged | fail when the repo declares no checks |
| `code-review` | Address each review point or decline it explicitly; keep the diff focused | Each review point addressed or explicitly declined | nothing beyond the repo's own policy |

Built-ins live in `src/factory/playbooks-builtin.ts`. `WINDKEEL_PLAYBOOKS_BUILTIN=0` turns them off.
To change one for your organization, copy it (`POST /v1/playbooks { "from": "dependency-upgrade" }`,
or *Duplicate* in Settings → Playbooks); your copy shadows the built-in by slug.

## Filing work under one

- API: `POST /v1/tasks { …, "playbook": "dependency-upgrade" }`. An unknown or archived playbook is
  `404 unknown_playbook`. The playbook's default risk level and model preset apply only when the
  body names none.
- CLI: `windkeel submit --repo … --title … --description … --playbook dependency-upgrade`;
  `windkeel playbook list`, `windkeel playbook show <slug>`.
- Console: the composer's *Playbook* select shows the criteria it adds and "Verifier will also: …".
- MCP: `windkeel_submit_task` takes an optional `playbook`.

The task keeps a frozen copy (`engineering_task.playbook`): editing the playbook later changes no
task already filed. Each edit bumps the playbook's version.

## What a playbook can and cannot do

`verifier` has exactly these fields, and anything else is refused with `400 invalid_playbook`:

```json
{
  "extraChecks": [{ "name": "lint-strict", "command": "npm run lint -- --max-warnings 0" }],
  "checksRequired": true,
  "requireStages": ["security", "browser"],
  "extraFlows": [{ "name": "smoke", "command": "npx playwright test smoke", "artifacts": "test-results" }],
  "extraTools": ["ripgrep", { "package": "jq", "reason": "the lint script uses it" }]
}
```

- Extra checks run in the verifier beside the repository's (base revision) checks, as
  `playbook.<name>`; a failing one fails the gate exactly as a failing repo check does.
- `checksRequired` can only be `true`. It asks whether the repository declares checks: a playbook's own `extraChecks` never count, so they cannot turn "requires checks but declares none" into a pass — nor, when checks are not required, hide the "no repo checks were discovered" warning. `requireStages` turns a skipped stage into a blocking finding.
- Nothing removes a check, switches `checksRequired` off, skips a stage or lowers the gate.
- Playbook criteria (`PB1`, …) are added to the task's own criteria. They never count as the
  author's: a description with none still goes through generation and human approval (ADR-0012).
- The evidence manifest records `playbook: { slug, version, builtin, added_checks, … }`, and the run
  report and PR summary list what it added.

Writing playbooks needs `playbooks.manage` (Admin) — extra checks are commands the verifier runs.
Reading them needs `playbooks.read` (Admin, Member).
