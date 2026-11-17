/**
 * The Vercel Workflow runtime, in-process, for tests — extracted from
 * `test/workflow-vercel.test.js` when #200 deleted pg-boss.
 *
 * ## Why this is shared rather than per-file
 *
 * Until #200 the e2e suites drove `PgBossWorkflowProvider`, which needed nothing but a Postgres
 * schema. The Vercel backing needs a *runtime*: the built flow bundle, an HTTP transport in
 * front of it, and a World both sides agree on. That is thirty lines of setup with two sharp
 * edges, and three suites now need it, so it lives here once rather than being copied and
 * drifting.
 *
 * **The setup:**
 *
 * 1. `npm run build` compiles `src/factory/workflow/vercel-flow.ts` with the Workflow SWC
 *    transform into `src/.well-known/workflow/v1/flow.mjs` — the same artifact a Vercel
 *    deployment serves.
 * 2. This module serves that artifact over loopback HTTP and points a local World at it.
 * 3. Providers run against that World.
 *
 * Everything under test is genuine: the durable journal, step replay, `sleep`, `wakeUp`, the
 * event log. **Nothing about the SDK is mocked.** What differs from production is the World
 * (filesystem instead of Vercel's queue and storage) and the transport (loopback instead of a
 * deployment) — the two things this harness cannot speak for, named here so no suite claims
 * otherwise.
 *
 * ## The three sharp edges, all learned the hard way
 *
 * **One World, not one per case.** The bundle does not use the `World` handed to `start()` for
 * everything; when it enqueues its own next message — after a `sleep`, say — it constructs a
 * World from the environment. So a `createWorld({ dataDir })` here and a bundle defaulting to
 * `.workflow-data/` are two different stores, and per-case `dataDir` isolation does nothing:
 * every run really lands in the repo-root default, and the timers keeping `node --test` from
 * exiting belong to a World nothing can close. The two are made to agree explicitly through the
 * environment variables `world-local` documents for it (`WORKFLOW_LOCAL_DATA_DIR`,
 * `WORKFLOW_LOCAL_BASE_URL`), both set at this module's import rather than when the runtime
 * starts — see the third edge below for why the gap mattered.
 *
 * Cases stay isolated by **identity** rather than by directory: each seeds its own engineering
 * run in its own Postgres schema, and each gets its own workflow run id. Nothing is shared but
 * the transport.
 *
 * **The ambient transport is process-global state with no owner.** `WORKFLOW_LOCAL_BASE_URL` is
 * how this module and the workflow bundle agree on where the queue is, and anything that builds a
 * World reads it — including production code a test calls, like `createAndStartTask`, which
 * constructs its own provider and never sees the World created here.
 *
 * When it is **unset**, `@workflow/world-local` does not fail. It falls back to scanning *this
 * process's own listening ports* and posting to whichever one answers — or, finding none, throws
 * `Unable to resolve base URL for workflow queue`. Both were observed on CI and neither named the
 * cause: #255's `workflow-backing` failure is the throw, from a test that enqueued to the real
 * backing before any suite in the file had started the runtime, and `criteria-gate-stage`'s
 * repeated `TypeError: fetch failed` is the other half — a live durable execution still posting
 * after `closeWorkflowRuntime()` shut the server down and left the variable pointing at a dead
 * port. Locally both usually passed, because a laptop's process happens to be listening on
 * something.
 *
 * So the variable is **never unset**. From the moment this module is imported it points at a
 * refusal server that answers every request with a 503 saying what went wrong, and
 * `closeWorkflowRuntime()` puts it back. Port auto-detection can therefore never engage, no
 * suite can be silently routed to an unrelated server in its own process, and using the
 * transport outside the runtime's lifetime fails **as itself** rather than as a timeout three
 * files away.
 *
 * **`npm test` needs `--test-force-exit`.** The SDK's local delivery loop keeps timers inside
 * the *workflow bundle's* realm — a module graph a test process can reach but not own.
 * `world.close()` ends the World created here; it cannot end that one, and a few `Timeout`
 * handles survive every teardown this module can perform. Without the flag `node --test`
 * completes every assertion and then never exits, which does not read as a leak, it reads as a
 * hung suite.
 */

