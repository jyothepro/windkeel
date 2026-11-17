-- A run that nobody approved stops for its own reason (#262).
--
-- The approval gate had no bound of its own. What ended a never-approved run was ADR-0011's
-- wall-clock cap, measured from `started_at` with no regard for what the run was doing — so a
-- run holding no sandbox, no session and no model spend reached `FAILED` with
-- `stop_reason = 'wall_clock_cap'` slightly under two hours after it started, and `/orqon
-- approve` afterwards answered by naming a state.
--
-- The ADR-0011 amendment on #262 stops the wall clock while a run is parked and gives the gate
-- its own deadline. That needs a stop reason that is not a lie: `approval_expired`, landing in
-- `CANCELLED` rather than `FAILED`, because nothing failed — a person was asked and did not
-- answer. `terminalStateFor` in `src/factory/rails.ts` is the other half of this.
--
-- No existing row changes: no run has ever carried this reason, because until now it could not.

alter table engineering_run drop constraint if exists engineering_run_stop_reason_check;

alter table engineering_run add constraint engineering_run_stop_reason_check
  check (stop_reason in (
    'spend_cap', 'wall_clock_cap', 'stuck', 'repair_cap', 'approval_expired', 'error'
  ));
