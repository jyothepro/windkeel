# test/ — rules

Use the skill `.claude/skills/add-test`. Files run **concurrently** in separate processes
(`node --test test/*.test.js`), sharing one Postgres, `/tmp` and a workflow transport. If two
suites can't share something, the failure must say so — not show up as a timeout in a third file.

- **Postgres**: tests skip when `TEST_DATABASE_URL` is unset. Use `createMigratedDatabase()` and
  `dropMigratedDatabase()` for an isolated clone and schema per case. Tests of migrations
  themselves create and drop their own schema. Connect with that schema as `search_path`
  and `TEST_POOL` from `helpers.js`. `suite-isolation.test.js` enforces this.
- **Never** run tests against `.env`'s `DATABASE_URL`; `db-guard.js` refuses a non-local server unless `WINDKEEL_TEST_DB_ALLOW_REMOTE=1`. Local: the `docker compose` URL
  `postgresql://windkeel:windkeel@localhost:5432/windkeel`, or a local `windkeel_test` database.
- **Workflow runtime**: `workflowRuntime()` / `closeWorkflowRuntime()` from `workflow-runtime.js`.
  Importing it points `WORKFLOW_LOCAL_BASE_URL` at a refusal server; never unset it.
- **Temp dirs**: `tempDir()`; never a fixed path.
- **Seams**: drive the CLI with `runCli` / `runAdminCli`; use the fakes (`github-stub.js`,
  `*-fake.js`, `slack-fakes.js`) and conformance suites (`*-conformance.js`) rather than mocking
  internals.
- Tests import built code: `npm run build` first (`npm test` does it).
- `deployed-round-trip.test.js` and `sandbox-vercel.test.js` hit real services; run them only on
  purpose.

- **Coverage floor**: `test:ci` and `test:built` fail below `--test-coverage-lines/branches/functions`
  (91/83/91, with Postgres). After coverage rises, bump all three flags in both scripts in `package.json`.

Background: README § Tests.
