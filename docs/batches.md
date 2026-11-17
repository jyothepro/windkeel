# Batches: one change, many verified runs

A batch fans one ask out into many runs at once (#391,
[ADR-0036](adr/0036-batches-group-verified-runs-and-never-gate-them.md), *Proposed*). It is
**grouping, pacing and a roll-up — nothing else.** Every child is an ordinary task and run: its own
spend and time caps (ADR-0011), its own verification in a fresh sandbox (ADR-0004), its own
evidence and its own draft pull request. A batch never approves, merges, marks ready or produces
a verdict of its own; review and merge each pull request on its own, as always.

## Two kinds

| Kind | What you give | What each child is |
|---|---|---|
| `fanout` | one `repositoryId` and `items: [{ title, description, criteria? }]` | one sub-task of the change, on that repository |
| `multi_repo` | `repositories: [id, …]` and the batch's `title`, `description`, `criteria` | the same change on one repository (a migration) |

Criteria (the batch's, plus an item's own) are written into each child's description as an
`## Acceptance criteria` checklist, so the task records them exactly as the API and the GitHub
label do: extracted from the text, with `explicit` provenance (ADR-0012 §1). Nothing is ever
passed pre-approved. A child with no criteria takes the usual generate-then-approve route.

## How children start

Items start `pending`: rows, not runs. The dispatcher (`src/batches/dispatch.ts`) starts a child
only when there is room under **both** limits:

- the batch's `maxConcurrency` (1–50, default **3**), and
- the organization's `max_concurrent_runs` (`organization.max_concurrent_runs`; when null,
  `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS`, default **10**). This counts every run in the
  organization, batch or not, and is what protects the sandbox quota.

A child holds a slot in every non-terminal state **except `WAITING_FOR_HUMAN`**: once the verifier
has passed it and its draft pull request waits on a reviewer, the slot is free. Items start in
order (`ordinal`), oldest batch first.

Starting a child is the ordinary intake path (`createTaskFromIntake`): source `batch`, reference
`batch:{batchId}:{ordinal}`, created by the person who asked for the batch, the repository's grant
checked again at that moment (a grant withdrawn since is `skipped`, `repository_not_granted`). The
rows commit, then the run is enqueued; an enqueue that fails is healed by the stranded-created-runs
sweep like any intake's. A pending item is never a run, so that sweep never touches one.

The dispatcher runs:

1. right after `POST /v1/batches`, and after a resume;
2. when a child settles — a `batch` source notifier runs after every terminal or
   `WAITING_FOR_HUMAN` transition of a batch child (`src/batches/notifier.ts`, registered by the
   deployed flow function);
3. every five minutes on `/api/schedules`, as the safety net (worst case: a slot sits empty for
   five minutes).

## Spend

**The batch cap is required by default**: `batchSpendCapUsd` defaults to **$100**, and `null` (no
batch cap) needs `uncappedConfirmed: true` — or the API answers `422 uncapped_batch`.

Each child's own `spend_cap_usd` is its template cap (`spendCapUsd`, else ADR-0011's $25) **lowered
to what is left**: the batch cap, minus what the children have spent, minus what every
non-terminal child may still spend under its own cap. So everything that can still spend fits
inside the batch cap together, and each child is stopped by `checkCaps` like any run. With a $30
cap and $12 child caps, three children start with $12, $12 and $6.

A child **awaiting review keeps its budget reserved** even though it frees its slot: *Make changes*
takes the same run back to work under its own cap. A $10 batch whose $8 child spent $3 and waits on
review gives the next child $2, not $7. So a batch whose budget is all held by children awaiting
review **waits for reviewers** (merge, close or cancel one) before it starts more; it does not
stop or settle while any child holds a reservation.

When the children's spent total reaches the cap, the batch goes **`STOPPING`**,
`stop_reason = batch_spend_cap`: **children already running finish within their own caps; no new
child starts**; pending items are `skipped` (`batch_stopped`). When the last running child settles,
the batch settles. An uncapped batch still caps every child.

A small cap serialises its children: $20 with $25 child caps runs one at a time. That is the price
of a hard bound; `reservedUsd` and `remainingBudgetUsd` in the roll-up show it.

## The failure-ratio breaker

`stopOnFailureRatio` (above 0, at most 1; off by default): once **at least three** children have
settled and failed / settled reaches the ratio, the batch stops the same way
(`stop_reason = failure_ratio`). Failed means the child's own `FAILED` or
`MAX_REPAIR_ATTEMPTS_REACHED`. Zero failures never fires.

## Status

| Status | Means |
|---|---|
| `RUNNING` | Starting children as slots free |
| `PAUSED` | Nothing new starts; running children carry on. `resume` → `RUNNING` |
| `STOPPING` | Spend cap or failure ratio reached; running children finish, nothing new starts |
| `COMPLETED` | Every child succeeded: merged, or a draft pull request the verifier passed |
| `PARTIAL` | Some did, some did not (failed, cancelled, skipped) |
| `FAILED` | None did |
| `CANCELLED` | Cancelled: pending items skipped, children still working cancelled through the run-cancel path; a verified pull request already waiting on a reviewer is left as it is |

`stop_reason` (`batch_spend_cap`, `failure_ratio`, `cancelled`) stays on the batch after it settles.

Progress is **derived on read**, never stored: counts by each child's newest run state, verdict
counts, succeeded/failed/active/pending/skipped, and `totalCostUsd` = the SUM of every child run's
`engineering_run.cost` (a rerun of a child task counts too).

## API, CLI, console

- API: `POST /v1/batches`, `GET /v1/batches`, `GET /v1/batches/{id}`,
  `POST /v1/batches/{id}/pause|resume|cancel`, `GET /v1/runs?batch={id}` — see
  [control-plane-api.md](control-plane-api.md#batches). Reads need `runs.read`; writes need
  `batches.manage` (Admin, migration 0048).
- CLI:

  ```bash
  windkeel batch create --repos <id>,<id>,<id> --title "Bump eslint" --description @change.md \
    --criteria-file criteria.md --max-concurrency 2 --cap 40 --child-cap 10
  windkeel batch create --items items.json --repo <id> --title "Split the API module" --description "…"
  windkeel batch status <batch-id> --watch
  windkeel batch pause|resume|cancel <batch-id>
  ```

- Console: **Batches** in the sidebar — the list with each batch's progress and spend against its
  cap, and a detail page with verdict counts and every child linking to its run and pull request.
  Pause, resume and cancel appear only with `batches.manage`. There is no merge control.

## Configuration

| Variable | Default | |
|---|---|---|
| `WINDKEEL_BATCH_MAX_ITEMS` | `200` | Most items in one batch (`422 too_many_items` above it). Read by the API |
| `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS` | `10` | An organization's run ceiling when `organization.max_concurrent_runs` is null. Read wherever the dispatcher runs (API, flow function, cron) |

Both are optional. Set an organization's own ceiling with
`update organization set max_concurrent_runs = <n> where id = '<org>'` (no API yet).

## Not in v1

Model-proposed fanout splits behind an approval (#391 sub-task D); batches from Slack, Linear or
Jira; children that depend on each other's diffs; a batch label on pull requests; billing
roll-ups; environment snapshots for faster fan-out.
