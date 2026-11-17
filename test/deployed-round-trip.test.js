/**
 * The one question #213 exists to answer: **can a run be started, advanced and cancelled against
 * a real deployment, with no worker container anywhere?**
 *
 * Everything else in this repository about the Vercel backing is checked against something
 * smaller than a deployment. `test/workflow-vercel.test.js` drives the real runtime, but over
 * loopback against a filesystem World. `test/workflow-deploy-build.test.js` reads the emitted
 * `.vercel/output` — the queue subscription, the workflow id, the durations — but an emitted
 * directory is not a running one. This file is the only thing here that talks to a deployment,
 * and until it has been run, #200's deletion has no evidence to stand on.
 *
 * ## Why it starts the run by webhook rather than by calling start()
 *
 * It cannot call `start()`. The Vercel World addresses every queue message to the producer's own
 * deployment id (`@workflow/world-vercel`, `prepareSend`), and a test process is not a
 * deployment, so `start()` throws before it enqueues anything. That is not a limitation of the
 * test — it is the topology, and `windkeel doctor` reports it for the same reason. On this backing a
 * run is started by the deployed webhook, so that is how this starts one.
 *
 * ## Why cancellation is a database write
 *
 * ADR-0021 §4: the stop signal, never a hard cancel. `cancel()` writes a durable latch to
 * `run_cancellation` and then *tries* to `wakeUp()` the execution; the wake is an optimisation,
 * and a wake that fails delays the observation rather than losing it. This test writes the same
 * latch — it cannot wake anything, being outside the deployment — and waits for the loop to
 * observe it, which is the slow path working rather than the fast one.
 *
 * ## Running it
 *
 * Against a **throwaway Vercel project**, never the live one: a run here creates real sandboxes
 * and spends real money, and cancelling mid-stage is the point rather than an accident.
 *
 *   WINDKEEL_DEPLOYED_E2E_URL=https://windkeel-scratch.vercel.app \
 *   WINDKEEL_DEPLOYED_E2E_WEBHOOK_SECRET=... \
 *   WINDKEEL_DEPLOYED_E2E_DATABASE_URL=postgresql://... \
 *   WINDKEEL_DEPLOYED_E2E_REPOSITORY=owner/name \
 *   WINDKEEL_DEPLOYED_E2E_ISSUE=1 \
 *   WINDKEEL_DEPLOYED_E2E_BYPASS_TOKEN=...   # optional; see below \
 *   node --test test/deployed-round-trip.test.js
 *
 * The database URL is the deployment's own, in session mode (ADR-0008 §1) — this reads the run
 * the deployment wrote, so pointing it at a local database would watch nothing happen and report
 * a timeout that means the opposite of what it says.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const URL_ = process.env["WINDKEEL_DEPLOYED_E2E_URL"];
const SECRET = process.env["WINDKEEL_DEPLOYED_E2E_WEBHOOK_SECRET"];
const DB = process.env["WINDKEEL_DEPLOYED_E2E_DATABASE_URL"];
const REPO = process.env["WINDKEEL_DEPLOYED_E2E_REPOSITORY"];
const ISSUE = process.env["WINDKEEL_DEPLOYED_E2E_ISSUE"];
/**
 * Optional, and the reason it exists is worth knowing before you need it.
 *
 * Vercel turns **Deployment Protection** on by default, which 302s every unauthenticated request
 * to SSO — including GitHub's webhook deliveries. Rather than turning it off, this test carries
 * the project's automation bypass secret on its own request, so a scratch deployment can stay
 * protected while still being testable. (A real deployment has to solve this for GitHub too:
 * either protection off, or the bypass secret in the Webhook URL's query string.)
 */
const BYPASS = process.env["WINDKEEL_DEPLOYED_E2E_BYPASS_TOKEN"];

const configured = Boolean(URL_ && SECRET && DB && REPO && ISSUE);

/**
 * Skipped rather than failed when unconfigured, and the reason names every variable — this is the
 * test someone runs once, months after it was written, to decide whether a topology works.
 */
const gate = {
  skip: configured
    ? false
    : "set WINDKEEL_DEPLOYED_E2E_URL, _WEBHOOK_SECRET, _DATABASE_URL, _REPOSITORY and _ISSUE to " +
      "run this against a throwaway Vercel project. It is the only proof that a deployed run " +
      "advances; nothing else here talks to a deployment.",
};

