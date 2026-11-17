/**
 * #392 in a real browser: a run's Browser tab shows the maker's screenshots under the
 * "not verification evidence" label, the image loads through the console's proxy as a PNG, the
 * activity feed shows the screenshot as a thumbnail, and a maker-written page title that is
 * markup (`<img onerror>`) is rendered as text.
 *
 * The console's dev server against the real `/v1` router and real Postgres (`console-browser.js`).
 * Skips without `TEST_DATABASE_URL` or without a Chromium for playwright-core.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { insertAgentRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { makerScreenshotObjectKey } from "../dist/factory/maker-screenshots.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "browser-screenshots-token";
// A 1×1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const SHA = "c".repeat(64);
const HOSTILE = "<img src=x onerror=window.__pwned=1>";

test("the run page shows maker screenshots labelled as not evidence, with the maker's text as text", { skip, timeout: 600_000 }, async (t) => {
  const schema = `windkeel_console_shots_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });

  let api;
  let consoleApp;
  let browser;
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "github_issue",
      sourceReference: "acme/widgets#11",
      title: "Add a cart page",
      description: "- [ ] the cart shows items",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const agent = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "scripted", model: "m", role: "implementer", tokenUsage: null });
    const { rows } = await pool.query(
      `insert into maker_screenshot (engineering_run_id, agent_run_id, sha256, object_key, bytes, name, url, page_title, console_errors)
       values ($1, $2, $3, $4, $5, 'cart', 'http://localhost:3000/cart', $6, '["TypeError: boom"]'::jsonb) returning id`,
      [run.id, agent.id, SHA, makerScreenshotObjectKey(run.id, SHA), PNG.length, HOSTILE],
    );
    const shotId = rows[0].id;
    await pool.query(
      `insert into agent_event (engineering_run_id, agent_run_id, ordinal, type, payload) values
         ($1, $2, 0, 'started', '{}'::jsonb),
         ($1, $2, 1, 'completed', '{}'::jsonb),
         ($1, $2, null, 'screenshot', $3::jsonb)`,
      [run.id, agent.id, JSON.stringify({ screenshotId: shotId, name: "cart", url: "http://localhost:3000/cart" })],
    );

    api = await serveApi(
      {
        pool,
        control: { listMessages: async () => [] },
        makerScreenshots: { read: async (runId, sha) => (runId === run.id && sha === SHA ? PNG : Promise.reject(new Error("none"))) },
      },
      { token: TOKEN, subject: "browser-screenshots" },
    );
    consoleApp = await startConsole(api.url, TOKEN, `/runs/${run.id}?tab=browser`);
    t.diagnostic("console ready");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${consoleApp.url}/runs/${run.id}?tab=browser`, { waitUntil: "networkidle" });
      assert.equal(await page.getByText("Showing fixtures").count(), 0, "the console is reading the real API");
      await page.getByRole("heading", { name: "Maker screenshots — not verification evidence" }).waitFor();

      const strip = page.locator(".console-shots");
      assert.match(await strip.innerText(), new RegExp(`Title: ${HOSTILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the title is text");
      assert.equal(await page.evaluate(() => window.__pwned), undefined, "the maker's markup never ran");
      assert.equal(await strip.locator("img[src='x']").count(), 0);
      assert.match(await strip.innerText(), /1 console error/);

      const img = strip.locator("img.console-shot__img").first();
      await img.waitFor();
      const loaded = await img.evaluate((el) => (el.complete ? el.naturalWidth : new Promise((r) => (el.onload = () => r(el.naturalWidth)))));
      assert.equal(loaded, 1, "the PNG loaded through the proxy");
      const response = await page.request.get(`${consoleApp.url}/api/runs/${run.id}/screenshots/${shotId}`);
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["content-type"], "image/png");
      assert.equal(response.headers()["x-content-type-options"], "nosniff");

      // On the feed, as a thumbnail labelled unverified.
      const thumb = page.locator(".console-feed [data-screenshot]");
      await page.locator(".console-turn summary").first().click();
      await thumb.first().waitFor();
      assert.match(await thumb.first().innerText(), /Maker screenshot · unverified/);
    } catch (err) {
      const shot = join(tempDir("console-shots"), "page.png");
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new Error(`${err instanceof Error ? err.message : err}\n(screenshot: ${shot})`);
    }
  } finally {
    await browser?.close();
    await consoleApp?.stop();
    await api?.close();
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
