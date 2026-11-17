import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { apiControl } from "../apps/ingress/dist/src/api/control.js";
import { streamRunEvents } from "../apps/ingress/dist/src/api/stream.js";
import { insertAgentRun, insertEngineeringRun, insertEngineeringTask, updateAgentRun } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { resolveRepositorySecrets } from "../dist/factory/repository-secrets.js";
import { getWorkspace, insertWorkspace } from "../dist/factory/repositories.js";
import { saveSessionBinding } from "../dist/factory/workflow/session-binding.js";
import { mkdirSync, readdirSync, readFileSync as readFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

// One pair for the whole file. The API deps get only the public half, exactly as ingress does; the
// private half stays in the test, standing in for the worker container.
const { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY } = generateSecretKeyPair();

function query(params = {}) {
  return { get: (name) => params[name] };
}

function request(method, path, extra = {}) {
  return {
    method,
    path,
    query: query(extra.query),
    headers: extra.headers ?? { authorization: `Bearer ${TOKEN}` },
    body: extra.body,
  };
}

function stubControl(overrides = {}) {
  return {
    approve: async () => ({ outcome: "signalled" }),
    cancel: async () => ({ outcome: "cancelled" }),
    message: async () => ({ outcome: "queued" }),
    listMessages: async () => [],
    startRun: async () => ({ engineeringRunId: "00000000-0000-0000-0000-000000000009" }),
    enqueue: async () => ({ enqueued: true }),
    ...overrides,
  };
}

/**
 * The real command port, against the real tables.
 *
 * `stubControl` is right for the tests about routing and refusals; it is wrong for the tests about
 * *guidance*, where the behaviour under test is precisely what `apiControl` writes and reads back.
 * A stub would have happily reported "delivered" — which is the exact claim this change exists to
 * stop the API making.
 */
function realControl(pool) {
  return apiControl({
    pool,
    control: { cancel: async () => {}, signal: async () => {} },
    github: {},
  });
}

async function withApi(fn, depsOverrides = {}) {
  const schema = `windkeel_api_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "github_issue",
      sourceReference: "acme/widgets#7",
      title: "Make the gauge read zero when empty",
      description: "- [ ] the gauge reads zero\n- [ ] npm test passes",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
    /*
     * Overrides may be a function of the pool, because the guidance tests need the *real* command
     * port and the real port needs the schema-scoped pool this function created a moment ago.
     */
    const overrides = typeof depsOverrides === "function" ? depsOverrides(pool) : depsOverrides;
    const deps = {
      pool,
      control: stubControl(),
      ...overrides,
    };
    const auth = { token: TOKEN, subject: "operator" };
    await fn({ pool, deps, auth, task, run, call: (m, p, e) => handleApiRequest(deps, auth, request(m, p, e)) });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

// --- auth ------------------------------------------------------------------

test("no token is 401, a wrong token is 403, and neither reaches a handler", { skip }, async () => {
  await withApi(async ({ deps, auth, run }) => {
    const missing = await handleApiRequest(deps, auth, request("GET", `/v1/runs/${run.id}`, { headers: {} }));
    assert.equal(missing.status, 401);
    assert.equal(missing.headers["www-authenticate"], "Bearer");

    const wrong = await handleApiRequest(
      deps,
      auth,
      request("GET", `/v1/runs/${run.id}`, { headers: { authorization: "Bearer nope" } }),
    );
    assert.equal(wrong.status, 403);
    assert.ok(
      !JSON.stringify(wrong.body).includes("nope"),
      "a rejected credential must never be echoed into a log",
    );
  });
});

test("an unset token disables the API rather than opening it", { skip }, async () => {
  await withApi(async ({ deps, run }) => {
    const result = await handleApiRequest(
      deps,
      { token: undefined, subject: "operator" },
      request("GET", `/v1/runs/${run.id}`),
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "api_disabled");
  });
});

test("liveness needs no token, and names nothing it is connected to", { skip }, async () => {
  await withApi(async ({ deps }) => {
    const result = await handleApiRequest(
      deps,
      { token: undefined, subject: "operator" },
      request("GET", "/v1/health", { headers: {} }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["database", "ok"]);
  });
});

// --- reads -----------------------------------------------------------------

test("a run reads back as the report the CLI prints, plus a cursor to follow from", { skip }, async () => {
  await withApi(async ({ pool, call, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    const result = await call("GET", `/v1/runs/${run.id}`);
    assert.equal(result.status, 200);
    assert.ok(result.body.report, "the report structure is reused, not re-projected");
    assert.equal(result.body.terminal, false);
    assert.match(result.body.cursor, /^\d+$/, "a client can begin following without a second call");
  });
});

test("a missing run is 404 on every route that takes one", { skip }, async () => {
  await withApi(async ({ call }) => {
    const ghost = "99999999-9999-9999-9999-999999999999";
    for (const path of [`/v1/runs/${ghost}`, `/v1/runs/${ghost}/events`, `/v1/runs/${ghost}/attempts`, `/v1/runs/${ghost}/cost`]) {
      const result = await call("GET", path);
      assert.equal(result.status, 404, path);
      assert.equal(result.body.code, "not_found");
    }
  });
});

test("the event feed paginates and resumes, and reports the run's status with it", { skip }, async () => {
  await withApi(async ({ pool, call, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");

    const first = await call("GET", `/v1/runs/${run.id}/events`, { query: { limit: "1" } });
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 1);
    assert.equal(first.body.hasNextPage, true);
    assert.equal(first.body.runStatus, "PLANNING", "the feed says where the run is now, not only what it did");

    const next = await call("GET", `/v1/runs/${run.id}/events`, {
      query: { after: first.body.endCursor },
    });
    assert.deepEqual(next.body.items.map((e) => e.to), ["PLANNING"]);
  });
});

test("a cursor the API did not issue is refused, not silently restarted", { skip }, async () => {
  await withApi(async ({ call, run }) => {
    const result = await call("GET", `/v1/runs/${run.id}/events`, { query: { after: "yesterday" } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_cursor");
  });
});

test("cost is broken out per stage, and the ledger is reported beside the run's own column", { skip }, async () => {
  await withApi(async ({ pool, call, run }) => {
    await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "agent_run",
      stageId: "22222222-2222-2222-2222-222222222222",
      kind: "model",
      usd: 0.02,
      tokensIn: 100,
      tokensOut: 50,
      keySource: "orqon",
    });
    await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "workspace",
      stageId: "33333333-3333-3333-3333-333333333333",
      kind: "sandbox",
      usd: 0.01,
    });
    // An unpriced call (#324): tokens, no price. It adds nothing and makes the total a lower bound.
    await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "verification_run",
      stageId: "44444444-4444-4444-4444-444444444444",
      kind: "model",
      usd: null,
      tokensIn: 300,
      tokensOut: 30,
      keySource: "orqon",
    });

    const result = await call("GET", `/v1/runs/${run.id}/cost`);
    assert.equal(result.body.byStage.length, 3, "a total is the number that hides an accounting bug");
    assert.ok(Math.abs(result.body.totalUsd - 0.03) < 1e-9);
    assert.ok(Math.abs(result.body.runRowCost - result.body.totalUsd) < 1e-9);
    assert.equal(result.body.unpricedEvents, 1);
    assert.deepEqual(
      result.body.bySource.map((s) => [s.keySource, Number(s.usd.toFixed(4)), s.events, s.unpricedEvents]),
      [["orqon", 0.02, 2, 1]],
      "model spend by whose key paid; the sandbox is no key's",
    );

    const sandbox = result.body.byStage.find((s) => s.kind === "sandbox");
    assert.equal(sandbox.tokensIn, null, "a sandbox cost has no tokens; 0 would claim a free model call");
    assert.equal(sandbox.keySource, null);
  });
});

test("a task surfaces criteria provenance rather than burying it among twenty fields", { skip }, async () => {
  await withApi(async ({ call, task }) => {
    const result = await call("GET", `/v1/tasks/${task.id}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.criteria.provenance, "extracted");
    assert.ok("approvedBy" in result.body.criteria);
  });
});

