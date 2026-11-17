/**
 * #387 in a real browser: the repository page's Environment section shows the snapshot's status
 * and the suggested setup, and its Rebuild button records the rebuild intent through the real
 * `/v1` router. The console's dev server against real Postgres (`console-browser.js`); skips
 * without `TEST_DATABASE_URL` or without a Chromium for playwright-core.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { claimSnapshotBuild, markSnapshotReady, pendingSnapshotRequest } from "../dist/factory/environment-snapshots.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "browser-environment-token";

test("the repository page shows the Environment section, and Rebuild posts the command", { skip, timeout: 600_000 }, async (t) => {
  const schema = `windkeel_console_env_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  let api;
  let consoleApp;
  let browser;
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const { rows } = await pool.query("select id from organization where is_default");
    const row = await claimSnapshotBuild(pool, {
      organizationId: rows[0].id,
      repositoryId: REPO_ID,
      sandboxProvider: "vercel",
      cacheKey: "e".repeat(64),
      keyPaths: ["windkeel.config.json"],
      baseSha: "1234567890abcdef1234567890abcdef12345678",
      builtBy: "system",
    });
    await pool.query("update environment_snapshot set proposed_setup = $2 where id = $1", [
      row.id,
      JSON.stringify({ setup: { commands: [{ name: "bootstrap", run: "make bootstrap", timeoutSec: 900 }], services: [] }, reasons: ["Makefile has a `bootstrap` target"] }),
    ]);
    await markSnapshotReady(pool, row.id, { providerSnapshotId: "snap_x", sizeBytes: 812_000_000, detail: "npm ci; secret scan clean", ttlDays: 14 });

    api = await serveApi({ pool, control: { listMessages: async () => [] } }, { token: TOKEN, subject: "browser-env" });
    consoleApp = await startConsole(api.url, TOKEN, `/repositories/${REPO_ID}`);
    t.diagnostic("console ready");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${consoleApp.url}/repositories/${REPO_ID}`, { waitUntil: "networkidle" });
      const section = page.getByTestId("environment");
      await section.waitFor();
      const text = await section.innerText();
      assert.match(text, /warm from a snapshot built at 1234567/);
      assert.match(text, /Ready/);
      assert.match(text, /812\.0 MB/);
      assert.match(await page.getByTestId("suggested-setup").innerText(), /make bootstrap/);

      await section.getByRole("button", { name: "Rebuild" }).click();
      const deadline = Date.now() + 30_000;
      let pending = null;
      while (!pending && Date.now() < deadline) {
        pending = await pendingSnapshotRequest(pool, rows[0].id, REPO_ID);
        if (!pending) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(pending, "Rebuild recorded the intent");
      assert.match(pending.reason, /rebuild requested by browser-env/);

      await section.getByRole("button", { name: "Invalidate" }).click();
      await page.getByText("No snapshot. Runs start cold.").or(page.getByText("A build is queued")).first().waitFor();
    } catch (err) {
      const shot = join(tempDir("console-environment"), "page.png");
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
