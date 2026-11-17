# Schedules: cron-triggered engineering tasks

A **schedule** is a task template plus a cron expression. Every slot the expression names becomes
one `EngineeringTask` — through the same intake pipeline as every other M8 source (source
`schedule`), with criteria extracted from the description exactly as for an issue (ADR-0012), and
the run capped by the schedule's rails (ADR-0011).

Milestone 8, issue #296. Code: `src/schedules/` (`cron.ts`, `store.ts`, `tick.ts`), the tick route
`apps/ingress/api/schedules.ts`, the API in `apps/ingress/src/api/schedules.ts`, migration
`0026_schedule.sql`.

## The two PLAN examples, ready to paste

Every Monday at 09:00 London time, upgrade dependencies:

```sh
windkeel schedule create \
  --name dependency-upgrades \
  --repo <repository-id> \
  --cron "0 9 * * mon" --tz Europe/London \
  --title "Dependency upgrades ({{date}})" \
  --description "Upgrade this repository's dependencies to their latest compatible versions.

- [ ] every direct dependency is on its latest minor or patch release
- [ ] the test suite passes"
```

Nightly at 03:00 New York time, repair the flakiest test:

```sh
windkeel schedule create \
  --name flaky-test-repair \
  --repo <repository-id> \
  --cron "0 3 * * *" --tz America/New_York \
  --title "Flaky-test repair ({{date}})" \
  --description "Find the test that failed intermittently most often in the last week and make it deterministic.

- [ ] the repaired test passes 20 consecutive runs
- [ ] no test is skipped or deleted to achieve it" \
  --spend-cap 5
```

Check what an expression means before storing it — the deployment evaluates it, so these are the
times the tick will use:

```sh
windkeel schedule preview "0 9 * * mon" --tz Europe/London
```