test("lists are keyset-paginated with an opaque cursor", { skip }, async () => {
  await withApi(async ({ pool, call, task }) => {
    await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });

    const first = await call("GET", "/v1/runs", { query: { limit: "2" } });
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasNextPage, true);
    assert.doesNotMatch(first.body.endCursor, /\d{4}-\d{2}-\d{2}/, "a cursor a client can parse is one it will construct");

    const second = await call("GET", "/v1/runs", { query: { limit: "2", cursor: first.body.endCursor } });
    const firstIds = new Set(first.body.items.map((r) => r.id));
    for (const item of second.body.items) {
      assert.ok(!firstIds.has(item.id), "keyset pagination must not repeat a row across pages");
    }
  });
});

test("runs filter on one state or several, comma-separated (G4)", { skip }, async () => {
  await withApi(async ({ pool, call, task, run }) => {
    const planning = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await advanceRun(pool, planning.id, "CLASSIFYING");
    await advanceRun(pool, planning.id, "PLANNING");
    await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });

    const one = await call("GET", "/v1/runs", { query: { status: "PLANNING" } });
    assert.deepEqual(one.body.items.map((r) => r.id), [planning.id]);

    const several = await call("GET", "/v1/runs", { query: { status: "PLANNING, CREATED" } });
    assert.equal(several.body.items.length, 3, "every run in either state, the one PLANNING and both CREATED");
    assert.ok(several.body.items.some((r) => r.id === run.id));

    const none = await call("GET", "/v1/runs", { query: { status: "BLOCKED,PR_READY" } });
    assert.deepEqual(none.body.items, []);
  });
});

test("the queue shows runs that have not started — oldest first, unlike every other list", { skip }, async () => {
  await withApi(async ({ pool, call, run }) => {
    const result = await call("GET", "/v1/queue");
    assert.equal(result.status, 200);
    assert.ok(result.body.items.some((r) => r.id === run.id), "a CREATED run is waiting, and must be visible");

    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");
    await advanceRun(pool, run.id, "PROVISIONING");
    const after = await call("GET", "/v1/queue");
    assert.ok(!after.body.items.some((r) => r.id === run.id), "a run that has started is no longer waiting");
  });
});

test("evidence answers 503 when the deployment has no object store, not 404", { skip }, async () => {
  await withApi(async ({ call, run }) => {
    const result = await call("GET", `/v1/runs/${run.id}/evidence`);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "storage_unconfigured");
  });
});

test("an evidence path may not escape its package", { skip }, async () => {
  await withApi(
    async ({ call, run }) => {
      const result = await call("GET", `/v1/runs/${run.id}/evidence/../../secrets`);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "invalid_path");
    },
    { evidence: { list: async () => [], presign: async () => "https://example.test/x" } },
  );
});

// --- diff (G2) ----------------------------------------------------------------

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function withCandidates(pool, run, candidates) {
  // Agent runs are listed by when they started, as the stages record it; one minute apart here.
  for (const [i, [role, sha, diffRef]] of candidates.entries()) {
    const agent = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "fake", model: "m", role });
    await updateAgentRun(pool, agent.id, {
      startedAt: new Date(Date.UTC(2026, 8, 24, 0, i)),
      result: { candidate: { candidateSha: sha, workingBranch: "windkeel/x", diffRef, diffTruncated: false, filesChanged: ["src/a.ts"], empty: false } },
    });
  }
}

function storedPatches(files) {
  return {
    list: async () => [],
    presign: async () => "https://example.test/x",
    read: async (bucket, key, path) => {
      const body = files[`${bucket}/${key}/${path}`];
      if (body === undefined) {
        const { EvidenceFileNotFoundError } = await import("../dist/factory/evidence-storage.js");
        throw new EvidenceFileNotFoundError(bucket, key, path);
      }
      return Buffer.from(body);
    },
  };
}

test("the diff is the newest candidate's stored patch, inline, with every candidate listed", { skip }, async () => {
  await withApi(
    async ({ call, pool, run }) => {
      await withCandidates(pool, run, [
        ["implementer", SHA_A, `evidence/${run.id}/candidate/${SHA_A}`],
        ["repairer", SHA_A, `evidence/${run.id}/candidate/${SHA_A}`],
        ["repairer", SHA_B, `evidence/${run.id}/candidate/${SHA_B}`],
      ]);
      const newest = await call("GET", `/v1/runs/${run.id}/diff`);
      assert.equal(newest.status, 200);
      assert.equal(newest.body.candidateSha, SHA_B);
      assert.equal(newest.body.patch, "diff --git a/src/a.ts b/src/a.ts\n+b\n");
      assert.deepEqual(
        newest.body.candidates.map((c) => [c.sha, c.role]),
        [
          [SHA_A, "implementer"],
          [SHA_B, "repairer"],
        ],
        "a repair turn that changed nothing is the same candidate, not a second one",
      );

      const older = await call("GET", `/v1/runs/${run.id}/diff`, { query: { sha: SHA_A } });
      assert.equal(older.body.patch, "diff --git a/src/a.ts b/src/a.ts\n+a\n");
      const unknown = await call("GET", `/v1/runs/${run.id}/diff`, { query: { sha: "c".repeat(40) } });
      assert.equal(unknown.status, 404);
    },
    {
      evidence: {
        ...storedPatches({}),
        // Each candidate's patch adds one line naming it, so the test can tell which was served.
        read: async (_bucket, key) => Buffer.from(`diff --git a/src/a.ts b/src/a.ts\n+${key.endsWith(SHA_A) ? "a" : "b"}\n`),
      },
    },
  );
});

