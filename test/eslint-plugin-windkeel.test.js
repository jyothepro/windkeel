import { after, describe, it } from "node:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { rules } from "../tools/eslint-plugin-windkeel/index.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = after;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run("windkeel/no-comments", rules["no-comments"], {
  valid: [
    { code: "#!/usr/bin/env node\nconst a = 1;" },
    { code: "// eslint-disable-next-line no-console\nconsole.log(1);" },
    { code: "/* eslint-disable no-console */\nconsole.log(1);" },
    { code: "// @ts-expect-error untyped fixture\nconst a: number = 'x';" },
    { code: "// @ts-ignore\nconst a = 1;" },
    { code: "/// <reference types=\"node\" />\nconst a = 1;" },
    { code: "const url = 'https://example.com/a//b'; const re = /\\/\\//;" },
  ],
  invalid: [
    { code: "// why\nconst a = 1;", errors: [{ messageId: "banned" }] },
    { code: "/** Doc. */\nexport function f() {}", errors: [{ messageId: "banned" }] },
    { code: "const a = 1; // trailing", errors: [{ messageId: "banned" }] },
    { code: "const a = 1 /* inline */ + 2;", errors: [{ messageId: "banned" }] },
    { code: "const el = <div>{/* jsx */}</div>;", errors: [{ messageId: "banned" }] },
    { code: "// TODO: eslint-disable later\nconst a = 1;", errors: [{ messageId: "banned" }] },
    { code: "// Copyright 2026 Windkeel\nconst a = 1;", errors: [{ messageId: "banned" }] },
  ],
});

tester.run("windkeel/no-direct-run-status-write", rules["no-direct-run-status-write"], {
  valid: [
    { code: "await updateEngineeringRun(pool, id, { stopReason: 'stuck' });", filename: "/repo/src/factory/workflow/handlers/verifying.ts" },
    { code: "await updateEngineeringRun(client, id, { status: to });", filename: "/repo/src/factory/run-service.ts" },
    { code: "await repo.updateEngineeringRun(pool, id, { finalVerdict: 'pass' });", filename: "/repo/src/factory/x.ts" },
    { code: "await pool.query(`update engineering_run set stop_reason = $2 where id = $1`);", filename: "/repo/src/factory/x.ts" },
    { code: "await pool.query(`update run_merge set status = $2 where id = $1`);", filename: "/repo/src/factory/run-merge.ts" },
    { code: "await pool.query(`update engineering_run set stop_reason = $2 where status = $3`);", filename: "/repo/src/factory/x.ts" },
    { code: "await pool.query(`update engineering_run set stop_reason = $2 returning status = $3`);", filename: "/repo/src/factory/x.ts" },
    { code: "await pool.query(`update engineering_run set stop_reason = (select reason from other_run where status = $2)`);", filename: "/repo/src/factory/x.ts" },
  ],
  invalid: [
    { code: "await updateEngineeringRun(pool, id, { status: 'COMPLETED' });", filename: "/repo/src/factory/x.ts", errors: [{ messageId: "call" }] },
    { code: "await repos.updateEngineeringRun(pool, id, { 'status': next });", filename: "/repo/src/x.ts", errors: [{ messageId: "call" }] },
    { code: "await pool.query(`update engineering_run set status = $2 where id = $1`);", filename: "/repo/src/factory/x.ts", errors: [{ messageId: "sql" }] },
    { code: "await pool.query('UPDATE engineering_run SET finished_at = now(), status = $2');", filename: "/repo/src/x.ts", errors: [{ messageId: "sql" }] },
    { code: "await pool.query(`update engineering_run set stop_reason = (select reason from other_run where status = $2), status = $3`);", filename: "/repo/src/x.ts", errors: [{ messageId: "sql" }] },
    { code: "await pool.query(`update engineering_run set (stop_reason, status) = ($2, $3)`);", filename: "/repo/src/x.ts", errors: [{ messageId: "sql" }] },
    { code: "await pool.query(`update engineering_run set stop_reason = case when stop_reason is distinct from $2 then $2 else null end, status = $3`);", filename: "/repo/src/x.ts", errors: [{ messageId: "sql" }] },
  ],
});

tester.run("windkeel/flow-imports-only-sleep", rules["flow-imports-only-sleep"], {
  valid: [
    {
      code: "import { sleep } from 'workflow';\nimport type { X } from './x.js';\nasync function step() { 'use step'; const m = await import('./runner.js'); return m; }\nexport async function flow() { 'use workflow'; await sleep('1s'); await step(); }",
    },
    { code: "import { Pool } from 'pg';\nexport async function notAFlow() { return Pool; }" },
    { code: "import { type Y } from './y.js';\nexport async function flow() { 'use workflow'; }" },
  ],
  invalid: [
    {
      code: "import 'workflow';\nexport async function flow() { 'use workflow'; }",
      errors: [{ messageId: "staticImport" }],
    },
    {
      code: "import { Pool } from 'pg';\nexport async function flow() { 'use workflow'; return Pool; }",
      errors: [{ messageId: "staticImport" }],
    },
    {
      code: "import { sleep, start } from 'workflow';\nexport async function flow() { 'use workflow'; await sleep('1s'); return start; }",
      errors: [{ messageId: "staticImport" }],
    },
    {
      code: "export { helper } from './helper.js';\nexport const flow = async () => { 'use workflow'; };",
      errors: [{ messageId: "staticImport" }],
    },
    {
      code: "export async function flow() { 'use workflow'; const m = await import('./runner.js'); return m; }",
      errors: [{ messageId: "workflowDynamicImport" }],
    },
  ],
});