import { createServer } from "node:http";
import { join } from "node:path";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { getRun } from "workflow/api";
import { repoRoot } from "./helpers.js";

/** The bundle the build emits, and the same file a deployment serves. */
export const flowPath = join(repoRoot, "src", ".well-known", "workflow", "v1", "flow.mjs");

/** False until `npm run build` has run — every suite here is useless without it. */
export const flowBuilt = statSync(flowPath, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * Why a suite that needs this runtime should skip, or `false` to run.
 *
 * Postgres-gated like every other suite that touches a database, and additionally gated on the
 * bundle, because "the workflow module is not built" is a far more useful message than whatever
 * a missing import throws.
 */
export function runtimeSkip(dbUrl = process.env.TEST_DATABASE_URL) {
  if (!dbUrl) return "TEST_DATABASE_URL not set";
  if (!flowBuilt) return "the workflow bundle is not built — run `npm run build` (see build:workflow)";
  return false;
}

/**
 * This process's World store, fixed before anything can read it.
 *
 * **Per-process**, not a fixed path: `node --test` runs each file in its own child process and
 * runs several at once, and `closeWorkflowRuntime()` ends with `world.clear()` — so one shared
 * directory means the first suite to finish wipes the runs of every suite still going. That
 * failure is a timeout in an unrelated file, which is about as misleading as a test failure gets.
 *
 * Set at module scope rather than inside `workflowRuntime()` for the same reason the base URL is:
 * a World built before the runtime started would default to `.workflow-data/` in the repo root,
 * which *is* shared across processes. Isolation *within* a file is still by identity — its own
 * Postgres schema and its own workflow run ids — because one file is one World and one server.
 */
export const dataDir = join(repoRoot, `.workflow-test-data-${process.pid}`);
process.env["WORKFLOW_LOCAL_DATA_DIR"] = dataDir;
// A previous file's leftover runs must not be replayed into this one.
process.env["WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS"] = "0";

/** What the refusal server says. Read by a human staring at a CI log, so it says what to do. */
export const NOT_STARTED_MESSAGE =
  "windkeel: the workflow transport of this test process is not claimed. Something built a World " +
  "and posted to the queue either before `await workflowRuntime()` or after " +
  "`closeWorkflowRuntime()`. The transport is process-global state shared by every suite in " +
  "this file and by any production code they call (createAndStartTask builds its own provider " +
  "and resolves the queue from the environment). Start the runtime first, and gate the test on " +
  "`runtimeSkip()`.";

/**
 * Stands in for the queue whenever the runtime is not running.
 *
 * A server rather than a closed port, because a closed port gives `TypeError: fetch failed` with
 * the reason only in `error.cause` — which is exactly the unreadable failure #255 is about. A 503
 * carrying `NOT_STARTED_MESSAGE` names the resource.
 *
 * `unref()`d so it never keeps `node --test` alive, and started with top-level `await` so the
 * variable is set before any importing suite runs a line.
 */
const refusal = createServer((_req, res) => {
  res.writeHead(503, { "content-type": "text/plain" });
  res.end(NOT_STARTED_MESSAGE);
});
await new Promise((resolve) => refusal.listen(0, "127.0.0.1", resolve));
refusal.unref();

/** Where `WORKFLOW_LOCAL_BASE_URL` points whenever no runtime is running. */
export const NOT_STARTED_BASE_URL = `http://127.0.0.1:${refusal.address().port}`;

/** Never unset: an unset value is what lets the SDK go looking for a port of its own. */
function releaseTransport() {
  process.env["WORKFLOW_LOCAL_BASE_URL"] = NOT_STARTED_BASE_URL;
}
releaseTransport();

/** True while a runtime owns the transport. The guard test asserts on both states. */
export const transportClaimed = () =>
  process.env["WORKFLOW_LOCAL_BASE_URL"] !== NOT_STARTED_BASE_URL;

let runtimePromise = null;

/** The bundle, a loopback server in front of it, and the World both sides agree on. */
export function workflowRuntime() {
  runtimePromise ??= (async () => {
    const [{ createWorld }, flow] = await Promise.all([
      import("@workflow/world-local"),
      import(flowPath),
    ]);

    /**
     * `port` is captured after `listen`, never read per request (#255).
     *
     * It used to be `server.address().port` inside the handler, and `address()` returns **null**
     * from the moment the server starts closing. A delivery arriving during teardown therefore
     * threw `Cannot read properties of null (reading 'port')` *inside* an async handler, killed
     * the connection, and the World reported `TypeError: fetch failed` and retried — seven times
     * in one observed run. The throw reached node's test runner as "asynchronous activity after
     * the test ended", which fails the whole **file**, attributed to whichever test happened to
     * be last. That is the `criteria-gate-stage` symptom in #255, and it is also why the same
     * failure never named a cause: nothing in it mentions a server, a port, or teardown.
     */
    let port = 0;
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
            method: req.method,
            headers: req.headers,
            ...(body.length > 0 ? { body, duplex: "half" } : {}),
          });
          const response = await flow.POST(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          /**
           * A handler that throws takes the whole file down as an unhandled rejection. A
           * delivery this harness cannot serve is an ordinary event during teardown, so it is
           * answered rather than thrown: the World logs a failed delivery and retries, which is
           * noise, and noise is a great deal better than a failure in an unrelated test.
           */
          if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain" });
          res.end(`windkeel test transport: ${error?.message ?? error}`);
        }
      })();
    });
    /**
     * The delivery that goes missing under a full concurrent run (#255).
     *
     * `fetch` keeps a pooled connection alive for 4s; this server closes an idle keep-alive
     * socket after 5s. One second of margin is nothing when ~30 test files are competing for the
     * CPU: the server's timer fires while undici is putting a request onto the same socket, the
     * socket goes away mid-flight, and the World reports `TypeError: fetch failed` and loses that
     * delivery. It only ever showed up in the full run, never in isolation, which is exactly the
     * shape #255 is about — the margin is a function of how loaded the machine is.
     *
     * Zero disables the idle timeout rather than widening the margin, because any finite value is
     * the same race with a longer fuse. The sockets are ended explicitly in
     * `closeWorkflowRuntime()`, so nothing is left holding the process open.
     */
    server.keepAliveTimeout = 0;
    server.headersTimeout = 0;
    server.requestTimeout = 0;

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    process.env["WORKFLOW_LOCAL_BASE_URL"] = baseUrl;

    const world = createWorld({ dataDir, baseUrl, recoverActiveRuns: false });
    return { world, server };
  })();
  return runtimePromise;
}

