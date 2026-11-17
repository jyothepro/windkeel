/**
 * Playbooks in the console, in a real browser (#390): the composer offers them, shows what one
 * adds, and files the task with it; Settings → Playbooks duplicates a built-in, edits the copy and
 * shows its new version.
 *
 * The console's dev server against the real `/v1` router and real Postgres (`console-browser.js`),
 * no factory. Skips without `TEST_DATABASE_URL` or without a Chromium for playwright-core.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { apiControl } from "../apps/ingress/dist/src/api/control.js";
import { getEngineeringTask } from "../dist/factory/repositories.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "browser-playbooks-token";

test("the composer files a task under a playbook; settings duplicates and edits one", { skip, timeout: 600_000 }, async (t) => {
  const schema = `windkeel_console_playbooks_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });

  let api;
  let consoleApp;
  let browser;
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const control = apiControl({
      pool,
      control: { cancel: async () => {}, signal: async () => {}, startRun: async () => ({ enqueued: true }) },
      github: {},
    });
    api = await serveApi({ pool, control, secretPublicKey: generateSecretKeyPair().publicKey }, { token: TOKEN, subject: "browser-playbooks" });
    consoleApp = await startConsole(api.url, TOKEN, "/tasks/new");
    t.diagnostic("console ready");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      // The composer: pick "Dependency upgrade", see what it adds, file it.
      await page.goto(`${consoleApp.url}/tasks/new`, { waitUntil: "networkidle" });
      assert.equal(await page.getByText("Showing fixtures").count(), 0, "the console is reading the real API");
      await page.locator("#change").fill("Upgrade left-pad to 2.0.\n\n- [ ] left-pad is 2.0");
      await page.locator("#new-playbook").selectOption("dependency-upgrade");
      const adds = page.locator('[data-playbook-adds="dependency-upgrade"]');
      await adds.waitFor();
      const text = await adds.innerText();
      assert.match(text, /PB1 — Lockfile is updated consistently with the manifest/);
      assert.match(text, /Verifier will also: fail when the repository declares no checks; require the security stage to run/);
      await page.getByRole("button", { name: "Give Windkeel the task" }).click();
      await page.waitForURL(/\/runs\//, { timeout: 120_000 });
      const { rows } = await pool.query("select id from engineering_task order by created_at desc limit 1");
      const task = await getEngineeringTask(pool, rows[0].id);
      assert.equal(task.playbook?.slug, "dependency-upgrade", "the API received the playbook");
      assert.equal(task.playbook.builtin, true);

      // Settings → Playbooks: duplicate the built-in, edit the copy, see v2.
      await page.goto(`${consoleApp.url}/settings/playbooks`, { waitUntil: "networkidle" });
      const builtin = page.locator('[data-playbook="test-writing"]');
      await builtin.locator("summary", { hasText: "Duplicate" }).click();
      await builtin.locator("#dup-test-writing").fill("our-tests");
      await builtin.getByRole("button", { name: "Duplicate" }).click();
      const copy = page.locator('[data-playbook="our-tests"]');
      await copy.waitFor({ timeout: 60_000 });
      assert.match(await copy.innerText(), /v1/);
      await copy.locator("summary", { hasText: "Edit" }).click();
      const instructions = copy.locator("textarea[name=makerInstructions]");
      await instructions.fill("Add tests only, and name each after the behaviour it covers.");
      await copy.getByRole("button", { name: "Save playbook" }).click();
      await page.locator('[data-playbook="our-tests"]', { hasText: "v2" }).waitFor({ timeout: 60_000 });
      const { rows: saved } = await pool.query("select version, maker_instructions from playbook where slug = 'our-tests'");
      assert.equal(saved[0].version, 2);
      assert.match(saved[0].maker_instructions, /name each after the behaviour/);
    } catch (err) {
      const shot = join(tempDir("console-playbooks"), "page.png");
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
