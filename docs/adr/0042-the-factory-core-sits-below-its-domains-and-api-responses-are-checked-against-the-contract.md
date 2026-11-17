# ADR-0042: The factory core sits below its domains, and API responses are checked against the contract

- Status: Accepted
- Date: 2026-11-07
- Relates: [ADR-0023](0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md) (the API whose responses the contract describes),
  [ADR-0032](0032-repository-knowledge-shapes-the-maker-never-the-verifier.md) (now checked through the whole import graph),
  [ADR-0037](0037-usage-billing-and-organization-budgets.md) (billing admission and budgets, now injected into the core)

## Context

Two rules were stated nowhere and broken in practice. The factory core imported the domains built on
it: run creation, the spend rails and the run service reached into `billing/` and `intake/`, so the
core could not be read, tested or reused without them. And `@windkeel/api-contract` described the API
only as types: no server or client ever checked a real response against it, so the contract could
drift from what ingress sends without anything failing.

The ADR-0032 check also followed direct imports only. Through the whole graph, the verifier stage
reached the knowledge modules (via post-loop learning in `loop-exit.ts`); no knowledge reached the
verdict, but nothing would have caught it if it had.

## Decision

**The core never depends on the layers above it, and every API response has a schema that the test
suite enforces at runtime.**

1. **Layering.** The core is `src/factory/` except `workflow/` and `sweeps/`, which orchestrate. The
   core never value-imports `src/{integrations,intake,billing,batches,schedules}`; those may import
   the core. Shared leaves (`factory/log.ts`, `factory/config/*`) live in the core. A capability the
   core needs from a domain is a port the caller passes in: `RunAdmission` (task creation),
   `OrganizationBudgetGate` (spend rails, which throw when a budget is set and no gate is given),
   `RunOutcomeListener` (installed by `intake/notifiers.ts`), `StageDeps.afterRepairLoop` (post-loop
   learning, wired in `stage-wiring.ts`). Checked by `arch:check` rule 9.
2. **Response contract.** `@windkeel/api-contract` exports `routeResponses`: one schema per ingress
   `RouteName`, with file and redirect routes marked as such and no `z.any()`/`z.unknown()`. With
   `WINDKEEL_VALIDATE_RESPONSES=1` the router parses every 2xx JSON body and answers
   `500 contract_violation` naming the route and paths on a mismatch. `test/helpers.js` turns it on,
   so every API test is a contract test; production leaves it off. Checked by `arch:check` rule 8.
3. **ADR-0032 transitively.** `invariant:check` walks the verifier stage's whole import graph; no
   knowledge module may appear in it.

## Consequences

- The core builds and tests without billing or intake; the composition roots
  (`stage-wiring.ts`, `workflow/rails-gate.ts`, `billing/admitted-runs.ts`) bind the real domains.
- A port left unbound must fail loudly, never skip: the budget gate throws. `afterRepairLoop` is
  optional, so a second `StageDeps` builder must bind it or that path learns nothing.
- Schemas are loose objects: extra fields pass, missing or mistyped required fields fail.
- Writing the schemas found three drifts, all in the old contract: custom role keys on members and
  invitations, a null inviter, a null role after a service principal is deleted.
- Server-sent event frames are not validated; they are served outside the router.