test("a run with no candidate, or a patch nobody stored, says which", { skip }, async () => {
  await withApi(
    async ({ call, pool, run }) => {
      const none = await call("GET", `/v1/runs/${run.id}/diff`);
      assert.equal(none.status, 409);
      assert.equal(none.body.code, "no_candidate");

      await withCandidates(pool, run, [["implementer", SHA_A, null]]);
      const unstored = await call("GET", `/v1/runs/${run.id}/diff`);
      assert.equal(unstored.status, 409);
      assert.equal(unstored.body.code, "no_patch");
    },
    { evidence: storedPatches({}) },
  );
});

test("a stored patch that has gone from the store is a conflict, not a 500", { skip }, async () => {
  await withApi(
    async ({ call, pool, run }) => {
      await withCandidates(pool, run, [["implementer", SHA_A, `evidence/${run.id}/candidate/${SHA_A}`]]);
      const gone = await call("GET", `/v1/runs/${run.id}/diff`);
      assert.equal(gone.status, 409);
      assert.equal(gone.body.code, "no_patch");
    },
    { evidence: storedPatches({}) },
  );
});

test("without an evidence store that can read, the diff route is unavailable", { skip }, async () => {
  await withApi(async ({ call, pool, run }) => {
    await withCandidates(pool, run, [["implementer", SHA_A, `evidence/${run.id}/candidate/${SHA_A}`]]);
    const result = await call("GET", `/v1/runs/${run.id}/diff`);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "storage_unconfigured");
  });
});

// --- commands --------------------------------------------------------------

test("a command answers 202 with a cursor, never 200", { skip }, async () => {
  await withApi(async ({ call, run }) => {
    const result = await call("POST", `/v1/runs/${run.id}/approve`);
    assert.equal(result.status, 202, "200 would be a claim about work that has not happened");
    assert.equal(result.body.accepted, true);
    assert.match(result.body.cursor, /^\d+$/);
  });
});

test("a refusal is 409 with its reason, not an accepted command that did nothing", { skip }, async () => {
  await withApi(
    async ({ call, run }) => {
      const result = await call("POST", `/v1/runs/${run.id}/approve`);
      assert.equal(result.status, 409);
      assert.match(result.body.error, /too late/i);
    },
    { control: stubControl({ approve: async () => ({ outcome: "refused", reason: "too late to approve" }) }) },
  );
});

test("guidance is refused unless a maker is actually listening", { skip }, async () => {
  await withApi(async ({ pool, call, run }) => {
    const early = await call("POST", `/v1/runs/${run.id}/messages`, { body: { message: "use the existing helper" } });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "maker_not_listening");

    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");
    await advanceRun(pool, run.id, "PROVISIONING");
    await advanceRun(pool, run.id, "IMPLEMENTING");
    const live = await call("POST", `/v1/runs/${run.id}/messages`, { body: { message: "use the existing helper" } });
    assert.equal(live.status, 202);

    await advanceRun(pool, run.id, "CANCELLED");
    const late = await call("POST", `/v1/runs/${run.id}/messages`, { body: { message: "too late" } });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "run_terminal", "a terminal run is a different refusal from a quiet one");
  });
});

test("guidance is queued, not delivered — the API never claims the maker heard it", { skip }, async () => {
  // No control override: this exercises the real `apiControl`, which is the point. The wiring under
  // test is that a message becomes a row and an intent, rather than a call this process cannot make.
  await withApi(
    async ({ pool, call, run }) => {
      await advanceRun(pool, run.id, "CLASSIFYING");
      await advanceRun(pool, run.id, "PLANNING");
      await advanceRun(pool, run.id, "PROVISIONING");
      await advanceRun(pool, run.id, "IMPLEMENTING");

      const sent = await call("POST", `/v1/runs/${run.id}/messages`, {
        body: { message: "use the existing helper" },
      });
      assert.equal(sent.status, 202);
      assert.equal(sent.body.outcome, "queued", '"delivered" would be a claim about an unseen agent');

      const listed = await call("GET", `/v1/runs/${run.id}/messages`);
      assert.equal(listed.body.items.length, 1);
      assert.equal(listed.body.items[0].state, "queued");
      assert.equal(listed.body.items[0].message, "use the existing helper");
      assert.equal(listed.body.items[0].deliveredAt, null);
    },
    (pool) => ({ control: realControl(pool) }),
  );
});

test("a run that ends first reports its guidance superseded, never still queued", { skip }, async () => {
  await withApi(
    async ({ pool, call, run }) => {
      await advanceRun(pool, run.id, "CLASSIFYING");
      await advanceRun(pool, run.id, "PLANNING");
      await advanceRun(pool, run.id, "PROVISIONING");
      await advanceRun(pool, run.id, "IMPLEMENTING");
      await call("POST", `/v1/runs/${run.id}/messages`, { body: { message: "never heard" } });

      await advanceRun(pool, run.id, "CANCELLED");
      const listed = await call("GET", `/v1/runs/${run.id}/messages`);
      assert.equal(
        listed.body.items[0].state,
        "superseded",
        "a finished run must not leave a message reading `queued` forever",
      );
    },
    (pool) => ({ control: realControl(pool) }),
  );
});

test("an empty message is refused before it reaches a worker", { skip }, async () => {
  await withApi(async ({ call, run }) => {
    const result = await call("POST", `/v1/runs/${run.id}/messages`, { body: { message: "   " } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "missing_message");
  });
});

test("a second run is refused while one is in flight — ADR-0009 §3", { skip }, async () => {
  await withApi(async ({ call, task, pool, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING", "seed");
    const result = await call("POST", "/v1/runs", { body: { taskId: task.id } });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "run_in_flight", "a retry must not buy a second sandbox");
  });
});

// --- hand-over: a created run is enqueued (ADR-0023 §10) --------------------

/**
 * Until this change POST /v1/tasks wrote the rows, answered 202, and handed the run to nothing: the
 * run sat in CREATED with no error anywhere. The stubbed port had no way to notice, so these tests
 * record what the handler asks the port to enqueue.
 */
function recordingControl(enqueued, overrides = {}) {
  return stubControl({
    enqueue: async (id) => {
      enqueued.push(id);
      return { enqueued: true };
    },
    ...overrides,
  });
}

test("a task created through the API is handed to the workflow, not left in CREATED", { skip }, async () => {
  const enqueued = [];
  await withApi(
    async ({ call }) => {
      const result = await call("POST", "/v1/tasks", {
        body: { repositoryId: REPO_ID, title: "t", description: "- [ ] it works" },
      });
      assert.equal(result.status, 202);
      assert.equal(result.body.enqueued, true);
      assert.deepEqual(enqueued, [result.body.engineeringRunId], "the run created is the run enqueued");
    },
    { control: recordingControl(enqueued) },
  );
});

test("a task's caps reach its run, and an uncapped or nonsense cap is refused", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    const created = await call("POST", "/v1/tasks", {
      body: { repositoryId: REPO_ID, title: "t", description: "d", spendCapUsd: 3.5, wallClockCapSeconds: 900 },
    });
    assert.equal(created.status, 202);
    const { rows } = await pool.query("select spend_cap_usd, wall_clock_cap_seconds from engineering_run where id = $1", [
      created.body.engineeringRunId,
    ]);
    assert.equal(Number(rows[0].spend_cap_usd), 3.5);
    assert.equal(Number(rows[0].wall_clock_cap_seconds), 900);

    for (const body of [{ spendCapUsd: null }, { spendCapUsd: 0 }, { spendCapUsd: "5" }, { wallClockCapSeconds: 1.5 }]) {
      const refused = await call("POST", "/v1/tasks", {
        body: { repositoryId: REPO_ID, title: "t", description: "d", ...body },
      });
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(refused.body.code, "invalid_field");
    }
    const risk = await call("POST", "/v1/tasks", {
      body: { repositoryId: REPO_ID, title: "t", description: "d", riskLevel: "extreme" },
    });
    assert.equal(risk.status, 400);
  });
});