/**
 * Tears the runtime down. A suite that called `workflowRuntime()` registers this in its own
 * `after()` — there is no ambient hook here, because a module-level `after` would fire in files
 * that never started a runtime.
 */
export async function closeWorkflowRuntime() {
  if (!runtimePromise) return;
  const { world, server } = await runtimePromise;
  // Released before anything is torn down, so a delivery still in flight is refused by name
  // rather than arriving at a half-closed server.
  releaseTransport();
  await destroyWorldData(world).catch(() => {});
  await world.close?.().catch(() => {});
  // `close()` waits for open connections, and a delivery mid-flight would otherwise hold it
  // open past the suite. The sockets belong to a loop this process cannot own (see
  // `--test-force-exit` above), so they are ended rather than waited on.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  // The directory is this process's alone, so removing it leaves nothing for anyone else.
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  runtimePromise = null;
}

/**
 * Ends any execution a test left parked.
 *
 * A run that finishes a case sitting at `waiting` still has a live durable execution behind it,
 * re-arming a `sleep` every couple of seconds. Left alone those keep the World's delivery loop
 * alive and `node --test` never exits — which does not look like a leak, it looks like a hung
 * suite. This is the one place a **hard** cancel is right: the case is over, no sandbox exists,
 * and there is nothing to clean up. Production never does this; see `VercelWorkflowProvider`'s
 * header for why the stop-signal shape is used there instead.
 */
