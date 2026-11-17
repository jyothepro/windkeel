import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { recordingActions } from "../apps/ingress/dist/src/actions.js";
import { loadIngressConfig, MissingConfigError } from "../apps/ingress/dist/src/config.js";
import { handleWebhook } from "../apps/ingress/dist/src/handler.js";
import { signWebhookBody, verifyWebhookSignature } from "../apps/ingress/dist/src/signature.js";
import { getRepositoryByFullName } from "../dist/factory/repository-entity.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase, migratedDatabaseUrl } from "./migrated-db.js";

const SECRET = "it's a secret to everybody";
const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let schemaSerial = 0;

const PAYLOAD = {
  action: "labeled",
  installation: { id: 42 },
  sender: { login: "operator" },
  label: { name: "windkeel" },
  repository: {
    owner: { login: "jyothepro" },
    name: "windkeel-fixture",
    full_name: "jyothepro/windkeel-fixture",
    default_branch: "trunk",
    clone_url: "https://github.com/jyothepro/windkeel-fixture.git",
    fork: false,
  },
  issue: {
    number: 7,
    title: "Uploader retries are missing",
    body: "It gives up on the first 500.",
    labels: [{ name: "windkeel" }],
    html_url: "https://github.com/jyothepro/windkeel-fixture/issues/7",
    user: { login: "someone" },
  },
};

function request(body, options = {}) {
  const { event = "issues", delivery = "delivery-1", secret = SECRET } = options;
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  // `"signature" in options` rather than a default, so a test can send *no* header at all —
  // which a `?? sign(...)` default would silently turn into a valid one.
  const signature = "signature" in options ? options.signature : signWebhookBody(secret, rawBody);
  return {
    headers: {
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature,
    },
    rawBody,
  };
}

/**
 * GitHub's answer for the `operator` who applies the label in these deliveries: write access. The
 * label is authorised like a command since ORQ-11 (`authorizeLabeler`), so a delivery with no
 * lookup wired is refused; the refusal itself has its own tests below.
 */
const LABELLER = {
  async getCollaboratorPermission() {
    return { permission: "write", roleName: "write" };
  },
};

/** A pool that fails the test if the handler touches it. Rejection must precede persistence. */
const forbiddenPool = {
  connect() {
    throw new Error("the handler opened a connection when it should have rejected first");
  },
};

// --- Signature (ADR-0009 §6) ---

test("a correct signature over the raw body passes; a tampered body does not", () => {
  const raw = JSON.stringify(PAYLOAD);
  const good = signWebhookBody(SECRET, raw);
  assert.equal(verifyWebhookSignature(SECRET, raw, good), true);

  // One byte changed: the classic "re-serialised after parsing" failure looks exactly like this.
  const tampered = `${raw.slice(0, -2)}}`;
  assert.equal(verifyWebhookSignature(SECRET, tampered, good), false);
  assert.equal(verifyWebhookSignature("another secret", raw, good), false);
  assert.equal(verifyWebhookSignature(SECRET, raw, undefined), false);
  assert.equal(verifyWebhookSignature(SECRET, raw, "not-a-signature"), false);
  assert.equal(verifyWebhookSignature(SECRET, raw, good.replace("sha256=", "sha1=")), false);
  // A truncated signature must not throw — timingSafeEqual rejects mismatched lengths.
  assert.equal(verifyWebhookSignature(SECRET, raw, good.slice(0, 20)), false);
});

test("every signature rejection is a 401 and never reaches the database", async () => {
  const actions = recordingActions();
  const cases = [
    { name: "wrong secret", req: request(PAYLOAD, { secret: "wrong" }) },
    { name: "missing header", req: request(PAYLOAD, { signature: undefined }) },
    { name: "garbage header", req: request(PAYLOAD, { signature: "sha256=00" }) },
  ];
  // A body that was signed correctly and then modified.
  const tampered = request(PAYLOAD);
  tampered.rawBody = `${tampered.rawBody} `;
  cases.push({ name: "tampered body", req: tampered });

  for (const { name, req } of cases) {
    const response = await handleWebhook(req, { secret: SECRET, pool: forbiddenPool, actions });
    assert.equal(response.status, 401, name);
    assert.equal(response.body.ok, false);
  }
  assert.deepEqual(actions.recorded, [], "no action ran for any rejected delivery");
});

