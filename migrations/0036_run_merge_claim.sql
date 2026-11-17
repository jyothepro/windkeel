-- The merge step's claim on its `run_merge` row (#371 review).
--
-- 1. `heartbeat_at` — set when the merge step claims a pending row and again before each GitHub
--    mutation (mark ready, merge). The stale-merge sweep (`sweeps/stale-merges.ts`) settles only a
--    row whose last sign of life — this, or `created_at` before any claim — is older than its bound,
--    and the step's heartbeat is guarded by `status = 'pending'`: a step whose row the sweep already
--    settled stops before it marks ready or merges. So the sweep never fails an attempt still in
--    flight, and an attempt it failed never merges afterwards.
-- 2. `merge_sent_at` — set, under the same guard, immediately before the merge `PUT`. A retry of the
--    step that finds it set and the pull request merged at the verified SHA by the same GitHub
--    account settles the row `merged` (GitHub accepted the merge, then the step died before
--    recording it) instead of refusing it as "PR is merged".

alter table run_merge
  add column heartbeat_at  timestamptz,
  add column merge_sent_at timestamptz;