export async function endExecutions(pool) {
  const { rows } = await pool
    .query(
      "select execution_handle from workflow_run_binding " +
        "where phase <> 'finished' and execution_handle <> ''",
    )
    .catch(() => ({ rows: [] }));
  for (const row of rows) {
    // `getRun` resolves the ambient World, which `workflowRuntime()` has already pointed at the
    // same local store through WORKFLOW_LOCAL_* — so this reaches the run the test started.
    await getRun(row.execution_handle)
      .cancel({ cancelReason: "test teardown" })
      .catch(() => {});
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Destroys everything the local World holds, tolerating the fact that it is still moving.
 *
 * `world.clear()` removes the store directory tree, and the World's own delivery loop writes
 * into `events/` on its own schedule — a loop this process can reach but not own, which is the
 * same ownership problem `--test-force-exit` exists for. Cancelling an execution does not stop
 * it instantly, so a `clear()` immediately afterwards can lose a race with a flush and fail with
 * `ENOTEMPTY: directory not empty, rmdir .../events`.
 *
 * It surfaced only on CI, which is slower and more contended than a laptop: the same call
 * succeeded locally on every run.
 *
 * The retry is not a way of hoping it worked. The two tests that use this assert **afterwards**
 * that the data is gone — that the binding row no longer exists, and that a fresh provider reads
 * the run's state from Postgres rather than from anything the World kept. A `clear()` that had
 * silently left the journal behind would fail those. This only stops a transient rmdir race
 * being reported as a failed proof.
 */
export async function destroyWorldData(world, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      await world.clear();
      return;
    } catch (err) {
      if (err?.code !== "ENOTEMPTY" && err?.code !== "ENOENT") throw err;
      await sleep(100);
    }
  }
  // Out of attempts: the caller's own assertions decide whether that mattered.
  await world.clear().catch(() => {});
}

/**
 * "Nothing is runnable right now."
 *
 * The binding row's `phase` is written by the stage loop itself, so it is the loop's own account
 * of where it is: `finished` means the execution returned, `waiting` means it is parked on a
 * `sleep` that only a signal or a cancel will interrupt. Both are quiescent; `queued`, `running`
 * and `retrying` are not. Two consecutive quiet reads, as in the pg-boss harness this replaced,
 * so a poll landing exactly on a phase write is not mistaken for quiet.
 */
export async function settle(pool, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `select b.phase,
              (select count(*) from run_signal s
                where s.engineering_run_id = b.engineering_run_id and s.consumed_at is null) as signals,
              (select count(*) from run_cancellation c
                where c.engineering_run_id = b.engineering_run_id) as cancels
         from workflow_run_binding b
        where b.engineering_run_id = $1`,
      [runId],
    );
    const phase = rows[0]?.phase ?? "finished";
    /**
     * `waiting` alone is not quiet. A signal or a cancellation that has just been recorded has
     * also just called `wakeUp()`, so the loop is about to tick — and a `settle` that returned
     * on the phase alone would race the wake and read the run where it *was*. Both counters are
     * therefore part of the quiescence test, which makes this "nothing is runnable", not merely
     * "nothing is running".
     */
    const pending = Number(rows[0]?.signals ?? 0) + Number(rows[0]?.cancels ?? 0);
    const quiesced = phase === "finished" || (phase === "waiting" && pending === 0);
    if (quiesced) {
      if (++quiet >= 2) return;
    } else {
      quiet = 0;
    }
    await sleep(50);
  }
  const { rows } = await pool.query(
    "select phase, attempt from workflow_run_binding where engineering_run_id = $1",
    [runId],
  );
  throw new Error(
    `settle: run ${runId} never went quiet (binding ${JSON.stringify(rows[0] ?? null)})`,
  );
}