test("a missing header is a 400, and a missing signature is not treated as absent-but-fine", async () => {
  const actions = recordingActions();
  const req = request(PAYLOAD);
  delete req.headers["x-github-delivery"];
  const response = await handleWebhook(req, { secret: SECRET, pool: forbiddenPool, actions });
  assert.equal(response.status, 400);
  assert.deepEqual(actions.recorded, []);
});

/**
 * Changed in M8 (ADR-0025 §4, #293): an ignored event is now *recorded* in `intake_delivery` with
 * its reason — it used to be answered without touching the database. The answer is unchanged.
 */
test("an ignored event is a 2xx carrying its reason, recorded with no action run", { skip }, async () => {
  await withSchema(async (pool) => {
    const actions = recordingActions();
    const ignored = request({ ...PAYLOAD, label: { name: "bug" } });
    const response = await handleWebhook(ignored, { secret: SECRET, pool, actions });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body), ["ok", "intent", "reason"]);
    assert.equal(response.body.intent, "ignore");
    assert.match(response.body.reason, /not the trigger/);
    assert.deepEqual(actions.recorded, []);

    const { rows } = await pool.query("select source, delivery_key, event, action, intent, reason from intake_delivery");
    assert.deepEqual(rows, [
      {
        source: "github",
        delivery_key: "delivery-1",
        event: "issues",
        action: "labeled",
        intent: "ignore",
        reason: response.body.reason,
      },
    ]);

    const again = await handleWebhook(ignored, { secret: SECRET, pool, actions });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true, "a redelivered ignored event is a duplicate");
  });
});

test("a body that is not JSON is a 400, not a 500: a retry will not fix it", async () => {
  const response = await handleWebhook(request("{not json"), {
    secret: SECRET,
    pool: forbiddenPool,
    actions: recordingActions(),
  });
  assert.equal(response.status, 400);
});

test("a database failure is a 5xx so GitHub retries, and never echoes the payload", async () => {
  const failingPool = {
    async connect() {
      throw new Error("connection refused");
    },
  };
  const response = await handleWebhook(request(PAYLOAD), {
    secret: SECRET,
    pool: failingPool,
    actions: recordingActions(),
  });
  assert.equal(response.status, 500);
  const serialized = JSON.stringify(response.body);
  assert.ok(!serialized.includes("Uploader retries"), "the payload is not echoed back");
  assert.ok(!serialized.includes(SECRET));
});

test("configuration failure names the variable", () => {
  assert.throws(() => loadIngressConfig({}), MissingConfigError);
  assert.throws(() => loadIngressConfig({}), /DATABASE_POOL_URL/);
  assert.throws(() => loadIngressConfig({ DATABASE_URL: "postgres://x" }), /GITHUB_WEBHOOK_SECRET/);
  assert.deepEqual(
    loadIngressConfig({ DATABASE_URL: "postgres://x", GITHUB_WEBHOOK_SECRET: "s" }),
    { databaseUrl: "postgres://x", webhookSecret: "s" },
  );
  assert.deepEqual(
    loadIngressConfig({
      DATABASE_URL: "postgres://session",
      DATABASE_POOL_URL: "postgres://transaction",
      GITHUB_WEBHOOK_SECRET: "s",
    }),
    { databaseUrl: "postgres://transaction", webhookSecret: "s" },
  );
});

// --- Postgres-gated: the rows a delivery actually writes ---