test("a hand-over that fails is a 503 naming the run, and POST /v1/runs retries it", { skip }, async () => {
  let fail = true;
  const enqueued = [];
  await withApi(
    async ({ call }) => {
      const failed = await call("POST", "/v1/tasks", { body: { repositoryId: REPO_ID, title: "t", description: "d" } });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.code, "enqueue_failed");
      assert.ok(failed.body.engineeringRunId, "the caller is told which run exists and is not carried");
      assert.ok(!failed.body.error.includes("queue unreachable"), "the queue's own error text stays in the log");

      fail = false;
      const retried = await call("POST", "/v1/runs", { body: { taskId: failed.body.taskId } });
      assert.equal(retried.status, 202);
      assert.equal(retried.body.engineeringRunId, failed.body.engineeringRunId, "the same run, not a second one");
      assert.deepEqual(enqueued, [failed.body.engineeringRunId]);
    },
    {
      control: recordingControl(enqueued, {
        enqueue: async (id) => {
          if (fail) throw new Error("queue unreachable");
          enqueued.push(id);
          return { enqueued: true };
        },
      }),
    },
  );
});

test("a new run on a finished task is created with its caps and enqueued", { skip }, async () => {
  const enqueued = [];
  await withApi(
    async ({ call, task, pool, run }) => {
      await advanceRun(pool, run.id, "CLASSIFYING", "seed");
      await advanceRun(pool, run.id, "FAILED", "seed");
      const result = await call("POST", "/v1/runs", { body: { taskId: task.id, spendCapUsd: 2 } });
      assert.equal(result.status, 202);
      assert.notEqual(result.body.engineeringRunId, run.id);
      assert.deepEqual(enqueued, [result.body.engineeringRunId]);
      const { rows } = await pool.query("select spend_cap_usd from engineering_run where id = $1", [
        result.body.engineeringRunId,
      ]);
      assert.equal(Number(rows[0].spend_cap_usd), 2);
    },
    (pool) => ({ control: { ...realControl(pool), enqueue: async (id) => (enqueued.push(id), { enqueued: true }) } }),
  );
});

test("the real command port enqueues through the same client the webhook uses", { skip }, async () => {
  await withApi(async ({ pool, run }) => {
    const started = [];
    const control = apiControl({
      pool,
      control: { cancel: async () => {}, signal: async () => {}, startRun: async (id) => (started.push(id), { enqueued: true }) },
      github: {},
    });
    assert.deepEqual(await control.enqueue(run.id), { enqueued: true });
    assert.deepEqual(started, [run.id]);
  });
});

test("the real command port signals approval directly for an API-created task", { skip }, async () => {
  await withApi(async ({ pool, task, run }) => {
    await pool.query(
      "update engineering_task set source_type = 'api', source_reference = 'api:test' where id = $1",
      [task.id],
    );
    const signals = [];
    const control = apiControl({
      pool,
      control: {
        cancel: async () => {},
        signal: async (id, signal) => signals.push({ id, signal }),
        startRun: async () => ({ enqueued: true }),
      },
      github: {},
    });

    assert.deepEqual(await control.approve(run.id, "operator"), { outcome: "approved" });
    assert.deepEqual(signals, [
      { id: run.id, signal: { type: "approval_granted", actor: "operator" } },
    ]);
  });
});

// --- sandboxes: reap (ADR-0023 §10) ------------------------------------------

function fakeProvider() {
  const destroyed = [];
  return {
    destroyed,
    name: "fake",
    capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: true },
    async create() {
      throw new Error("unused");
    },
    async attach({ handleId }) {
      return { id: handleId, async destroy() { destroyed.push(handleId); } };
    },
  };
}