Then `windkeel schedule list`, `windkeel schedule update <id> --disable`, `windkeel schedule fire <id>` (one
task now; the cron's own next slot is unchanged) and `windkeel schedule delete <id>`.

`update` takes any of `--name`, `--repo`, `--cron`, `--tz`, `--title`, `--description <text|@file>`,
`--risk low|medium|high`, `--spend-cap <usd>`, `--wall-clock <seconds>`, `--enable` / `--disable`.
`--spend-cap none` and `--wall-clock none` clear a cap back to the deployment default. Only a new
cron, a new zone, or re-enabling moves the next slot.

## Cron syntax

Standard five fields — `minute hour day-of-month month day-of-week` — each a comma list of `*`, `n`,
`a-b`, with an optional `/step`. Months and weekdays take names (`jan`, `mon`); day-of-week 0 and 7
are both Sunday. Macros: `@hourly`, `@daily` (`@midnight`), `@weekly` (Sunday 00:00), `@monthly`,
`@yearly` (`@annually`).

- **Day-of-month and day-of-week** follow Vixie cron: when both are restricted, a day matches if
  *either* does (`0 9 1 * mon` = the 1st and every Monday); when either starts with `*`, both must.
- **Time zone**: an IANA name (`Europe/London`), default `UTC`. The expression is wall-clock time in
  that zone.
- **Spring forward**: a local time that does not exist that day fires once, at the equivalent
  instant after the jump (02:30 → 03:30). A nightly job is never skipped.
- **Fall back**: a local time that happens twice fires once, at the first occurrence, when the hour
  is fixed. When the hour field starts with `*` the job follows elapsed time, so `*/15 * * * *`
  keeps its fifteen minutes through the repeated hour.
- An expression that never matches a date (`0 0 31 4 *`) is refused with 422.

## Resolution: five minutes

The tick runs on a Vercel cron, `*/5 * * * *`, at `/api/schedules`. A slot fires on the first tick
at or after its time — **up to five minutes late** — and an expression finer than five minutes
coalesces to at most one task per tick (see below). The route authorises `Bearer $CRON_SECRET`
exactly as `/api/sweep` does, and refuses when the variable is unset. It takes the `schedules`
advisory lock, so `DATABASE_URL` must be the session-mode endpoint (ADR-0008 §1).

## What each slot does

Every slot is one `intake_delivery` row, key `schedule:{id}:{slotISO}`, so the ledger answers "why
did my schedule do nothing?" the same way it does for Slack or Linear:

| Outcome | `intent` | `reason` |
|---|---|---|
| A task was created | `create_task` | — |
| A slot missed during downtime, older than the latest | `ignore` | `coalesced` |
| A task this schedule created still has a non-terminal run | `ignore` | `previous_run_in_flight` |
| That previous run was accepted but never started (its enqueue failed), so it was enqueued again | `ignore` | `previous_run_requeued` |
| The repository is no longer granted to the organization | `ignore` | `repository_not_granted` |

- **Exactly once.** Two overlapping ticks cannot fire one slot twice: the advisory lock, the
  schedule row lock taken around the in-flight check and the task, the delivery key, and the task's
  (organization, source, reference) unique index each forbid it. The same row lock serialises two
  `fire` calls: one answers 202, the other sees its task and answers 409.
- **Missed slots coalesce.** After an outage the schedule fires once, for the latest missed slot,
  and records each earlier one as `coalesced` (at most 100 per schedule per tick; see Decisions).
- **No overlap.** "Non-terminal" is the run state machine's: `BLOCKED`, `WAITING_FOR_HUMAN` and
  `PR_READY` still count, because a second copy of open work is a duplicate PR. The slot is recorded
  and skipped; the schedule advances. **This is intended: a schedule pauses while the PR its last
  run opened is unmerged**, and every slot it skips meanwhile is in the ledger as
  `previous_run_in_flight`. Merge or close the PR (the run then ends) and the next slot fires.
- **A stranded run is re-enqueued, not waited on.** If every such run is still `CREATED` with no
  `workflow_run_binding` — its enqueue failed and nothing ever started it — the slot is recorded as
  `previous_run_requeued`, the run is handed to the workflow again (idempotent: `startRun` is
  guarded by the binding), and the schedule advances. Without this, one failed enqueue followed by a
  newer slot would stall the schedule for good. (The hourly stranded-run sweep is a backstop only.)
- **Failures retry, a bounded number of times.** A slot whose intake failed with a 5xx (the
  database, or handing the run to the workflow) is not advanced past; the next tick retries the
  same key, finds the task already written, and enqueues it. After **5** consecutive failures the
  slot is abandoned: `last_outcome` is `failed:<status>`, a log line tagged
  `schedule_slot_abandoned` names it, and the schedule advances to its next slot.
- `next_fire_at` then moves to the first slot strictly after the tick — unless the schedule was
  edited while the tick worked on it, in which case the edit's slot stands.

## Decisions

- **Work per tick is bounded.** Each schedule is claimed (`for update skip locked`), fired and
  advanced in short transactions of its own; nothing spans schedules, and no row lock is held while
  a run is enqueued. A tick stops claiming after **40 s** (the function's `maxDuration` is 60 s),
  after **200** schedules, or after **500** `coalesced` ledger rows in total; whatever it did not
  reach stays due and the next tick carries on.
- **Coalescing caps.** At most **100** `coalesced` rows per schedule per tick, and 500 per tick
  overall: an outage of a minutely schedule must not flood the ledger. Older missed slots past the
  cap are not recorded individually; the schedule still fires once, for the latest.

`{{date}}` in the title or description is the slot's date in the schedule's zone (`YYYY-MM-DD`);
`{{schedule}}` is its name.

## Who the task belongs to

Tasks are created by the organization's **`schedules` system actor** (`getSystemActor(db, orgId,
'schedules')`), never by the person who wrote the schedule — an automation does not act as a person
(ADR-0024 §2). The schedule records its author in `created_by_principal_id`; the task records the
system actor.

## API

Organization-scoped (`/v1/…` or `/v1/orgs/{orgId}/…`). Reads need `runs.read`, writes
`schedules.manage` (admin role).

| Method | Path | |
|---|---|---|
| `GET` | `/v1/schedules?cursor=&limit=` | list, newest first, paged like `/v1/tasks` |
| `POST` | `/v1/schedules` | create → 201 |
| `GET` | `/v1/schedules/{id}` | read |
| `PATCH` | `/v1/schedules/{id}` | change any field; a new cron/zone, or re-enabling, re-slots from now |
| `DELETE` | `/v1/schedules/{id}` | delete |
| `POST` | `/v1/schedules/{id}/fire` | one task now → 202 `{accepted, taskId, engineeringRunId, enqueued}`; 409 `run_in_flight` (or `run_requeued` when the previous run had never started and was enqueued again) |
| `GET` | `/v1/schedules/preview?cron=&timezone=&count=` | next fire times, nothing stored |

Body fields: `repositoryId`, `name`, `cron`, `timezone`, `title`, `description` (required on create
except `timezone`), `riskLevel`, `spendCapUsd`, `wallClockCapSeconds`, `enabled`. An invalid cron or
zone is 422 `invalid_cron` / `invalid_timezone` with the reason; a repository not granted to the
organization is 422 `repository_not_granted`. Every schedule in a response carries
`nextFireTimes`, the next three slots.