/** How long to wait for the deployment to do each thing, and why each number is what it is. */
const TIMEOUTS = {
  /** A cold function, a queue hop and one database write. */
  runCreated: 60_000,
  /** PROVISIONING creates a real sandbox and clones a repository. */
  advanced: 300_000,
  /**
   * The loop's `wait` sleep is 300s and this test cannot wake it, so the worst case is a full
   * sleep plus the tick that follows. 420s leaves room for the tick to finish a stage first.
   */
  cancelled: 420_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ADR-0003's four terminal states, plus the two the rails can reach. */
const TERMINAL = new Set([
  "COMPLETED",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
]);

async function until(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last.done) return last.value;
    await sleep(5_000);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}. Last seen: ${last?.seen}`);
}

test("a run starts, advances and cancels against a real deployment", gate, async (t) => {
  const [owner, name] = REPO.split("/");
  const pool = new pg.Pool({ connectionString: DB, max: 2 });
  t.after(() => pool.end());

  /**
   * Which runs already exist for this issue, before anything is sent.
   *
   * Re-labelling an issue whose runs are all terminal starts a **fresh** run on the same task
   * (`issue-intake.ts`'s `relabel`: "recovery is a new run"), so this file is expected to run
   * against an issue that already has history. Identifying the new run by "the latest" is not
   * available — `engineering_run` has no creation timestamp, and `started_at` is null until a
   * run starts — and ordering by `id` would be ordering by uuid, which is to say by nothing.
   * Ordering by uuid is what the first version of this test did, and it is the kind of bug that
   * passes for months and then reads the wrong row.
   */
  const { rows: preexisting } = await pool.query(
    `select r.id from engineering_run r join engineering_task t on t.id = r.task_id
      where t.source_reference = $1`,
    [`${REPO}#${ISSUE}`],
  );
  const known = new Set(preexisting.map((r) => r.id));

  const deliveryId = randomUUID();
  const body = JSON.stringify({
    action: "labeled",
    // `TRIGGER_LABEL` in apps/ingress/src/interpret.ts. A different label is ignored,
    // which would look here exactly like the deployment not working.
    label: { name: "windkeel" },
    issue: { number: Number(ISSUE), title: "deployed round trip", body: "", state: "open" },
    repository: { full_name: REPO, name, owner: { login: owner }, default_branch: "main" },
  });

  const response = await fetch(new URL("/api/webhook", URL_), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}),
    },
    body,
  });
  assert.ok(
    response.ok,
    response.status === 302
      ? "the deployment redirected the delivery to SSO — Deployment Protection is on and no " +
        "bypass was supplied. Set WINDKEEL_DEPLOYED_E2E_BYPASS_TOKEN, or turn protection off. " +
        "Note that GitHub's own deliveries hit exactly this."
      : `the deployment rejected the delivery: HTTP ${response.status} ${await response.text()}`,
  );

  /**
   * The delivery row is written in the same transaction as the task, so its presence is the
   * ingress having done its half. Checked separately from the run so a failure says which half
   * broke: no delivery means the webhook did not work, a delivery with no run means the ingress
   * worked and the workflow runtime did not — which is precisely the failure this whole issue is
   * about.
   */
  const runId = await until("the deployment to create a run", TIMEOUTS.runCreated, async () => {
    const { rows } = await pool.query(
      `select r.id, r.status from engineering_run r
         join engineering_task t on t.id = r.task_id
        where t.source_reference = $1`,
      [`${REPO}#${ISSUE}`],
    );
    const fresh = rows.find((r) => !known.has(r.id));
    return {
      done: Boolean(fresh),
      value: fresh?.id,
      seen: fresh ? fresh.status : `${rows.length} run(s), all pre-existing`,
    };
  });

  /**
   * **Two stages, not one.** One transition proves the webhook wrote a row. Two proves a *step*
   * executed — that the queue dispatched to the flow function, that the function built the stage
   * graph from its environment (`deployed-runner.ts`, the fix this issue turned on), and that the
   * loop came back for another tick. That is the claim under test.
   */
  await until("the run to advance through two stages", TIMEOUTS.advanced, async () => {
    const { rows } = await pool.query(
      "select to_state from run_state_transition where engineering_run_id = $1 order by at",
      [runId],
    );
    const states = rows.map((r) => r.to_state);
    return { done: states.length >= 2, value: states, seen: states.join(" → ") || "none" };
  });

  /**
   * **The run must still be alive when the latch is written**, or the rest of this proves
   * nothing. The first time this test ran it passed against a run the criteria gate had already
   * cancelled on its own ("no verifiable acceptance criteria could be derived from this issue"):
   * two transitions had happened, the status was CANCELLED, and every assertion held — while the
   * cancel path under test had not been exercised at all. A terminal run here is a broken
   * fixture, not a pass.
   */
  const { rows: before } = await pool.query("select status from engineering_run where id = $1", [
    runId,
  ]);
  assert.equal(
    TERMINAL.has(before[0]?.status),
    false,
    `the run reached ${before[0]?.status} on its own before it could be cancelled, so the cancel ` +
      "path was never exercised. Check the trigger issue: it needs author-written acceptance " +
      "criteria (a `- [ ]` checklist), or the criteria gate cancels the run itself.",
  );

  await pool.query(
    `insert into run_cancellation (engineering_run_id, reason) values ($1, $2)
     on conflict (engineering_run_id) do nothing`,
    [runId, "deployed round trip"],
  );

  const final = await until("the run to reach CANCELLED", TIMEOUTS.cancelled, async () => {
    const { rows } = await pool.query("select status from engineering_run where id = $1", [runId]);
    const status = rows[0]?.status;
    return { done: status === "CANCELLED", value: status, seen: status };
  });
  assert.equal(final, "CANCELLED");

  /**
   * And it must be CANCELLED *because of the latch*. The provider commits a fixed reason when it
   * observes one (`vercel.ts`: `commit(id, "CANCELLED", "cancelled by operator", null)`), which
   * is distinguishable from every handler-originated cancel — the distinction the first run of
   * this test did not draw.
   */
  const { rows: last } = await pool.query(
    "select to_state, reason from run_state_transition where engineering_run_id = $1 order by at desc limit 1",
    [runId],
  );
  assert.equal(last[0]?.to_state, "CANCELLED");
  assert.equal(
    last[0]?.reason,
    "cancelled by operator",
    `the run is CANCELLED but for the wrong reason (${JSON.stringify(last[0]?.reason)}). That is ` +
      "a handler cancelling the run, not the durable execution observing the stop signal.",
  );

  /**
   * A cancelled run must not leave a sandbox billing until `expires_at`. The stage that observes
   * the latch tears its workspace down, and a workspace still `ready` here is a leak with a
   * price on it — worth failing the test for even though the run itself settled correctly.
   */
  const { rows: live } = await pool.query(
    "select id, status from workspace where engineering_run_id = $1 and status in ('ready','provisioning')",
    [runId],
  );
  assert.deepEqual(live, [], "the cancelled run left live workspaces behind");
});
