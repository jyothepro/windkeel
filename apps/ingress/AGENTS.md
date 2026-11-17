# apps/ingress — rules

The control-plane HTTP surface on Vercel (project `orqon-backend`, orqon.vercel.app): `/v1` API,
GitHub webhook, other intake doors, schedules and the hourly sweep. Terms:
[CONTEXT.md](../../CONTEXT.md). API reference: [docs/control-plane-api.md](../../docs/control-plane-api.md).
Adding an endpoint: skill `.claude/skills/add-endpoint`.

| Path | What |
| --- | --- |
| `api/*.ts` | Vercel function entries: `v1`, `webhook`, `intake`, `schedules`, `sweep`, `preflight`. Each is its own bundle |
| `src/api/route.ts` | The route table: method, pattern, name, auth and permission. An endpoint exists only if it's here |
| `src/api/router.ts` | Auth, dispatch and the cross-cutting rules. Nothing endpoint-specific |
| `src/api/*.ts` | Handlers by area (`runs.ts`, `tasks.ts`, `run-commands.ts`, …), re-exported by `handlers.ts` |
| `src/api/common.ts` | `ApiResult`, refusals (`notFound`, `conflict`, …), `auditAfter`, `commandResult` |
| `src/stores/` | The only place ingress writes SQL (`npm run arch:check`) |
| `src/handler.ts`, `src/*-intake.ts` | Intake sources on the shared pipeline (`src/intake/pipeline.ts`) |
| `src/schema-gate.ts` | Answers `503 schema_behind` when this deployment is ahead of the database |

- **Ingress meets the factory through data** (ADR-0020 §3). Write a task, intent or signal row;
  never wire or run a stage. Import the factory only as `@windkeel/factory/<name>`
  (`src/public/*.ts`), never `dist/` or `src/` paths. `arch:check` and `invariant:check` enforce it.
- **Commands answer `202` or a named refusal** (ADR-0023 §2). A command records an intent the
  factory acts on; it never waits for the work.
- **Tenancy in the store layer** (ADR-0024 §8). Look rows up inside the caller's organization
  (`runInOrganization`, …): a row in another organization is `404`, not `403`.
- **Every organization route declares a permission** (ADR-0030). `test/api-routing.test.js` checks
  it. Public routes are a fixed list in that test (health, device login, billing webhook,
  signup); adding one needs a reason that test records.
- **Audit what a person might ask about** (`auditAfter`, in the change's transaction).
- **Verify before persisting.** A webhook's signature is checked over the raw bytes before
  anything is parsed or stored (ADR-0009 §6, `src/signature.ts`).
- **Secrets surface is fixed** (ADR-0023 §1). Adding a secret ingress holds needs an ADR amendment
  (`test/adr.test.js` holds the current ones).
- **Types come from `@windkeel/api-contract`**, shared with console and CLI. Don't declare response
  shapes locally.
- **Size**: `src/api/handlers.ts` ≤ 800 lines, any `src/api/` file ≤ 1000 (`arch:check`).
- **No source comments** (ADR-0041, `npm run lint`).
- Env changes need a Vercel redeploy (`npx -y vercel@latest`). Tests import
  `apps/ingress/dist/`, so `npm run build` first.
