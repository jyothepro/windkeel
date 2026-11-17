# src/factory — rules

The factory: run state machine, stages, stores, sweeps, tenancy and the workflow engine. Terms:
[CONTEXT.md](../../CONTEXT.md). Applies to the sibling `src/*` subsystems too.

- **State machine** lives in `run-state-machine.ts` (ADR-0003). Add a state or transition only
  with an ADR. Nothing leaves a terminal state; recovery is a new run.
- **Stages** are `workflow/handlers/*.ts`, wired in `stage-wiring.ts` / `workflow/stage-deps.ts`.
  A stage that stops a run lands in an existing terminal state with a machine-readable reason
  (ADR-0011).
- **SQL lives in store modules** (`*-store.ts`, `stores/`). `npm run arch:check` enforces it for
  `src/factory/workflow` and the apps; follow it everywhere new. Unqualified table names only.
- **Size**: `tenancy.ts`, `workflow/vercel.ts` ≤ 800 lines; any file under `tenancy/` or
  `workflow/` ≤ 1000. Split by responsibility before you hit it.
- **Public surface**: apps import `@windkeel/factory/<name>` (`src/public/*.ts`, `package.json`
  `exports`), never `dist/` internals. A new export goes in `src/public/` and `exports`.
- **Trust boundary**: maker-side modules (knowledge, playbook maker instructions, screenshots,
  batches, guidance) must never be imported by verification code or change a verdict.
  `test/verification-boundary.test.js` checks it (ADR-0032/0033/0035/0036).
- **No secrets in sandboxes**: model keys are brokered at egress, git tokens scoped per role
  (ADR-0014). Never add an env var that carries a key into a sandbox.
- **Spend is the cost ledger** (`cost-ledger.ts`, `cost_event`). Never store a second spend figure
  (ADR-0037).
- **Sweeps** (`sweeps/`) never fail or block a run. Register new ones in `docs/sweeps.md`.
- Every change of state that a person might audit writes the audit log in the same transaction
  (ADR-0030).