async function withSchema(fn) {
  const schema = `windkeel_ingress_test_${Date.now()}_${schemaSerial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool, schema);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test("a signed delivery records itself, upserts the repository, and calls the action", { skip }, async () => {
  await withSchema(async (pool) => {
    const actions = recordingActions();
    const response = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions, permissions: LABELLER });

    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "create_task");

    const repository = await getRepositoryByFullName(pool, "jyothepro", "windkeel-fixture");
    assert.equal(repository.defaultBranch, "trunk");
    assert.equal(repository.githubInstallationId, 42);

    const { rows } = await pool.query("select * from intake_delivery");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_key, "delivery-1");
    assert.equal(rows[0].source, "github");
    assert.equal(rows[0].event, "issues");
    assert.equal(rows[0].action, "labeled");
    assert.equal(rows[0].intent, "create_task");

    assert.equal(actions.recorded.length, 1);
    assert.equal(actions.recorded[0].kind, "create_task");
    assert.equal(actions.recorded[0].repositoryId, repository.id);
  });
});

test("the same delivery twice produces one artifact and two 2xx responses", { skip }, async () => {
  await withSchema(async (pool) => {
    const actions = recordingActions();
    const first = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions, permissions: LABELLER });
    const second = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions, permissions: LABELLER });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true, "GitHub redelivers; the second one does nothing");
    assert.equal(actions.recorded.length, 1);
    const { rows } = await pool.query("select count(*)::int as n from intake_delivery");
    assert.equal(rows[0].n, 1);
  });
});

test("two concurrent copies of one delivery still act once", { skip }, async () => {
  await withSchema(async (pool, schema) => {
    const actions = recordingActions();
    const other = new Pool({ connectionString: migratedDatabaseUrl(schema), ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      // Separate pools: two real connections racing on the delivery primary key, which is the
      // arrangement the transaction ordering in handler.ts exists to survive.
      const [a, b] = await Promise.all([
        handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions, permissions: LABELLER }),
        handleWebhook(request(PAYLOAD), { secret: SECRET, pool: other, actions, permissions: LABELLER }),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(actions.recorded.length, 1);
      assert.ok(a.body.duplicate === true || b.body.duplicate === true, "exactly one was the duplicate");
    } finally {
      await other.end();
    }
  });
});

test("a failing action rolls the delivery record back, so the retry can succeed", { skip }, async () => {
  await withSchema(async (pool) => {
    let attempts = 0;
    const flaky = {
      ...recordingActions(),
      async createTask() {
        attempts++;
        if (attempts === 1) throw new Error("transient");
      },
    };
    const first = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions: flaky, permissions: LABELLER });
    assert.equal(first.status, 500, "GitHub is told to retry");

    // The whole point of committing the delivery record with the work: a failed delivery leaves
    // no record claiming it was handled.
    const after = await pool.query("select count(*)::int as n from intake_delivery");
    assert.equal(after.rows[0].n, 0);

    const retry = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions: flaky, permissions: LABELLER });
    assert.equal(retry.status, 200);
    assert.equal(attempts, 2);
  });
});

test("two different deliveries about one issue cannot create two tasks", { skip }, async () => {
  await withSchema(async (pool, schema) => {
    // The guarantee lives in the database (migrations/0006's partial unique index), because two
    // deliveries with different ids are not deduplicated by the delivery record. M6.5's intake
    // relies on exactly this.
    const repository = await pool.query(
      `insert into repository (owner, name, default_branch, clone_url)
       values ('jyothepro', 'windkeel-fixture', 'trunk', 'https://example/x.git') returning id`,
    );
    const repositoryId = repository.rows[0].id;
    const insertTask = (db) =>
      db.query(
        `insert into engineering_task
           (repository_id, source_type, source_reference, title, description, risk_level, status,
            organization_id)
         values ($1, 'github_issue', '7', 't', 'd', 'low', 'OPEN',
                 (select id from organization where is_default))`,
        [repositoryId],
      );

    const other = new Pool({ connectionString: migratedDatabaseUrl(schema), ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      const results = await Promise.allSettled([insertTask(pool), insertTask(other)]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      assert.equal(fulfilled.length, 1, "one task per issue, arbitrated by the database");
    } finally {
      await other.end();
    }
  });
});

test("the real actions turn a labelled-issue delivery into a task and an enqueued run", { skip }, async () => {
  await withSchema(async (pool) => {
    const { FakeGitHubClient } = await import("../dist/github/fake.js");
    const { windkeelActions } = await import("../apps/ingress/dist/src/windkeel-actions.js");
    const { getEngineeringTaskBySource, listEngineeringRuns } = await import(
      "../dist/factory/repositories.js"
    );

    const github = new FakeGitHubClient({
      repositories: [
        {
          owner: "jyothepro",
          name: "windkeel-fixture",
          issues: [{ number: 7, title: PAYLOAD.issue.title, body: PAYLOAD.issue.body }],
        },
      ],
    });
    const enqueued = [];
    const actions = windkeelActions({
      github,
      enqueue: {
        async startRun(runId) {
          enqueued.push(runId);
          return { enqueued: true };
        },
        async stop() {},
      },
    });

    const withCriteria = {
      ...PAYLOAD,
      issue: { ...PAYLOAD.issue, state: "open", body: "- [ ] retries a 500 three times" },
    };
    const response = await handleWebhook(request(withCriteria), { secret: SECRET, pool, actions, permissions: LABELLER });
    assert.equal(response.status, 200);

    const repository = await getRepositoryByFullName(pool, "jyothepro", "windkeel-fixture");
    const task = await getEngineeringTaskBySource(
      pool,
      repository.id,
      "github_issue",
      "jyothepro/windkeel-fixture#7",
    );
    assert.ok(task, "the label created a task");
    assert.deepEqual(
      task.acceptanceCriteria.map((c) => c.text),
      ["retries a 500 three times"],
    );

    const runs = await listEngineeringRuns(pool, task.id);
    assert.equal(runs.length, 1);
    assert.deepEqual(enqueued, [runs[0].id], "enqueued after the transaction committed");
    assert.equal(github.commentsOn({ owner: "jyothepro", name: "windkeel-fixture" }, 7).length, 1);

    // The delivery row records what the event turned out to mean, not just what it was.
    const { rows } = await pool.query("select intent from intake_delivery");
    assert.equal(rows[0].intent, "create_task:started");
  });
});

test("if enqueuing fails after commit, the delivery record is released so a retry can finish", { skip }, async () => {
  await withSchema(async (pool) => {
    const { FakeGitHubClient } = await import("../dist/github/fake.js");
    const { windkeelActions } = await import("../apps/ingress/dist/src/windkeel-actions.js");

    const github = new FakeGitHubClient({
      repositories: [{ owner: "jyothepro", name: "windkeel-fixture", issues: [{ number: 7 }] }],
    });
    let attempts = 0;
    const actions = windkeelActions({
      github,
      enqueue: {
        async startRun(runId) {
          attempts++;
          if (attempts === 1) throw new Error("queue unavailable");
          return { enqueued: true };
        },
        async stop() {},
      },
    });

    const first = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions, permissions: LABELLER });
    assert.equal(first.status, 500, "GitHub is told to retry");
    const released = await pool.query("select count(*)::int as n from intake_delivery");
    assert.equal(released.rows[0].n, 0, "the delivery record did not survive the failure");

    // The retry finds the task it already created, sees the run is still unstarted, and enqueues.
    const retry = await handleWebhook(request(PAYLOAD), { secret: SECRET, pool, actions, permissions: LABELLER });
    assert.equal(retry.status, 200);
    assert.equal(attempts, 2);
  });
});

test("a label on a closed or locked issue is recorded as an ignored delivery with its reason, and still explained on the issue", { skip }, async () => {
  await withSchema(async (pool) => {
    const { FakeGitHubClient } = await import("../dist/github/fake.js");
    const { windkeelActions } = await import("../apps/ingress/dist/src/windkeel-actions.js");

    const github = new FakeGitHubClient({
      repositories: [{ owner: "jyothepro", name: "windkeel-fixture", issues: [{ number: 7 }] }],
    });
    const enqueued = [];
    const actions = windkeelActions({
      github,
      enqueue: {
        async startRun(runId) {
          enqueued.push(runId);
          return { enqueued: true };
        },
        async stop() {},
      },
    });

    for (const [delivery, issue, reason] of [
      ["closed-1", { ...PAYLOAD.issue, state: "closed" }, "the issue is closed"],
      ["locked-1", { ...PAYLOAD.issue, state: "open", locked: true }, "the issue is locked"],
    ]) {
      const response = await handleWebhook(request({ ...PAYLOAD, issue }, { delivery }), {
        secret: SECRET,
        pool,
        actions,
        permissions: LABELLER,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true, intent: "ignore", reason });

      const { rows } = await pool.query(
        "select intent, reason, event, action from intake_delivery where delivery_key = $1",
        [delivery],
      );
      assert.deepEqual(rows, [{ intent: "ignore", reason, event: "issues", action: "labeled" }]);
    }

    assert.deepEqual(enqueued, [], "nothing was started");
    assert.equal(
      github.commentsOn({ owner: "jyothepro", name: "windkeel-fixture" }, 7).length,
      2,
      "each ignore is still explained on the issue after commit",
    );
    const { rows: tasks } = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(tasks[0].n, 0);
  });
});

// --- /windkeel commands are authorised on GitHub's permission, not author_association ---

function commentPayload(login, association, body = "/windkeel approve") {
  return {
    action: "created",
    installation: PAYLOAD.installation,
    sender: { login },
    repository: PAYLOAD.repository,
    issue: { ...PAYLOAD.issue },
    comment: { body, user: { login }, author_association: association },
  };
}

async function commandStack(pool) {
  const { FakeGitHubClient } = await import("../dist/github/fake.js");
  const { windkeelActions } = await import("../apps/ingress/dist/src/windkeel-actions.js");
  const { upsertRepository } = await import("../dist/factory/repository-entity.js");
  const { insertEngineeringRun, insertEngineeringTask } = await import("../dist/factory/repositories.js");

  const repository = await upsertRepository(pool, {
    owner: "jyothepro",
    name: "windkeel-fixture",
    defaultBranch: "trunk",
    cloneUrl: "https://github.com/jyothepro/windkeel-fixture.git",
    githubInstallationId: 42,
  });
  const task = await insertEngineeringTask(pool, {
    repositoryId: repository.id,
    sourceType: "github_issue",
    sourceReference: "jyothepro/windkeel-fixture#7",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  await pool.query("update engineering_run set status = 'WAITING_FOR_APPROVAL' where id = $1", [run.id]);

  const github = new FakeGitHubClient({
    repositories: [
      {
        owner: "jyothepro",
        name: "windkeel-fixture",
        issues: [{ number: 7 }],
        collaborators: {
          "read-member": { permission: "read", roleName: "read" },
          "triage-collab": { permission: "read", roleName: "triage" },
          writer: { permission: "write", roleName: "write" },
          owner: { permission: "admin", roleName: "admin" },
        },
      },
    ],
  });
  const signals = [];
  const cancels = [];
  const actions = windkeelActions({
    github,
    enqueue: {
      async startRun() {
        return { enqueued: true };
      },
      async signal(runId, signal) {
        signals.push({ runId, signal });
      },
      async cancel(runId, reason) {
        cancels.push({ runId, reason });
      },
      async stop() {},
    },
  });
  const deliver = (payload, delivery) =>
    handleWebhook(request(payload, { event: "issue_comment", delivery }), {
      secret: SECRET,
      pool,
      actions,
      permissions: github,
    });
  const ledger = async (delivery) =>
    (await pool.query("select intent, reason from intake_delivery where delivery_key = $1", [delivery])).rows[0];
  return { run, github, signals, cancels, deliver, ledger };
}

test("a read-only MEMBER or triage COLLABORATOR cannot approve or cancel; the refusal is recorded", { skip }, async () => {
  await withSchema(async (pool) => {
    const { github, signals, cancels, deliver, ledger } = await commandStack(pool);

    for (const [delivery, login, association, body, role] of [
      ["c-read-approve", "read-member", "MEMBER", "/windkeel approve", "read"],
      ["c-read-cancel", "read-member", "MEMBER", "/windkeel cancel", "read"],
      ["c-triage-approve", "triage-collab", "COLLABORATOR", "/windkeel approve", "triage"],
    ]) {
      const response = await deliver(commentPayload(login, association, body), delivery);
      assert.equal(response.status, 200, delivery);
      assert.equal(response.body.intent, "ignore", delivery);
      const row = await ledger(delivery);
      assert.equal(row.intent, "ignore", delivery);
      assert.match(row.reason, new RegExp(`refused: ${login} has ${role} access to the repository, not write`), delivery);
    }

    // A stranger is refused on association alone, without an API call on their behalf.
    const before = github.calls.filter((c) => c.type === "getCollaboratorPermission").length;
    await deliver(commentPayload("drive-by", "NONE"), "c-none");
    assert.match((await ledger("c-none")).reason, /drive-by \(NONE\) cannot hold write access/);
    assert.equal(github.calls.filter((c) => c.type === "getCollaboratorPermission").length, before);

    assert.deepEqual(signals, [], "nothing was approved");
    assert.deepEqual(cancels, [], "nothing was cancelled");
    assert.equal(github.commentsOn({ owner: "jyothepro", name: "windkeel-fixture" }, 7).length, 0, "and nothing was said");
  });
});

test("a commenter with write or admin can approve and cancel", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, signals, cancels, deliver, ledger } = await commandStack(pool);

    const approved = await deliver(commentPayload("writer", "MEMBER"), "c-write-approve");
    assert.equal(approved.status, 200);
    assert.equal((await ledger("c-write-approve")).intent, "command:approve:signalled");
    assert.deepEqual(signals, [{ runId: run.id, signal: { type: "approval_granted", actor: "writer" } }]);

    const cancelled = await deliver(commentPayload("owner", "OWNER", "/windkeel cancel"), "c-admin-cancel");
    assert.equal(cancelled.status, 200);
    assert.equal((await ledger("c-admin-cancel")).intent, "command:cancel:cancelled");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].runId, run.id);
  });
});

test("when GitHub cannot say whether a commenter can push, the command is refused (fail closed)", { skip }, async () => {
  await withSchema(async (pool) => {
    const { github, signals, deliver, ledger } = await commandStack(pool);

    github.injectFailure("getCollaboratorPermission", { kind: "apiError", status: 502 });
    const response = await deliver(commentPayload("writer", "MEMBER"), "c-api-down");
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "ignore");
    assert.match((await ledger("c-api-down")).reason, /could not confirm writer has write access \(GitHubApiError, status 502\)/);

    // No lookup wired at all is the same refusal, never a pass.
    const { handleWebhook: handle } = await import("../apps/ingress/dist/src/handler.js");
    const { recordingActions: recording } = await import("../apps/ingress/dist/src/actions.js");
    const actions = recording();
    const unwired = await handle(request(commentPayload("writer", "MEMBER"), { event: "issue_comment", delivery: "c-unwired" }), {
      secret: SECRET,
      pool,
      actions,
    });
    assert.equal(unwired.body.intent, "ignore");
    assert.deepEqual(actions.recorded, []);
    assert.deepEqual(signals, []);
  });
});

// --- ORQ-11: the `windkeel` label is authorised like a command (Triage can change labels) ---

test("ORQ-11: a triage user adding or removing the windkeel label starts and cancels nothing; a writer does both", { skip }, async () => {
  await withSchema(async (pool) => {
    const { github, cancels } = await commandStack(pool);
    const { windkeelActions } = await import("../apps/ingress/dist/src/windkeel-actions.js");
    const started = [];
    const actions = windkeelActions({
      github,
      enqueue: {
        async startRun(runId) {
          started.push(runId);
          return { enqueued: true };
        },
        async signal() {},
        async cancel(runId, reason) {
          cancels.push({ runId, reason });
        },
        async stop() {},
      },
    });
    const deliver = (payload, delivery) =>
      handleWebhook(request(payload, { delivery }), { secret: SECRET, pool, actions, permissions: github });
    const ledger = async (delivery) =>
      (await pool.query("select intent, reason from intake_delivery where delivery_key = $1", [delivery])).rows[0];
    const labelled = (login, issueNumber) => ({
      ...PAYLOAD,
      sender: { login },
      issue: { ...PAYLOAD.issue, number: issueNumber, state: "open", body: "- [ ] retries a 500 three times" },
    });
    const unlabelled = (login) => ({ ...PAYLOAD, action: "unlabeled", sender: { login } });

    const add = await deliver(labelled("triage-collab", 8), "l-triage-add");
    assert.equal(add.body.intent, "ignore");
    assert.match((await ledger("l-triage-add")).reason, /adding the windkeel label refused: triage-collab has triage access/);

    const remove = await deliver(unlabelled("triage-collab"), "l-triage-remove");
    assert.equal(remove.body.intent, "ignore");
    assert.match((await ledger("l-triage-remove")).reason, /removing the windkeel label refused: triage-collab has triage access/);

    // Someone GitHub has never heard of, such as an issue opener whose template applied the label.
    await deliver(labelled("drive-by", 9), "l-stranger-add");
    assert.match((await ledger("l-stranger-add")).reason, /drive-by has none access/);

    assert.deepEqual(started, [], "nothing was started");
    assert.deepEqual(cancels, [], "nothing was cancelled");
    const { rows: tasks } = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(tasks[0].n, 1, "only the seeded task exists");

    // A writer is not affected: re-labelling #7 once its run has ended starts a fresh one.
    await pool.query("update engineering_run set status = 'FAILED'");
    assert.equal((await deliver(labelled("writer", 7), "l-writer-add")).body.intent, "create_task");
    assert.equal(started.length, 1);
    assert.equal((await deliver(unlabelled("writer"), "l-writer-remove")).body.intent, "cancel_run");
    assert.equal(cancels.length, 1);
  });
});

// --- ORQ-07: a label on a repository with no intake grant starts no work anywhere ---

test("ORQ-07: a repository held only by an intake=false grant refuses the label instead of using the default organization", { skip }, async () => {
  await withSchema(async (pool) => {
    const { FakeGitHubClient } = await import("../dist/github/fake.js");
    const { windkeelActions } = await import("../apps/ingress/dist/src/windkeel-actions.js");
    const { upsertRepository } = await import("../dist/factory/repository-entity.js");
    const { insertEngineeringTask } = await import("../dist/factory/repositories.js");

    const repository = await upsertRepository(pool, {
      owner: "jyothepro",
      name: "windkeel-fixture",
      defaultBranch: "trunk",
      cloneUrl: "https://github.com/jyothepro/windkeel-fixture.git",
      githubInstallationId: 42,
    });
    const orgB = (
      await pool.query(
        `insert into organization (account_id, name) select account_id, 'org-b' from organization where is_default
         returning id`,
      )
    ).rows[0].id;
    // Org B holds the repository without intake; the default organization holds nothing.
    await pool.query("delete from repository_grant where repository_id = $1", [repository.id]);
    await pool.query("insert into repository_grant (organization_id, repository_id, intake) values ($1, $2, false)", [
      orgB,
      repository.id,
    ]);

    const github = new FakeGitHubClient({
      repositories: [{ owner: "jyothepro", name: "windkeel-fixture", issues: [{ number: 7 }] }],
    });
    const started = [];
    const actions = windkeelActions({
      github,
      enqueue: {
        async startRun(runId) {
          started.push(runId);
          return { enqueued: true };
        },
        async stop() {},
      },
    });
    const response = await handleWebhook(request(PAYLOAD, { delivery: "no-intake" }), {
      secret: SECRET,
      pool,
      actions,
      permissions: LABELLER,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "ignore");
    assert.match(response.body.reason, /has no intake grant/);
    const { rows: ledger } = await pool.query("select intent, reason from intake_delivery where delivery_key = 'no-intake'");
    assert.equal(ledger[0].intent, "ignore", "the refusal is recorded on the delivery row (ADR-0024 §2)");
    assert.deepEqual(started, []);
    const { rows: tasks } = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(tasks[0].n, 0, "no task, in the default organization or anywhere");

    // Defence in depth: an insert that names no organization does not fall through to the default.
    await assert.rejects(
      insertEngineeringTask(pool, {
        repositoryId: repository.id,
        sourceType: "github_issue",
        sourceReference: "jyothepro/windkeel-fixture#99",
        title: "t",
        description: "d",
        acceptanceCriteria: [],
        riskLevel: "low",
        priority: null,
        status: "OPEN",
      }),
      (err) => err.code === "23502",
    );
  });
});

test("#389: /api/intake/sentry is registered, and with no client secret every delivery is a 503", async () => {
  const { registerDeploymentIntakeSources } = await import("../apps/ingress/dist/src/intake-sources.js");
  const pipeline = await import("../dist/intake/pipeline.js");
  const { dispatchIntake } = pipeline;
  const saved = process.env.WINDKEEL_SENTRY_CLIENT_SECRET;
  delete process.env.WINDKEEL_SENTRY_CLIENT_SECRET;
  try {
    registerDeploymentIntakeSources(); // never throws for an unset integration: it is simply off
    assert.ok(pipeline.registeredIntakeSources().includes("sentry"), pipeline.registeredIntakeSources().join(", "));
    const pool = { query: async () => assert.fail("nothing is read before verification"), connect: async () => assert.fail("no connection") };
    const response = await dispatchIntake("sentry", { headers: { "sentry-hook-resource": "event_alert" }, rawBody: "{}" }, { pool });
    assert.equal(response.status, 503);
    assert.equal(response.body.error, "integration_misconfigured");
  } finally {
    if (saved !== undefined) process.env.WINDKEEL_SENTRY_CLIENT_SECRET = saved;
  }
});