async function seedDeadSandbox(pool, run) {
  await advanceRun(pool, run.id, "CLASSIFYING", "seed");
  await advanceRun(pool, run.id, "FAILED", "seed");
  return insertWorkspace(pool, {
    engineeringRunId: run.id,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: `sbx-${Math.random().toString(36).slice(2, 10)}`,
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status: "ready",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

test("the reaper's dry run lists what it would destroy and why, and destroys nothing", { skip }, async () => {
  const provider = fakeProvider();
  await withApi(
    async ({ call, pool, run }) => {
      assert.deepEqual((await call("GET", "/v1/sandboxes/reapable")).body.items, [], "a clean database has nothing");
      const workspace = await seedDeadSandbox(pool, run);
      const result = await call("GET", "/v1/sandboxes/reapable");
      assert.equal(result.status, 200);
      assert.equal(result.body.items.length, 1);
      assert.equal(result.body.items[0].providerHandle, workspace.providerHandle);
      assert.equal(result.body.items[0].because, "run_terminal");
      assert.deepEqual(provider.destroyed, [], "a dry run destroys nothing — this is irreversible");
      assert.equal((await getWorkspace(pool, workspace.id)).status, "ready");
    },
    { sandboxes: async () => ({ fake: provider }) },
  );
});

test("reap runs the sweep now and answers with what it did", { skip }, async () => {
  const provider = fakeProvider();
  await withApi(
    async ({ call, pool, run }) => {
      const workspace = await seedDeadSandbox(pool, run);
      const result = await call("POST", "/v1/sandboxes/reap");
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.considered, 1);
      assert.equal(result.body.outcomes[0].kind, "destroyed");
      assert.deepEqual(provider.destroyed, [workspace.providerHandle]);
      assert.equal((await getWorkspace(pool, workspace.id)).status, "destroyed");
    },
    { sandboxes: async () => ({ fake: provider }) },
  );
});

test("reap with no reachable sandbox provider says which variable, rather than a bare 500", { skip }, async () => {
  await withApi(
    async ({ call }) => {
      const result = await call("POST", "/v1/sandboxes/reap");
      assert.equal(result.status, 503);
      assert.equal(result.body.code, "sandbox_unconfigured");
      assert.match(result.body.error, /WINDKEEL_SANDBOX_PROJECT_ID/);
    },
    {
      sandboxes: async () => {
        throw new Error("WINDKEEL_SANDBOX_PROJECT_ID is unset and this process is inside a Vercel deployment");
      },
    },
  );
  await withApi(async ({ call }) => {
    assert.equal((await call("POST", "/v1/sandboxes/reap")).status, 503);
  });
});

// --- sandboxes: capture (ADR-0023 §10, #252) -------------------------------

/** An in-memory stand-in for the evidence bucket, shaped like `CaptureStore`. */
function memoryStore() {
  const objects = new Map();
  const walk = (dir, prefix = "") =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [[`${prefix}${entry.name}`, readFile(join(dir, entry.name), "utf8")]],
    );
  return {
    objects,
    bucket: "evidence-test",
    async put(localDir, key) {
      for (const [path, body] of walk(localDir)) objects.set(`${key}/${path}`, body);
    },
    async list(key) {
      return [...objects.keys()].filter((k) => k.startsWith(`${key}/`)).map((k) => k.slice(key.length + 1));
    },
    async presign(key, path) {
      return `https://store.example/${key}/${path}?sig=x`;
    },
  };
}

async function seedLiveMaker(pool, run, files) {
  const handleId = `capture-${Math.random().toString(36).slice(2, 10)}`;
  const scratchDir = join(tmpdir(), `windkeel-fake-sandbox-${handleId}`, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(scratchDir, name), body);
  await insertWorkspace(pool, {
    engineeringRunId: run.id,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: handleId,
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status: "ready",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await saveSessionBinding(pool, run.id, {
    workerType: "codex",
    sessionRef: { id: "s", workerType: "codex", workerSessionId: "codex-1", adapterState: { scratchDir, turn: 1 } },
    resumable: true,
  });
  return handleId;
}

test("capture stores the maker's scratch directory and serves each file by presigned redirect", { skip }, async () => {
  const store = memoryStore();
  const { FakeSandboxProvider } = await import("../dist/sandbox/fake.js");
  await withApi(
    async ({ call, pool, run }) => {
      await seedLiveMaker(pool, run, { "turn-1.events.jsonl": '{"type":"turn.completed"}\n', "workspace.diff": "diff\n" });
      const captured = await call("POST", `/v1/runs/${run.id}/capture`);
      assert.equal(captured.status, 200, JSON.stringify(captured.body));
      assert.deepEqual(captured.body.stored, ["sandbox/turn-1.events.jsonl", "sandbox/workspace.diff", "session-ref.json"]);
      assert.equal(store.objects.get(`captures/${run.id}/sandbox/workspace.diff`), "diff\n");

      const listed = await call("GET", `/v1/runs/${run.id}/capture`);
      assert.deepEqual(listed.body.items, captured.body.stored);

      const file = await call("GET", `/v1/runs/${run.id}/capture/sandbox/workspace.diff`);
      assert.equal(file.status, 302, "the bytes never pass through the function");
      assert.match(file.headers.location, /workspace\.diff\?sig=/);

      assert.equal((await call("GET", `/v1/runs/${run.id}/capture/nope.txt`)).status, 404);
      assert.equal((await call("GET", `/v1/runs/${run.id}/capture/../x`)).status, 400);
    },
    { captures: store, sandboxes: async () => ({ fake: new FakeSandboxProvider() }) },
  );
});

test("a pruned capture says pruned, not an empty list that reads as never captured (#288)", { skip }, async () => {
  const store = memoryStore();
  const { FakeSandboxProvider } = await import("../dist/sandbox/fake.js");
  const { getRunCapture, runCaptureRetentionSweep } = await import("../dist/factory/capture-retention.js");
  // The sweep's view of the same bucket: `deletePackage` over the capture store's objects.
  const storage = {
    async deletePackage(bucket, key) {
      assert.equal(bucket, store.bucket);
      for (const k of [...store.objects.keys()]) if (k.startsWith(`${key}/`)) store.objects.delete(k);
    },
  };
  await withApi(
    async ({ call, pool, run }) => {
      const never = await call("GET", `/v1/runs/${run.id}/capture`);
      assert.equal(never.status, 200);
      assert.equal(never.body.state, "never_captured");
      assert.deepEqual(never.body.items, []);

      await seedLiveMaker(pool, run, { "turn-1.events.jsonl": '{"type":"turn.completed"}\n' });
      assert.equal((await call("POST", `/v1/runs/${run.id}/capture`)).status, 200);
      const record = await getRunCapture(pool, run.id);
      assert.equal(record.bucket, "evidence-test");
      assert.equal(record.objectKey, `captures/${run.id}`);
      assert.ok(record.byteTotal > 0, "the byte total is what was uploaded");

      const stored = await call("GET", `/v1/runs/${run.id}/capture`);
      assert.equal(stored.body.state, "stored");
      assert.equal(stored.body.prunedAt, null);
      assert.equal(
        new Date(stored.body.expiresAt).getTime() - new Date(stored.body.capturedAt).getTime(),
        30 * 86_400_000,
      );

      const later = new Date(Date.now() + 31 * 86_400_000);
      assert.deepEqual((await runCaptureRetentionSweep(pool, storage, later)).prunedRunIds, [run.id]);
      assert.equal(store.objects.size, 0);

      const pruned = await call("GET", `/v1/runs/${run.id}/capture`);
      assert.equal(pruned.status, 200);
      assert.equal(pruned.body.state, "pruned");
      assert.deepEqual(pruned.body.items, []);
      assert.equal(new Date(pruned.body.prunedAt).getTime(), later.getTime());

      const file = await call("GET", `/v1/runs/${run.id}/capture/session-ref.json`);
      assert.equal(file.status, 409, "pruned is not 404: the file existed and retention removed it");
      assert.equal(file.body.code, "capture_pruned");
    },
    { captures: store, sandboxes: async () => ({ fake: new FakeSandboxProvider() }) },
  );
});

test("a capture with no sandbox left is 409 with the reason, and an earlier capture survives it", { skip }, async () => {
  const store = memoryStore();
  await withApi(
    async ({ call, run }) => {
      store.objects.set(`captures/${run.id}/session-ref.json`, "{}");
      const result = await call("POST", `/v1/runs/${run.id}/capture`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "capture_unavailable");
      assert.match(result.body.error, /no worker session binding/);
      assert.deepEqual((await call("GET", `/v1/runs/${run.id}/capture`)).body.items, ["session-ref.json"]);
    },
    { captures: store, sandboxes: async () => ({}) },
  );
});

test("capture with no object store answers 503, like evidence", { skip }, async () => {
  await withApi(async ({ call, run }) => {
    const result = await call("POST", `/v1/runs/${run.id}/capture`);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "storage_unconfigured");
  });
});

// --- repository secrets (ADR-0023 §9) --------------------------------------

test("a secret round-trips by name and never by value", { skip }, async () => {
  await withApi(
    async ({ call }) => {
      const set = await call("POST", `/v1/repositories/${REPO_ID}/secrets`, {
        body: { key: "NPM_TOKEN", value: "npm_s3cret_value", note: "read-only" },
      });
      assert.equal(set.status, 200, "the row has committed; 202 would mean ask again later");
      assert.equal(set.body.key, "NPM_TOKEN");
      assert.equal(set.body.setBy, "operator");

      const listed = await call("GET", `/v1/repositories/${REPO_ID}/secrets`);
      assert.equal(listed.status, 200);
      assert.deepEqual(
        listed.body.items.map((item) => item.key),
        ["NPM_TOKEN"],
      );
      const serialised = JSON.stringify([set.body, listed.body]);
      assert.ok(
        !serialised.includes("npm_s3cret_value"),
        "no response may carry a secret value — ADR-0023 §9 has no field for it",
      );
      for (const item of listed.body.items) {
        assert.ok(!("value" in item), "a `value` key must not exist even holding null");
      }
    },
    { secretPublicKey: PUBLIC_KEY },
  );
});

test("setting a secret twice rotates it rather than leaving two rows", { skip }, async () => {
  await withApi(
    async ({ pool, call }) => {
      await call("POST", `/v1/repositories/${REPO_ID}/secrets`, {
        body: { key: "NPM_TOKEN", value: "first" },
      });
      await call("POST", `/v1/repositories/${REPO_ID}/secrets`, {
        body: { key: "NPM_TOKEN", value: "second", note: "rotated" },
      });
      const { rows } = await pool.query("select key, note from repository_secret");
      assert.equal(rows.length, 1, "two rows would make injection order depend on which id sorted first");
      assert.equal(rows[0].note, "rotated");

      const { rows: org } = await pool.query("select id from organization where is_default");
      const { values } = await resolveRepositorySecrets(pool, org[0].id, REPO_ID, PRIVATE_KEY);
      assert.equal(values.NPM_TOKEN, "second");
    },
    { secretPublicKey: PUBLIC_KEY },
  );
});

test("a name that would shadow a brokered credential is refused with the rule", { skip }, async () => {
  await withApi(
    async ({ call }) => {
      for (const key of ["OPENAI_API_KEY", "PATH", "WINDKEEL_MAKER_MODEL", "lowercase"]) {
        const result = await call("POST", `/v1/repositories/${REPO_ID}/secrets`, {
          body: { key, value: "x" },
        });
        assert.equal(result.status, 400, `${key} must be refused`);
        assert.equal(result.body.code, "invalid_secret_key");
        assert.ok(result.body.error.length > 40, "the refusal has to say which rule and why");
      }
    },
    { secretPublicKey: PUBLIC_KEY },
  );
});

test("with no public key the API refuses rather than storing a value it cannot protect", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const result = await call("POST", `/v1/repositories/${REPO_ID}/secrets`, {
      body: { key: "NPM_TOKEN", value: "plaintext" },
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "secrets_disabled");
    const { rows } = await pool.query("select 1 from repository_secret");
    assert.equal(rows.length, 0, "a refused write must not have stored anything");
  });
});

