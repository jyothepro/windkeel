-- The maker harness is part of the maker choice (ADR-0027 §1, #395).
--
-- `model_policy.harness` names the agent program that drives the maker (`codex`, `claude-code`) at
-- this layer. Null inherits it from the layer below — the organization default beneath a
-- repository override, and the operator's default (`ORQON_DEFAULT_MAKER_HARNESS`) beneath both.
-- Only a maker row has one: the checker is not an agent (ADR-0026 §8).
--
-- Whether the harness is enabled on this deployment, and whether it can call the row's provider,
-- is checked on write and again at intake (`422 harness_unavailable`, `harness_incompatible`). The
-- run snapshot freezes `{ id, version }` (`engineering_run.model_config.maker.harness`), so a policy
-- changed mid-run does not move a run onto another agent. `agent_run.worker_type` already records
-- the harness id; no column is added there.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

alter table model_policy
  add column harness text
    check (harness is null or harness ~ '^[a-z][a-z0-9-]{0,31}$');

alter table model_policy
  add constraint model_policy_harness_maker_only check (harness is null or role = 'maker');
