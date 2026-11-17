---
name: add-endpoint
description: Add or change an endpoint on Windkeel's /v1 control-plane API, from the shared contract through ingress to the console and CLI. Use when a change needs a new route, a new field in a response, a new command, or the user says "endpoint", "API route" or "expose this in the API".
---

# Add an API endpoint

Rules: `apps/ingress/AGENTS.md`, `packages/AGENTS.md`. Reference: `docs/control-plane-api.md`.
Example to copy: `GET /v1/runs/:runId/cost` (`runCost` in each file below).

1. **Decide the shape.** A read, or a command? A command records an intent and answers `202`
   or a named refusal (ADR-0023 §2); it never waits for the factory. Organization route or
   account route (`/v1/account/…`)? Which permission (`Permission` in
   `apps/ingress/src/api/route.ts`, owned by `src/factory/tenancy.ts`)? If none fits, adding one
   is a roles change (ADR-0030); say so.
2. **Contract first.** Put the response view in `packages/api-contract/src/views.ts` and any
   shared enum or zod schema in `packages/api-contract/src/schemas.ts`. Ingress, console and CLI
   all import it; never declare the shape locally (`npm run arch:check`, rule 1).
3. **Route.** In `apps/ingress/src/api/route.ts` add the name to `RouteName` and one row to
   `ROUTES` with an auth preset (`READ`, `WRITE`, …, or `{ permission }`). Then dispatch it in the
   `switch` in `apps/ingress/src/api/router.ts`. Nothing else goes in the router.
4. **Handler.** Write it in the area file under `apps/ingress/src/api/` (`runs.ts`, `tasks.ts`, …),
   which `handlers.ts` re-exports. Pattern:
   - look the row up inside `scope.organizationId` (`runInOrganization`, …): missing or in
     another organization is `notFound(…)`, never `403`;
   - return `ok(…)` or a refusal from `apps/ingress/src/api/common.ts`;
   - a command that changes something a person may ask about calls `auditAfter` in the same
     transaction;
   - new SQL goes in a store (`apps/ingress/src/stores/` or a factory `*-store.ts` reached
     through `@windkeel/factory/<name>`), never inline (`arch:check`, rule 4).
   Keep `handlers.ts` ≤ 800 lines and any `src/api/` file ≤ 1000 (`arch:check`, rule 3).
5. **Factory code it needs** comes through `src/public/<name>.ts` and the root `package.json`
   `exports`. Ingress never wires or runs a stage (`npm run invariant:check`).
6. **Tests.** Add cases to the closest `test/api-*.test.js` (`test/api-endpoints.test.js` for
   run and task reads). Cover: success, another organization's id is `404`, and a principal
   without the permission is refused. `test/api-routing.test.js` checks the route table itself;
   a new public route must be added to its fixed list with a reason. Skill: `.claude/skills/add-test`.
7. **Callers.**
   - Console: a function in `apps/console/lib/api-*.ts` (re-exported by `apps/console/lib/api.ts`)
     plus a fixture in `apps/console/lib/fixtures.ts` for the offline path.
   - CLI, if people will script it: `packages/cli/src/client/api.ts` and a command in
     `packages/cli/src/commands/`. Flags and exit codes are public; keep them compatible.
8. **Docs.** A row in the right section of `docs/control-plane-api.md` (method, path, what it
   returns or refuses).
9. **Check.** Run:

   ```bash
   npm run build && node --test --test-force-exit test/api-routing.test.js test/<your-api-test>.test.js
   ```

   then `npm run arch:check`, `npm run invariant:check`, `npm run typecheck` and `npm run lint`.
   Ingress env changes need a Vercel redeploy of `orqon-backend`.
