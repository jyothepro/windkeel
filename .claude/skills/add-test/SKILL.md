---
name: add-test
description: Add or change a test in Windkeel's test/ folder. Use when writing tests for factory, CLI, verification or API code, especially tests that use Postgres, the workflow runtime, or temp directories.
---

# Add a test

Rules: `test/AGENTS.md`. Steps:

1. **Seam.** CLI behaviour is tested through the CLI (`runCli` / `runAdminCli` in
   `test/helpers.js`) against fixture repos, asserting on output files and exit codes. Factory
   code is tested through its public modules and fakes (`test/github-stub.js`, `*-fake.js`,
   `test/factory-stack.js`). Reuse a conformance suite (`*-conformance.js`) when adding a provider.
2. **File**: `test/<area>-<subject>.test.js`, `node:test` + `node:assert/strict`, ESM. Import built
   code from `dist/` / `packages/*/dist/` the way neighbouring tests do.
3. **Postgres**: skip when `TEST_DATABASE_URL` is unset. Clone the migrated template with
   `createMigratedDatabase(schema)` in `test/migrated-db.js`, connect with the returned URL,
   `search_path` set to the unique schema and `TEST_POOL`, then close the pool and call
   `dropMigratedDatabase(schema)` in `after()`. Tests of migrations use a fresh schema and
   run migrations directly. See `test/api-audit.test.js`.
4. **Workflow runtime**: use `workflowRuntime()` / `closeWorkflowRuntime()` from
   `test/workflow-runtime.js`. Never leave `WORKFLOW_LOCAL_BASE_URL` unset.
5. **Temp files**: `tempDir(prefix)` from helpers, never a fixed `/tmp` path.
6. **Run**: `npm run build && node --test --test-force-exit test/<file>.test.js`, then the full
   `npm test` (files run concurrently; `test/suite-isolation.test.js` catches shared-state bugs).
7. **Red first** when fixing a bug: show the test failing before the fix.