test("deleting a secret that is not there is a 404, not a silent success", { skip }, async () => {
  await withApi(
    async ({ call }) => {
      const absent = await call("POST", `/v1/repositories/${REPO_ID}/secrets/NOPE/delete`);
      assert.equal(absent.status, 404);

      await call("POST", `/v1/repositories/${REPO_ID}/secrets`, {
        body: { key: "NPM_TOKEN", value: "x" },
      });
      const removed = await call("POST", `/v1/repositories/${REPO_ID}/secrets/NPM_TOKEN/delete`);
      assert.equal(removed.status, 200);
      assert.equal(removed.body.deleted, "NPM_TOKEN");
    },
    { secretPublicKey: PUBLIC_KEY },
  );
});

test("secrets for an unknown repository are 404, not an empty list", { skip }, async () => {
  await withApi(async ({ call }) => {
    const result = await call("GET", "/v1/repositories/99999999-9999-9999-9999-999999999999/secrets");
    assert.equal(result.status, 404, "an empty list would read as `this repository has none`");
  });
});

// --- model credentials (ADR-0026 §1–3, M9-2 #320) ---------------------------

const MODEL_KEY = "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";

/** A recording validation port: ids in, and nothing else is ever handed to it. */
function validationPort(fail = false) {
  const requests = [];
  return {
    requests,
    port: {
      request: async (...args) => {
        requests.push(args);
        if (fail) throw new Error("queue unavailable");
      },
    },
  };
}

/** Everything written to stdout while `fn` runs — where `defaultLog` writes. */
async function capturingStdout(fn) {
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stdout, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return lines.join("");
}

test("a model credential round-trips by label and last four, never by value", { skip }, async () => {
  const { requests, port } = validationPort();
  await withApi(
    async ({ pool, call }) => {
      let created;
      let listed;
      const logged = await capturingStdout(async () => {
        created = await call("POST", "/v1/model-credentials", {
          body: { provider: "openai", label: "prod", value: MODEL_KEY },
        });
        listed = await call("GET", "/v1/model-credentials");
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.credential.status, "unverified");
      assert.equal(created.body.credential.last4, MODEL_KEY.slice(-4));
      assert.equal(created.body.validation, "started");
      assert.deepEqual(listed.body.items.map((c) => c.label), ["prod"]);

      const { rows: org } = await pool.query("select id from organization where is_default");
      assert.deepEqual(requests, [[org[0].id, created.body.credential.id]], "ids, and only ids, go to the check");

      const serialised = JSON.stringify([created.body, listed.body]);
      assert.ok(!serialised.includes(MODEL_KEY), "no response may carry a model key");
      assert.ok(!serialised.includes("orqonsealv2"), "nor its ciphertext");
      for (const item of listed.body.items) {
        assert.ok(!("value" in item) && !("sealedValue" in item), "no field exists for a value");
      }
      assert.ok(!logged.includes(MODEL_KEY), "nothing logged a model key");
    },
    { secretPublicKey: PUBLIC_KEY, credentialValidation: port, modelEndpoint: { resolve: async () => ["93.184.216.34"] } },
  );
});

test("rotate (PUT) resets to unverified and starts a fresh check; revoke (DELETE) is final", { skip }, async () => {
  const { requests, port } = validationPort();
  await withApi(
    async ({ pool, call }) => {
      const created = (await call("POST", "/v1/model-credentials", { body: { provider: "anthropic", label: "a", value: MODEL_KEY } })).body.credential;
      await pool.query("update model_credential set status = 'valid' where id = $1", [created.id]);

      const rotated = await call("PUT", `/v1/model-credentials/${created.id}`, { body: { value: "sk-ant-api03-SecondKey5678" } });
      assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
      assert.equal(rotated.body.credential.id, created.id);
      assert.equal(rotated.body.credential.status, "unverified");
      assert.equal(rotated.body.credential.last4, "5678");
      assert.equal(requests.length, 2);
      assert.ok(!JSON.stringify(rotated.body).includes("SecondKey"));

      const revoked = await call("DELETE", `/v1/model-credentials/${created.id}`);
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.credential.status, "revoked");
      assert.equal((await call("PUT", `/v1/model-credentials/${created.id}`, { body: { value: MODEL_KEY } })).status, 404);
      assert.equal((await call("POST", `/v1/model-credentials/${created.id}/validate`)).status, 409);
      assert.deepEqual((await call("GET", "/v1/model-credentials")).body.items, []);
      assert.equal((await call("GET", "/v1/model-credentials", { query: { include: "revoked" } })).body.items.length, 1);
    },
    { secretPublicKey: PUBLIC_KEY, credentialValidation: port },
  );
});