const pure = { pureFiles: ["src/factory/rails.ts"] };
tester.run("windkeel/no-ambient-nondeterminism", rules["no-ambient-nondeterminism"], {
  valid: [
    { code: "const t = Date.now();", filename: "/repo/src/factory/run-service.ts", options: [pure] },
    { code: "export function deadline(since: Date, s: number) { return new Date(since.getTime() + s * 1000); }", filename: "/repo/src/factory/rails.ts", options: [pure] },
    { code: "async function step() { 'use step'; return Date.now(); }\nexport async function flow() { 'use workflow'; return step(); }", filename: "/repo/src/f.ts", options: [pure] },
    { code: "export async function flow() { 'use workflow'; async function inner() { 'use step'; return Math.random(); } return inner(); }", filename: "/repo/src/f.ts" },
  ],
  invalid: [
    { code: "export const now = () => Date.now();", filename: "/repo/src/factory/rails.ts", options: [pure], errors: [{ messageId: "banned" }] },
    { code: "export const now = () => new Date();", filename: "C:\\repo\\src\\factory\\rails.ts", options: [pure], errors: [{ messageId: "banned" }] },
    { code: "export const id = () => crypto.randomUUID();", filename: "/repo/src/factory/rails.ts", options: [pure], errors: [{ messageId: "banned" }] },
    { code: "import { randomUUID } from 'node:crypto';\nexport const id = () => randomUUID();", filename: "/repo/src/factory/rails.ts", options: [pure], errors: [{ messageId: "banned" }] },
    { code: "export const later = (f: () => void) => setTimeout(f, 10);", filename: "/repo/src/factory/rails.ts", options: [pure], errors: [{ messageId: "banned" }] },
    { code: "export async function flow() { 'use workflow'; return Math.random(); }", filename: "/repo/src/f.ts", errors: [{ messageId: "banned" }] },
    { code: "export async function flow() { 'use workflow'; return performance.now(); }", filename: "/repo/src/f.ts", errors: [{ messageId: "banned" }] },
  ],
});

tester.run("windkeel/console-no-server-imports", rules["console-no-server-imports"], {
  valid: [
    { code: "import { Pool } from 'pg';", filename: "/repo/src/factory/x.ts" },
    { code: "import { time } from '../../lib/format.ts';", filename: "/repo/apps/console/app/runs/page.tsx" },
    { code: "import '../../../design/windkeel.css';", filename: "/repo/apps/console/app/layout.tsx" },
    { code: "import { createServerClient } from '@supabase/ssr';", filename: "/repo/apps/console/lib/auth.ts" },
  ],
  invalid: [
    { code: "import type { Pool } from 'pg';", filename: "/repo/apps/console/lib/api.ts", errors: [{ messageId: "serverPackage" }] },
    { code: "import { advanceRun } from '@windkeel/factory/dist/factory/run-service.js';", filename: "/repo/apps/console/lib/api.ts", errors: [{ messageId: "serverPackage" }] },
    { code: "import { RUN_STATES } from '../../../src/factory/run-state-machine.js';", filename: "/repo/apps/console/lib/run-states.ts", errors: [{ messageId: "outsideConsole" }] },
    { code: "export * from '../../ingress/src/api/router.js';", filename: "/repo/apps/console/lib/x.ts", errors: [{ messageId: "outsideConsole" }] },
    { code: "const m = await import('@aws-sdk/client-s3');", filename: "/repo/apps/console/lib/x.ts", errors: [{ messageId: "serverPackage" }] },
  ],
});

tester.run("windkeel/reviewer-output-floor", rules["reviewer-output-floor"], {
  valid: [
    { code: "export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;" },
    { code: "const body = { model, max_tokens: maxOutputTokens };" },
    { code: "const body = { max_completion_tokens: 65536 };" },
    { code: "const limits = { retries: 4096 };" },
  ],
  invalid: [
    { code: "export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;", errors: [{ messageId: "belowFloor" }] },
    { code: "const body = { model, max_tokens: 16384 };", errors: [{ messageId: "belowFloor" }] },
    { code: "const body = { 'max_completion_tokens': 8192 };", errors: [{ messageId: "belowFloor" }] },
    { code: "function call({ maxOutputTokens = 4096 }) { return maxOutputTokens; }", errors: [{ messageId: "belowFloor" }] },
    { code: "endpoint.maxOutputTokens = 1024;", errors: [{ messageId: "belowFloor" }] },
  ],
});
