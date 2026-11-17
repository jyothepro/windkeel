/**
 * #391 in a real browser: the console's batches list shows a batch with its progress; the detail
 * page shows the counts, spend against the cap, and each child linking to its run and pull
 * request; pause/resume/cancel are offered only with `batches.manage`; and there is no merge
 * control anywhere on either page.
 *
 * The console's dev server against the real `/v1` router and real Postgres (`console-browser.js`,
 * which serialises `next dev` across test processes), no factory: children are dispatched by the
 * real dispatcher and moved to their states directly. Skips without `TEST_DATABASE_URL` or a
 * Chromium for playwright-core.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";

const BOOTSTRAP = "browser-batches-bootstrap";
const REPOS = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];

test("the batches list and detail show progress, spend and children; controls only with batches.manage; no merge", { skip, timeout: 600_000 }, async (t) => {
  const schema = `windkeel_console_batches_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, max: 4, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });

  let api;
  let consoleApp;
  let browser;
  try {
    for (const id of REPOS) await seedFixtureRepository(pool, id);
    const deps = {
      pool,
      control: {
        enqueue: async () => ({ enqueued: true }),
        cancel: async (runId) => {
          await pool.query("update engineering_run set status = 'CANCELLED' where id = $1", [runId]);
          return { outcome: "cancelled" };
        },
        listMessages: async () => [],
      },
    };
    const auth = { token: BOOTSTRAP, subject: "browser-batches" };
    const call = (method, path, body) =>
      handleApiRequest(deps, auth, { method, path, query: { get: () => undefined }, headers: { authorization: `Bearer ${BOOTSTRAP}` }, body });

    // The console's own token: an admin's, narrowed later to read-only to see the controls go.
    const minted = await call("POST", "/v1/tokens", { name: "console", preset: "admin" });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const consoleToken = minted.body.secret;

    const created = await call("POST", "/v1/batches", {
      kind: "multi_repo",
      title: "Upgrade the linter everywhere",
      description: "Bump eslint to the next major and fix what it reports.",
      criteria: ["npm run lint passes"],
      repositories: REPOS,
      maxConcurrency: 2,
      batchSpendCapUsd: 20,
      spendCapUsd: 5,
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const batchId = created.body.batchId;
    const children = (
      await pool.query(
        "select r.id as \"runId\" from engineering_run r join engineering_task t on t.id = r.task_id where t.batch_id = $1 order by t.source_reference",
        [batchId],
      )
    ).rows;
    assert.equal(children.length, 2, "two children started, the third waits");
    const [first, second] = children;
    // One child verified with a draft PR, one still verifying; the third waits for a slot.
    await pool.query("update engineering_run set status = 'WAITING_FOR_HUMAN', final_verdict = 'pass', cost = 3.5, pr_number = 41 where id = $1", [first.runId]);
    await pool.query("update engineering_run set status = 'VERIFYING', cost = 1.25 where id = $1", [second.runId]);

    api = await serveApi(deps, auth);
    consoleApp = await startConsole(api.url, consoleToken, "/batches");
    t.diagnostic("console ready");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${consoleApp.url}/batches`, { waitUntil: "networkidle" });
      assert.equal(await page.getByText("Showing fixtures").count(), 0, "the console is reading the real API");
      const row = page.locator(`[data-batch="${batchId}"]`);
      await row.waitFor();
      const rowText = await row.innerText();
      assert.match(rowText, /Upgrade the linter everywhere/);
      assert.match(rowText, /1 of 3 verified/);
      assert.match(rowText, /\$4\.75 of \$20\.00/);
      assert.match(await row.locator("[data-batch-progress]").getAttribute("aria-label"), /3 children: 1 verified, 1 running, 1 waiting for a slot/);

      await row.locator("a").click();
      await page.waitForURL(`**/batches/${batchId}`);
      await page.locator("[data-batch-detail]").waitFor();
      assert.match(await page.locator("[data-batch-status]").innerText(), /Running/);
      assert.match(await page.locator("[data-batch-verdicts]").innerText(), /1 pass · 0 warn · 0 fail · 1 not yet verified/);
      assert.match(await page.locator("[data-batch-spend]").innerText(), /\$4\.75 of \$20\.00/);
      const items = page.locator("[data-batch-item]");
      assert.equal(await items.count(), 3);
      const firstRow = page.locator('[data-batch-item="0"]');
      assert.equal(await firstRow.locator(`a[href="/runs/${first.runId}"]`).count(), 1, "links to the child's run");
      assert.match(await firstRow.locator('a[href*="/pull/41"]').getAttribute("href"), /^https:\/\/github\.com\/jyothepro\/windkeel-fixture-11111111\/pull\/41$/);
      assert.match(await page.locator('[data-batch-item="2"]').innerText(), /Waiting for a slot/);

      const controls = page.locator("[data-batch-controls]");
      assert.equal(await controls.getByRole("button", { name: "Pause" }).count(), 1);
      assert.equal(await controls.getByRole("button", { name: "Cancel batch" }).count(), 1);
      assert.equal(await page.getByRole("button", { name: /merge/i }).count(), 0, "no merge control");
      assert.equal(await page.getByRole("link", { name: /merge/i }).count(), 0, "no merge link");

      // Pause through the page: the API answers, the page shows Paused and offers Resume.
      await controls.getByRole("button", { name: "Pause" }).click();
      await page.getByRole("button", { name: "Pause batch" }).click();
      await page.locator("[data-batch-controls]").getByRole("button", { name: "Resume" }).waitFor();
      assert.equal((await pool.query("select status from batch where id = $1", [batchId])).rows[0].status, "PAUSED");
      await page.reload({ waitUntil: "networkidle" });
      assert.match(await page.locator("[data-batch-status]").innerText(), /Paused/);
      assert.equal(await page.locator("[data-batch-controls]").getByRole("button", { name: "Resume" }).count(), 1);

      // The run page names its batch.
      await page.goto(`${consoleApp.url}/runs/${first.runId}`, { waitUntil: "networkidle" });
      const back = page.locator("[data-run-batch]");
      await back.waitFor();
      assert.match(await back.innerText(), /Part of batch Upgrade the linter everywhere/);

      // Read-only: the same token narrowed to runs.read. The page still reads; no controls.
      await pool.query("update api_token set permissions = array['runs.read']");
      await page.goto(`${consoleApp.url}/batches/${batchId}`, { waitUntil: "networkidle" });
      await page.locator("[data-batch-detail]").waitFor();
      assert.equal(await page.locator("[data-batch-controls]").count(), 0, "no pause/resume/cancel without batches.manage");
      assert.equal(await page.getByRole("button", { name: /pause|resume|cancel|merge/i }).count(), 0);
    } catch (err) {
      const shot = join(tempDir("console-batches"), "page.png");
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new Error(`${err instanceof Error ? err.message : err}\n(screenshot: ${shot})\n${consoleApp?.output().slice(-1500) ?? ""}`);
    }
  } finally {
    await browser?.close();
    await consoleApp?.stop();
    await api?.close();
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