test("model credential refusals: no public key, bad fields, a private base URL, a taken label", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const disabled = await call("POST", "/v1/model-credentials", { body: { provider: "openai", label: "p", value: MODEL_KEY } });
    assert.equal(disabled.status, 503);
    assert.equal(disabled.body.code, "secrets_disabled");
    assert.equal((await call("PUT", "/v1/model-credentials/00000000-0000-4000-8000-000000000000", { body: { value: MODEL_KEY } })).body.code, "secrets_disabled");
    assert.equal((await pool.query("select 1 from model_credential")).rows.length, 0);
  });
  await withApi(
    async ({ call }) => {
      const cases = [
        [{ provider: "nope", label: "p", value: MODEL_KEY }, "invalid_model_credential"],
        [{ provider: "openai", label: "p" }, "invalid_model_credential"],
        [{ provider: "openai", label: "p", value: MODEL_KEY, baseUrl: "https://169.254.169.254/" }, "unsafe_base_url"],
        [{ provider: "openai-compatible", label: "p", value: MODEL_KEY, baseUrl: "http://llm.example.com/v1" }, "unsafe_base_url"],
        [{ provider: "openai-compatible", label: "p", value: MODEL_KEY, baseUrl: "https://intranet.example.com" }, "unsafe_base_url"],
      ];
      for (const [body, code] of cases) {
        const result = await call("POST", "/v1/model-credentials", { body });
        assert.equal(result.status, 400, JSON.stringify(body));
        assert.equal(result.body.code, code);
        assert.ok(!JSON.stringify(result.body).includes(MODEL_KEY), "a refusal never echoes the value");
      }
      assert.equal((await call("POST", "/v1/model-credentials", { body: { provider: "openai", label: "p", value: MODEL_KEY } })).status, 201);
      const taken = await call("POST", "/v1/model-credentials", { body: { provider: "openai", label: "p", value: MODEL_KEY } });
      assert.equal(taken.status, 409);
      assert.equal(taken.body.code, "label_taken");
    },
    {
      secretPublicKey: PUBLIC_KEY,
      modelEndpoint: { resolve: async (host) => (host === "intranet.example.com" ? ["10.1.2.3"] : ["93.184.216.34"]) },
    },
  );
});

test("a check that cannot start still stores the credential, says so, and can be retried", { skip }, async () => {
  const failing = validationPort(true);
  await withApi(
    async ({ call }) => {
      const created = await call("POST", "/v1/model-credentials", { body: { provider: "openai", label: "p", value: MODEL_KEY } });
      assert.equal(created.status, 201);
      assert.equal(created.body.validation, "failed");
      const retried = await call("POST", `/v1/model-credentials/${created.body.credential.id}/validate`);
      assert.equal(retried.status, 503);
      assert.equal(retried.body.code, "validation_unavailable");
    },
    { secretPublicKey: PUBLIC_KEY, credentialValidation: failing.port },
  );
  const working = validationPort();
  await withApi(
    async ({ call }) => {
      const created = await call("POST", "/v1/model-credentials", { body: { provider: "openai", label: "p", value: MODEL_KEY } });
      const retried = await call("POST", `/v1/model-credentials/${created.body.credential.id}/validate`);
      assert.equal(retried.status, 202);
      assert.equal(retried.body.accepted, true);
      assert.equal(working.requests.length, 2);
    },
    { secretPublicKey: PUBLIC_KEY, credentialValidation: working.port },
  );
});

test("listing needs models.read; changing needs models.manage, which a default token lacks", { skip }, async () => {
  await withApi(
    async ({ call }) => {
      const token = async (body) => (await call("POST", "/v1/tokens", { body: { name: "t", ...body } })).body.secret;
      const reader = await token({ permissions: ["models.read"] });
      const executor = await token({ preset: "execute" });
      const admin = await token({ preset: "admin" });
      const as = (secret) => ({ headers: { authorization: `Bearer ${secret}` } });

      assert.equal((await call("GET", "/v1/model-credentials", as(reader))).status, 200);
      const readOnly = await call("POST", "/v1/model-credentials", { ...as(reader), body: { provider: "openai", label: "p", value: MODEL_KEY } });
      assert.equal(readOnly.status, 403);
      assert.equal(readOnly.body.missing, "models.manage");
      assert.equal((await call("GET", "/v1/model-credentials", as(executor))).body.missing, "models.read");

      const created = await call("POST", "/v1/model-credentials", { ...as(admin), body: { provider: "openai", label: "p", value: MODEL_KEY } });
      assert.equal(created.status, 201);
      const id = created.body.credential.id;
      for (const [method, path] of [
        ["PUT", `/v1/model-credentials/${id}`],
        ["DELETE", `/v1/model-credentials/${id}`],
        ["POST", `/v1/model-credentials/${id}/validate`],
      ]) {
        const refused = await call(method, path, { ...as(reader), body: { value: MODEL_KEY } });
        assert.equal(refused.status, 403, `${method} ${path}`);
      }
    },
    { secretPublicKey: PUBLIC_KEY },
  );
});

test("one organization cannot see, rotate or revoke another's credential", { skip }, async () => {
  await withApi(
    async ({ pool, call }) => {
      const { rows: def } = await pool.query("select id from organization where is_default");
      const { rows: other } = await pool.query(
        `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
         returning id`,
      );
      // The bootstrap principal administers both; each is addressed by its own prefix.
      const role = (await pool.query("select id from access_role where key = 'admin' and account_id is null")).rows[0].id;
      const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
      await pool.query("insert into membership (organization_id, principal_id, access_role_id) values ($1, $2, $3)", [other[0].id, operator, role]);

      const mine = await call("POST", `/v1/orgs/${def[0].id}/model-credentials`, { body: { provider: "openai", label: "p", value: MODEL_KEY } });
      assert.equal(mine.status, 201);
      const id = mine.body.credential.id;
      const theirs = `/v1/orgs/${other[0].id}/model-credentials`;
      assert.deepEqual((await call("GET", theirs)).body.items, []);
      assert.equal((await call("PUT", `${theirs}/${id}`, { body: { value: "sk-other-12345678" } })).status, 404);
      assert.equal((await call("DELETE", `${theirs}/${id}`)).status, 404);
      assert.equal((await call("POST", `${theirs}/${id}/validate`)).status, 404);
      const row = (await pool.query("select status, last4 from model_credential where id = $1", [id])).rows[0];
      assert.deepEqual(row, { status: "unverified", last4: MODEL_KEY.slice(-4) }, "untouched");
    },
    { secretPublicKey: PUBLIC_KEY },
  );
});

