import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { repoRoot } from "./helpers.js";
import {
  NOT_STARTED_BASE_URL,
  NOT_STARTED_MESSAGE,
  closeWorkflowRuntime,
  dataDir,
  runtimeSkip,
  transportClaimed,
  workflowRuntime,
} from "./workflow-runtime.js";

/**
 * #255: `node --test test/*.test.js` runs files concurrently, and a red CI cannot be trusted
 * while they interfere. The corrosive part is not any individual failure but what it teaches — a
 * suite that fails for reasons unrelated to the change trains people to re-run rather than read,
 * and the *next* real failure gets re-run too.
 *
 * So these are not tests of a feature. They are the guards that keep the shared state in this
 * suite shared on purpose, and make a violation say what it is rather than surfacing as a
 * timeout in another file.
 */

const dbUrl = process.env.TEST_DATABASE_URL;

after(async () => {
  await closeWorkflowRuntime();
});

// --- the ambient workflow transport ------------------------------------------------------------

/**
 * The fix for both of #255's unexplained failures. When `WORKFLOW_LOCAL_BASE_URL` is unset,
 * `@workflow/world-local` resolves the queue by scanning this process's own listening ports and
 * posting to whichever answers — silently reaching an unrelated server — or throws
 * `Unable to resolve base URL for workflow queue` when it finds none. Neither names the cause.
 * Keeping the variable always set means that branch is unreachable.
 */
test("the transport is claimed from module import, so port auto-detection can never engage", () => {
  assert.equal(
    process.env["WORKFLOW_LOCAL_BASE_URL"],
    NOT_STARTED_BASE_URL,
    "importing the runtime module must point the queue somewhere, even before it starts",
  );
  assert.equal(transportClaimed(), false, "…but not at a running runtime");
});

test("the World store is this process's alone, never the repo-root default", () => {
  assert.equal(process.env["WORKFLOW_LOCAL_DATA_DIR"], dataDir);
  assert.match(dataDir, new RegExp(`\\.workflow-test-data-${process.pid}$`));
  assert.equal(
    process.env["WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS"],
    "0",
    "a previous file's leftover runs must not be replayed into this one",
  );
});

/**
 * The guard the issue asks for: using a shared resource nobody has claimed gets a refusal naming
 * the resource, not a timeout. This is the failure `workflow-backing` actually suffered, driven
 * deliberately.
 */
test("posting to the queue before the runtime starts is refused, and the refusal says why", async () => {
  const response = await fetch(`${NOT_STARTED_BASE_URL}/.well-known/workflow/v1/flow`, {
    method: "POST",
    body: "{}",
  });

  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body, NOT_STARTED_MESSAGE);
  assert.match(body, /workflow transport of this test process is not claimed/);
  assert.match(body, /await `?workflowRuntime\(\)`?|`await workflowRuntime\(\)`/);
});

test(
  "starting the runtime claims the transport, and closing it releases the transport again",
  { skip: runtimeSkip(dbUrl) },
  async () => {
    await workflowRuntime();
    assert.equal(transportClaimed(), true);
    assert.notEqual(process.env["WORKFLOW_LOCAL_BASE_URL"], NOT_STARTED_BASE_URL);

    await closeWorkflowRuntime();

    // Released *before* the server closes, so an execution still in flight is refused by name
    // rather than reporting `TypeError: fetch failed` against whichever test is running — which
    // is where `criteria-gate-stage`'s repeated fetch failures came from.
    assert.equal(transportClaimed(), false);
    assert.equal(process.env["WORKFLOW_LOCAL_BASE_URL"], NOT_STARTED_BASE_URL);
  },
);

/**
 * The mechanism behind `criteria-gate-stage`'s repeated `TypeError: fetch failed` in #255.
 *
 * The loopback server in front of the workflow bundle used to build each request URL from
 * `server.address().port`, read **per request** — and `address()` returns null from the moment
 * the server starts closing. A delivery arriving during teardown threw inside an async handler,
 * killed the connection, and the World reported `fetch failed` and retried; the throw reached
 * node's runner as "asynchronous activity after the test ended" and failed the whole file,
 * attributed to whichever test happened to be last. Nothing in that failure mentions a server,
 * a port, or teardown, which is why it stayed unexplained.
 *
 * The property that keeps it fixed: the handler always answers.
 */
test(
  "a delivery the bundle cannot serve is answered, never thrown out of the handler",
  { skip: runtimeSkip(dbUrl) },
  async () => {
    await workflowRuntime();
    const base = process.env["WORKFLOW_LOCAL_BASE_URL"];
    try {
      const response = await fetch(`${base}/.well-known/workflow/v1/flow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not a workflow message",
      });
      await response.text();
      assert.ok(
        Number.isInteger(response.status),
        "an HTTP status, not a socket hangup — a handler that throws takes the file with it",
      );
    } finally {
      await closeWorkflowRuntime();
    }
  },
);

// --- Postgres schemas -------------------------------------------------------------------------

// This file's own source contains the patterns the checks below look for, so it is excluded —
// a lint that flags its own lint is a lint nobody keeps.
const SELF = "suite-isolation.test.js";
const testFiles = readdirSync(join(repoRoot, "test")).filter(
  (f) => f.endsWith(".test.js") && f !== SELF,
);

/**
 * The suite's other cross-process shared resource is the Postgres server itself. Suites isolate
 * by schema name, which works — but only if the schema is dropped, and a drop that is not in a
 * `finally` or an `after` is skipped exactly when a test fails, which is exactly when the next
 * run most needs a clean server.
 */
test("every suite that creates a Postgres schema drops it, including when a test throws", () => {
  const offenders = [];
  for (const file of testFiles) {
    const source = readFileSync(join(repoRoot, "test", file), "utf8");
    if (!/create schema|createMigratedDatabase\(/.test(source)) continue;
    if (!/drop schema|dropMigratedDatabase\(/.test(source)) {
      offenders.push(`${file}: creates a schema and never drops one`);
      continue;
    }
    // The drop has to be reachable on the failure path: inside a `finally`, or in an `after`
    // hook, or inside a named teardown helper the file calls from one of those.
    if (!/\}\s*finally\s*\{/.test(source) && !/\bafter\s*\(/.test(source)) {
      offenders.push(`${file}: drops its schema only on the success path`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});

/**
 * Schema names have to be unique across concurrently running files, and two files that both
 * used `windkeel_test` would collide in a way that presents as unrelated rows appearing mid-test.
 * Every generator in the suite mixes in `process.pid` or a timestamp; this holds the line.
 */
test("schema names are generated per process, not fixed", () => {
  const offenders = [];
  for (const file of testFiles) {
    const source = readFileSync(join(repoRoot, "test", file), "utf8");
    for (const match of source.matchAll(/create schema (?:if not exists )?([^`"';\n]*)/g)) {
      const name = match[1];
      // A template with any interpolation is generated; a bare literal is not.
      if (!name.includes("${")) offenders.push(`${file}: fixed schema name ${name.trim()}`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// --- the .vercel/output tree --------------------------------------------------------------------

/**
 * The interference that was diagnosed and fixed in passing while #255 was being written, kept as
 * a regression: three suites shared `apps/ingress/.vercel/output`, and the builder deletes it on
 * its first line, so whichever finished first wiped the others' fixtures.
 */
test("the ingress build writes where its caller says, never to one shared tree", () => {
  const source = readFileSync(join(repoRoot, "test", "workflow-deploy-build.test.js"), "utf8");
  assert.match(source, /WINDKEEL_VERCEL_OUTPUT_DIR/);
});
