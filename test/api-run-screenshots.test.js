import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { insertAgentRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { makerScreenshotObjectKey } from "../dist/factory/maker-screenshots.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * `GET /v1/runs/{id}/screenshots` and `…/screenshots/{sid}` (#392): the maker's own screenshots.
 *
 * What these hold: the list says the screenshots are not evidence; the file is served as a PNG
 * and nothing else (`nosniff`, inline, a CSP that allows nothing); a stored object that is not a
 * PNG is refused rather than served; and a run of another organization, an unknown id, or another
 * run's screenshot id are all 404.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png")]);
const SHA_PNG = "a".repeat(64);
const SHA_HTML = "b".repeat(64);

async function withApi(fn, overrides = {}) {
  const schema = `windkeel_shots_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const newRun = async (ref) => {
      const task = await insertEngineeringTask(pool, {
        repositoryId: REPO_ID,
        sourceType: "github_issue",
        sourceReference: ref,
        title: "t",
        description: "d",
        acceptanceCriteria: [],
        riskLevel: "low",
        priority: null,
        status: "OPEN",
      });
      return insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    };
    const run = await newRun("acme/widgets#7");
    const other = await newRun("acme/widgets#8");
    const agent = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "scripted", model: "m", role: "implementer", tokenUsage: null });
    const insert = async (runId, sha, extra = {}) => {
      const { rows } = await pool.query(
        `insert into maker_screenshot (engineering_run_id, agent_run_id, sha256, object_key, bytes, name, url, page_title, console_errors)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) returning id`,
        [runId, runId === run.id ? agent.id : null, sha, makerScreenshotObjectKey(runId, sha), PNG.length, extra.name ?? "home", "http://localhost:3000/", extra.title ?? "Home", JSON.stringify(extra.errors ?? [])],
      );
      return rows[0].id;
    };
    const objects = new Map();
    const reads = [];
    const deps = {
      pool,
      control: {},
      makerScreenshots: {
        async read(runId, sha) {
          reads.push(`${runId}/${sha}`);
          const bytes = objects.get(`${runId}/${sha}`);
          if (!bytes) throw new Error("no such object");
          return bytes;
        },
      },
      ...overrides,
    };
    const auth = { token: TOKEN, subject: "operator" };
    const call = (path) =>
      handleApiRequest(deps, auth, { method: "GET", path, query: { get: () => undefined }, headers: { authorization: `Bearer ${TOKEN}` } });
    await fn({ pool, run, other, insert, objects, reads, call });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("the list carries what the maker wrote, as data, and says it is not evidence", { skip }, async () => {
  await withApi(async ({ run, insert, call }) => {
    const empty = await call(`/v1/runs/${run.id}/screenshots`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.items, []);

    const id = await insert(run.id, SHA_PNG, { title: "<img src=x onerror=alert(1)>", errors: ["TypeError: x"] });
    const listed = await call(`/v1/runs/${run.id}/screenshots`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    const [shot] = listed.body.items;
    assert.equal(shot.id, id);
    assert.equal(shot.evidence, false);
    assert.equal(shot.pageTitle, "<img src=x onerror=alert(1)>", "returned verbatim as JSON text; the console renders it as text");
    assert.deepEqual(shot.consoleErrors, ["TypeError: x"]);
    assert.equal(shot.bytes, PNG.length);
    assert.equal(typeof shot.capturedAt, "string");
    assert.equal("sha256" in shot || "objectKey" in shot, false, "storage details stay server-side");
  });
});

test("a screenshot is served as a PNG with nosniff, inline, and a CSP that allows nothing", { skip }, async () => {
  await withApi(async ({ run, insert, objects, call }) => {
    const id = await insert(run.id, SHA_PNG);
    objects.set(`${run.id}/${SHA_PNG}`, PNG);
    const file = await call(`/v1/runs/${run.id}/screenshots/${id}`);
    assert.equal(file.status, 200);
    assert.ok(Buffer.isBuffer(file.body));
    assert.deepEqual(file.body, PNG);
    assert.equal(file.headers["content-type"], "image/png");
    assert.equal(file.headers["x-content-type-options"], "nosniff");
    assert.equal(file.headers["content-disposition"], "inline");
    assert.match(file.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(file.headers["content-length"], String(PNG.length));
  });
});

test("a stored object that is not a PNG is refused, never served as one", { skip }, async () => {
  await withApi(async ({ run, insert, objects, call }) => {
    const id = await insert(run.id, SHA_HTML);
    objects.set(`${run.id}/${SHA_HTML}`, Buffer.from("<html><script>alert(1)</script></html>"));
    const file = await call(`/v1/runs/${run.id}/screenshots/${id}`);
    assert.equal(file.status, 415);
    assert.equal(file.body.code, "not_png");
  });
});

test("unknown ids, another run's screenshot, and another organization's run are 404", { skip }, async () => {
  await withApi(async ({ pool, run, other, insert, objects, reads, call }) => {
    const mine = await insert(run.id, SHA_PNG);
    const theirs = await insert(other.id, SHA_PNG);
    objects.set(`${other.id}/${SHA_PNG}`, PNG);

    assert.equal((await call(`/v1/runs/${run.id}/screenshots/${theirs}`)).status, 404, "an id from another run");
    assert.equal((await call(`/v1/runs/${run.id}/screenshots/00000000-0000-0000-0000-000000000000`)).status, 404);
    assert.equal((await call(`/v1/runs/${run.id}/screenshots/not-an-id`)).status, 404);
    assert.equal((await call(`/v1/runs/00000000-0000-0000-0000-000000000000/screenshots`)).status, 404);
    assert.ok(!reads.includes(`${other.id}/${SHA_PNG}`), "nothing was read for a refused id");

    // A second organization in the same account: the run is not its, so it does not exist there.
    const { rows } = await pool.query(
      "insert into organization (account_id, name) select account_id, 'platform' from organization where is_default returning id",
    );
    const elsewhere = rows[0].id;
    assert.equal((await call(`/v1/orgs/${elsewhere}/runs`)).status, 200, "the caller can read that organization");
    assert.equal((await call(`/v1/orgs/${elsewhere}/runs/${run.id}/screenshots`)).status, 404);
    assert.equal((await call(`/v1/orgs/${elsewhere}/runs/${run.id}/screenshots/${mine}`)).status, 404);
  });
});

test("with no object store the list still works and the file says why it can't be served", { skip }, async () => {
  await withApi(
    async ({ run, insert, call }) => {
      const id = await insert(run.id, SHA_PNG);
      assert.equal((await call(`/v1/runs/${run.id}/screenshots`)).status, 200);
      const file = await call(`/v1/runs/${run.id}/screenshots/${id}`);
      assert.equal(file.status, 503);
      assert.equal(file.body.code, "storage_unconfigured");
    },
    { makerScreenshots: undefined },
  );
});