// --- the stream ------------------------------------------------------------

test("the stream drains a backlog, then closes with a cursor when its budget ends", { skip }, async () => {
  await withApi(async ({ pool, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");

    const chunks = [];
    let clock = 0;
    const outcome = await streamRunEvents(
      pool,
      run.id,
      { write: (c) => chunks.push(c), writable: () => true },
      "0",
      {
        budgetMs: 10,
        pollMs: 5,
        keepAliveMs: 1000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );

    assert.equal(outcome.reason, "budget_exhausted");
    assert.equal(outcome.eventsSent, 2, "the backlog is drained in full, not one page per tick");
    const wire = chunks.join("");
    assert.match(wire, /event: cursor/);
    assert.match(wire, /"reconnect":true/);
    assert.equal(outcome.cursor, String(Number(outcome.cursor)));
  });
});

test("a terminal run closes the stream and tells the client not to reconnect", { skip }, async () => {
  await withApi(async ({ pool, run }) => {
    await advanceRun(pool, run.id, "CANCELLED");

    const chunks = [];
    const outcome = await streamRunEvents(
      pool,
      run.id,
      { write: (c) => chunks.push(c), writable: () => true },
      "0",
      { budgetMs: 10_000, pollMs: 1, keepAliveMs: 1000, now: () => 0, sleep: async () => {} },
    );

    assert.equal(outcome.reason, "run_terminal");
    assert.match(chunks.join(""), /"reconnect":false/);
  });
});

test("the stream emits exactly what the polling endpoint would, in the same order", { skip }, async () => {
  await withApi(async ({ pool, call, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "agent_run",
      stageId: "22222222-2222-2222-2222-222222222222",
      kind: "model",
      usd: 0.01,
    });
    await advanceRun(pool, run.id, "PLANNING");

    const polled = await call("GET", `/v1/runs/${run.id}/events`);

    const chunks = [];
    let clock = 0;
    await streamRunEvents(
      pool,
      run.id,
      { write: (c) => chunks.push(c), writable: () => true },
      "0",
      { budgetMs: 1, pollMs: 1, keepAliveMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; } },
    );

    const streamed = chunks
      .join("")
      .split("\n\n")
      .filter((b) => b.includes("event: transition") || b.includes("event: cost"))
      .map((b) => JSON.parse(b.split("data: ")[1]));

    assert.deepEqual(
      streamed.map((e) => e.cursor),
      polled.body.items.map((e) => e.cursor),
      "SSE is a transport over the feed; a streaming and a polling client cannot diverge",
    );
  });
});

test("the stream stops writing the moment the client is gone", { skip }, async () => {
  await withApi(async ({ pool, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    const chunks = [];
    const outcome = await streamRunEvents(
      pool,
      run.id,
      { write: (c) => chunks.push(c), writable: () => false },
      "0",
      { budgetMs: 1000, pollMs: 1, keepAliveMs: 10, now: () => 0, sleep: async () => {} },
    );
    assert.equal(outcome.reason, "client_gone");
    assert.equal(chunks.length, 0, "nothing is written into a dead socket, not even the closing cursor");
  });
});

// --- model policy (M9-3) ---------------------------------------------------

test("model policy: set, read and clear per layer; a task's models reach its row; a run shows its snapshot", { skip }, async () => {
  await withApi(
    async ({ pool, call, run }) => {
      const created = (await call("POST", "/v1/model-credentials", { body: { provider: "openrouter", label: "router", value: MODEL_KEY } })).body.credential;

      const set = await call("PUT", "/v1/model-policy", {
        body: { maker: { provider: "openai", model: "gpt-5" }, checker: { model: "google/gemini-2.5-pro", credentialId: created.id } },
      });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual(set.body.items.map((p) => [p.role, p.provider, p.keySource]), [
        ["maker", "openai", "orqon"],
        ["checker", "openrouter", "customer"],
      ]);
      const repo = await call("PUT", "/v1/model-policy", { query: { repositoryId: REPO_ID }, body: { maker: { provider: "openai", model: "gpt-5-mini" } } });
      assert.equal(repo.status, 200, JSON.stringify(repo.body));
      assert.equal((await call("GET", "/v1/model-policy")).body.items.length, 2);
      assert.equal((await call("GET", "/v1/model-policy", { query: { repositoryId: REPO_ID } })).body.items.length, 3);
      assert.equal((await call("GET", "/v1/model-policy", { query: { repositoryId: "00000000-0000-4000-8000-000000000000" } })).status, 404);

      // Refused before anything is written: a declared vendor contradicting the model's own.
      const conflict = await call("PUT", "/v1/model-policy", { body: { checker: { model: "anthropic/claude-opus-4.1", credentialId: created.id, declaredVendor: "google" } } });
      assert.equal(conflict.status, 400);
      assert.equal(conflict.body.code, "invalid_model_policy");

      const cleared = await call("DELETE", "/v1/model-policy", { query: { repositoryId: REPO_ID } });
      assert.deepEqual(cleared.body, { repositoryId: REPO_ID, deleted: 1 });

      const task = await call("POST", "/v1/tasks", {
        body: { repositoryId: REPO_ID, title: "t", description: "- [ ] it works", models: { maker: "gpt-5-codex", checker: { model: "claude-opus-4-1", provider: "anthropic" } } },
      });
      assert.equal(task.status, 202, JSON.stringify(task.body));
      const { rows } = await pool.query("select model_override from engineering_task where id = $1", [task.body.taskId]);
      assert.deepEqual(rows[0].model_override, {
        maker: { model: "gpt-5-codex" },
        checker: [{ model: "claude-opus-4-1", provider: "anthropic" }],
      });
      const bad = await call("POST", "/v1/tasks", { body: { repositoryId: REPO_ID, title: "t", description: "d", models: { maker: { model: "x", provider: "bedrock" } } } });
      assert.equal(bad.status, 400);
      const missing = await call("POST", "/v1/tasks", {
        body: { repositoryId: REPO_ID, title: "t", description: "d", models: { maker: { model: "x", credentialId: "00000000-0000-4000-8000-000000000000" } } },
      });
      assert.equal(missing.status, 404);

      assert.equal((await call("GET", `/v1/runs/${run.id}`)).body.modelConfig, null, "no snapshot before intake");
      const snapshot = { version: 1, maker: { provider: "openai", vendor: "openai", model: "gpt-5", keySource: "orqon", source: "organization" }, checker: [], resolvedAt: "2026-10-06T00:00:00.000Z", policyIds: [] };
      await pool.query("update engineering_run set model_config = $2 where id = $1", [run.id, JSON.stringify(snapshot)]);
      assert.deepEqual((await call("GET", `/v1/runs/${run.id}`)).body.modelConfig, snapshot);
      assert.ok(!JSON.stringify(set.body).includes(MODEL_KEY));
    },
    { secretPublicKey: PUBLIC_KEY, control: recordingControl([]) },
  );
});
