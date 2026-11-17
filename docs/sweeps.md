# The sweeps, and how they get scheduled

Windkeel has seven periodic maintenance jobs. None is part of a run, none may fail a run, and all
had to keep working after the worker container was deleted (#200). They now do, on an
**hourly Vercel cron** at `/api/sweep`.

| Sweep | What it does | Cadence | Source |
|---|---|---|---|
| **Evidence retention** | ADR-0015's outcome-tiered pruning of stored evidence packages | hourly | `src/factory/sweeps/retention-sweep.ts` |
| **Sandbox reaper** | destroys sandboxes no process holds a handle to (#198) | hourly | `src/factory/sweeps/sandbox-reaper.ts` |
| **Signal recovery** | restarts a run holding a signal nothing is coming to read (#269) | hourly | `src/factory/sweeps/signal-recovery.ts` |
| **Stalled runs** (`stalled-runs`) | re-dispatches a run whose driving step stopped making progress — binding at `queued`/`running`/`retrying`/`waiting`, heartbeat older than 30 min — and fails it by name after 3 re-dispatches (#340) | hourly | `src/factory/sweeps/stalled-runs.ts` |
| **Stranded created runs** | re-enqueues a run still `CREATED` with no `workflow_run_binding` 10 min after creation — an enqueue that failed and was never healed by a retry (#306) | hourly | `src/factory/sweeps/stranded-created-runs.ts` |
| **Intake delivery retention** | deletes `intake_delivery` rows with `intent = 'ignore'` older than 30 days; acted-on rows are kept as the idempotency record (#293, ADR-0025 §4) | hourly | `src/factory/sweeps/intake-delivery-retention.ts` |
| **Audit retention** (`audit-retention`) | deletes each account's `audit_event` rows past its retention (`account_security_policy.audit_retention_days`, else `WINDKEEL_AUDIT_RETENTION_DAYS`, default 90) through `audit_event_purge`, recording `audit.retention_swept`; prunes `session_activity` older than 31 days (#393, ADR-0030) | hourly | `src/factory/sweeps/audit-retention.ts` |
| **Audit sink** (`audit-sink`) | with `WINDKEEL_AUDIT_WEBHOOK_URL` and `WINDKEEL_AUDIT_WEBHOOK_SECRET` set, POSTs each account's new audit events, HMAC-signed, at least once; the per-account cursor moves only on 2xx (#393, ADR-0030) | hourly | `src/factory/sweeps/audit-sink.ts` |
| **Jira webhook refresh** (`jira-webhook-refresh`) | for active Jira connections (at most 50 per tick, soonest to expire first, none started after 120 s; each Jira call 10 s): refreshes a webhook expiring within 7 days, re-registers one Jira dropped or whose routes changed; failures go to `jira_webhook.last_error`, never out of the sweep (#300, `docs/integrations.md` § Jira) | hourly | `src/factory/sweeps/jira-webhook-refresh.ts` |

The **schedule tick** (M8-4) is not a sweep and is not in this table: it has its own route,
`/api/schedules`, on its own five-minute cron, with the same `CRON_SECRET` authorisation and its
own advisory lock (`schedules`). See [schedules.md](schedules.md).

The **batch dispatcher's safety net** (#391) rides the same five-minute route: after the schedule
tick, `dispatchBatches` (under its own `batches` advisory lock) fills any slot a settled batch child
freed without its notifier dispatching. A pending batch item is a row, not a run, so the stranded
created-runs sweep below never sees one. See [batches.md](batches.md).

The third is newer and answers a question the other two do not. `signal()` already restarts a run
whose execution had ended *before* the signal arrived. It cannot help with the opposite order —
the signal arrives, the wake succeeds, and then the queue delivery carrying that wake fails and
the execution ends. Everything that could have noticed has already run, and no further signal is
coming, because the event that would have produced one has been and gone. Something has to look
again later, and that is what a sweep is.

It asks about a run only when that run holds a durably unconsumed signal, and it does not decide
anything itself: each candidate goes to the provider's `recoverStranded`, which restarts a
`waiting` binding whose execution is provably terminal and refuses everything else. One copy of
that policy, in the place it belongs.

The stranded-run sweep closes a gap every intake shares. Rows are committed before the enqueue
(ADR-0007 §4), and a failed enqueue is healed by the provider retrying — but a retry can be refused
(Linear's 1 min / 1 h / 6 h schedule mostly lands outside its 5-minute replay window), late, or
never sent (an API caller that gave up). The run then sits in `CREATED` and nothing notices. The
sweep takes runs that are `CREATED`, older than 10 minutes, younger than 7 days (so a first tick
does not resurrect abandoned rows), and have **no binding** — the claim `startRun` writes before it
starts anything, so "no binding" is exactly "no enqueue ever succeeded". A bound run is left to its
execution and the other sweeps. It hands each candidate to `startRun`, which is idempotent, logs
each re-enqueue with the run id and source type, bounds a tick at 50 runs, and runs in its own try
under its own advisory lock (`stranded-created-runs`), even when an earlier sweep threw. Replay
windows stay strict; this is the heal.

### Stalled runs

The gap: a run is carried by one durable execution, a loop of `tick` steps. If the step driving
it dies **without throwing** — the function is killed, times out, or is caught in a deploy
rollover — and the platform does not redeliver it, nothing picks the run up again.
`reclaimsExpiredJobs` is `false` because that redelivery has never been observed (Spike C), and
the provider's own recovery paths refuse a `running` binding on purpose. Before #340 the run sat
at its state forever, and the sandbox reaper eventually destroyed its sandbox at `expires_at`.

**The heartbeat** is `workflow_run_binding.updated_at`: every tick touches it first, and every
phase change touches it again. A live execution therefore never leaves it untouched for longer
than one step (800 s, the platform's cap) plus one poll sleep (60 s) — about 14.3 minutes.

**The threshold** is N × the poll interval with **N = 30: 30 minutes** at the default 60 s. That
is over twice the worst live gap, so a slow step or a late queue is not raced, and it is well
inside the sandbox's 4 h TTL, so the agent's sandbox and session are still there to reattach to.
It has a floor of 2 × (step cap + poll interval), so a longer configured poll interval moves it
up rather than letting the sweep race a live run. Worst-case time to recovery: 30 min + 1 h cron.

**What it does** with each candidate is the provider's `reclaimStalled`:

- a compare-and-set on staleness — one conditional `update` that a live tick touching the row
  first makes match nothing — that issues a **new `execution_token`**, then starts a new
  execution carrying it. The new execution's first tick runs the run's handler, which reattaches
  the sandbox and the agent session, or fails the run by name when it cannot. One recovery path:
  the normal one.
- the token **fences** the old execution. Every tick checks it first (`claimTick`), and again
  before committing a handler's outcome; a mismatch stands the old execution down without a write.
- after **3** re-dispatches (`reclaim_count`), a run that stalls again is **failed**:
  `stop_reason = error`, a reason naming the state it stalled in, a recorded transition. The
  sandbox reaper then releases its sandbox; this sweep runs before the reaper for that reason.
- a run that is already terminal but whose binding still claims a live execution is
  **released** (binding marked `finished`), never restarted.

`waiting` is included. A run parked for approval or a signal may wait for days, but a live
execution re-ticks it every 300 s (`WAIT_SLEEP_MS`), touching the heartbeat each time — so a long
wait is never a candidate and never counts against the bound. A stale `waiting` binding is an
execution that died; the new execution's first tick runs the state's handler, which returns `wait`
again, so the run resumes waiting and no stage re-runs. `reclaim_count` is reset whenever the run
commits a transition, so the bound means "3 re-dispatches in one state". Bounded at 25 runs per
tick, own advisory lock (`stalled-runs`), own try.

**The residual risk** is a step that genuinely runs past the platform's 800 s cap — which the
platform does not allow — or a clock skew between database and nothing else (the comparison is
`now()` on both sides, in Postgres). A step that somehow did outlive its ownership still cannot
commit: the check before the commit stands it down.

They live in the same directory on purpose. The retention sweep used to live inside
`apps/worker`, which recorded that it "was implemented, tested, and called by nothing" before
being wired there — it had already been orphaned once, and deleting the container it lived in was
exactly how that would have happened a second time. It did not, because the scheduler landed
before the deletion rather than after.

## They are not the normal path

Worth stating before the scheduling, because it changes what the schedule has to guarantee.

- ADR-0015's retention is the *only* mechanism that prunes evidence. If it never runs, storage
  grows forever and the policy is real in code and inert in production.
- The reaper is a **backstop**. #197 tears a sandbox down at the moment a cap fires, and that is
  where the obligation belongs. The reaper exists for the paths with no cleanup: a hard cancel, a
  crashed step, an operator killing a deployment. A cap that stops the agent and leaves a billing
  microVM behind has not capped spend.

So a missed tick is a cost problem, not a correctness problem — for either. That is what makes
the choice below reasonable.

## The decision: a cron invocation, not a durable workflow

Both were plausible. `sleep` has no limit inside a Vercel Workflow run, so a workflow that slept
and swept in a loop would work. It is the wrong shape here:

- **A workflow is a run that must be started, watched, and restarted.** If it completes, fails, or
  is cancelled — by a deploy, by an operator, by a bug — the sweeping stops, and nothing notices,
  because the thing that would have noticed was the sweep. A cron invocation is stateless: it
  either fires or it does not, and "it did not fire" is a question a platform can answer.
- **Workflow run data is retained 7 days on Pro.** A sweeping workflow's own history — the thing
  you would look at to answer "has this been running?" — expires while the workflow is still
  running. Its observability is worst exactly where it matters most.
- **Neither sweep needs durability *within* a tick.** Both are designed to be interrupted: the
  retention sweep stops at a package boundary and repairs a partial prune on the next tick, and
  the reaper is idempotent with an already-gone sandbox counted as success. Durable execution
  buys nothing they do not already have.
- **A tick is short.** The retention sweep bounds itself; the reaper's work is per-workspace and
  each item is one provider call. Neither approaches a function's ceiling, and if either ever
  did, the fix is to bound the batch rather than to make the job durable.

So: **a scheduled invocation that runs both sweeps, under their advisory locks.**

### What that invocation must do

1. **Connect in session mode.** Not negotiable. Both sweeps take a Postgres advisory lock, and
   **the transaction pooler silently breaks advisory locks** — verified empirically, two pooled
   connections both acquired the same lock. Silently: no error, no warning, just two sweeps
   running at once. ADR-0008 §1 already requires a direct connection; this is the case where
   ignoring it produces no symptom until a double delete.
2. **Take the locks and tolerate contention.** `withSweepLock` reports `contended` as a normal
   outcome. Two invocations overlapping is expected — a slow tick and a punctual schedule — and
   the second doing nothing is correct behaviour, not a failure to report.
3. **Never let a sweep failure become a failed deployment.** Both sweeps catch their own errors
   per item; the invocation should log and return success. A red maintenance job that fires every
   minute trains everyone to ignore it.
4. **Run them in one invocation or two, as convenient.** Their locks are keyed separately (by
   sweep name *and* schema), precisely so a reaper tick never waits behind a long evidence prune.

### Where the schedule actually lives

`apps/ingress/api/sweep.ts` is the route; `apps/ingress/build-vercel-output.mjs` emits it and
declares the cron. The schedule is in the **Build Output API's `config.json`**, not `vercel.json`
— this project's build *is* the Build Output API, so a `crons` block in `vercel.json` would look
correct in the repository and schedule nothing. The declaration *merges* into that file rather
than overwriting it, because clobbering the SDK's workflow-dispatch routes would stop every run.

The route is authorised by `CRON_SECRET` with a constant-time comparison, and it **fails closed
when the variable is absent**. A deployment that has not set it is inert rather than open, and
the hourly 401 in the cron log is how that shows.

`windkeel reap` runs the reaper on demand through the API (`POST /v1/sandboxes/reap`), and `windkeel reap
--dry-run` lists what it would destroy and why (`GET /v1/sandboxes/reapable`) — what an operator
reaches for when they do not want to wait an hour. Both are the same `reapSandboxesLocked` under the
same advisory lock, so a manual reap during a tick answers `409 sweep_in_progress` rather than racing
it.

### Why a cron and not a Workflow that sleeps

#200 left the choice open and asked for the reasoning. A `sleep`-based Workflow has no duration
limit and would work, but it turns a periodic *maintenance* job into a durable execution that
must be started, observed and restarted — and if it ever dies, nothing restarts it, which is
exactly the failure being fixed. A cron is declarative: the schedule lives in the deployment,
survives redeploys, and cannot be left un-started. The sweeps were already designed for it, each
idempotent and each taking its own lock, so the scheduler supplies nothing but a heartbeat.

The advisory locks are what make an overlap safe, and overlap is expected rather than
exceptional: Vercel makes no single-delivery promise for crons, deployments overlap during a
rollout, and an operator may curl the route by hand.

## Usage reporting (ADR-0037, #394)

`reportPendingUsageLocked` (`src/billing/report.ts`), on the same hourly `/api/sweep`, under its own
advisory lock (`billing-usage-report`). For every organization whose account is billed through the
configured provider, it sends the increment of the month's billable total since the last report —
integer micro-USD, keyed `org:YYYY-MM:seq` — after first resending any report a previous sweep could
not send. Events younger than a minute wait for the next sweep. It also records budget alerts, once
per threshold per month. Skipped with `WINDKEEL_BILLING_PROVIDER=none`; a refused Stripe configuration is
a failure in the sweep's response, by name.
