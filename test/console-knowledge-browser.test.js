/**
 * #388 in a real browser: a note is added on a repository's page and listed with its provenance; a
 * held lesson is accepted; and a run's page shows the knowledge its maker was given.
 *
 * The console's dev server against the real `/v1` router and real Postgres (`console-browser.js`),
 * no factory: the lesson is written the way the learner writes it, and the run's snapshot the way
 * IMPLEMENTING records it. Skips without `TEST_DATABASE_URL` or without a Chromium for playwright-core.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { insertLearnedLesson, listNotes, recordRunKnowledge } from "../dist/factory/knowledge.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "browser-knowledge-token";

test("a person adds a repository note, accepts a held lesson, and sees a run's knowledge", { skip, timeout: 600_000 }, async (t) => {
  const schema = `windkeel_console_knowledge_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });

  let api;
  let consoleApp;
  let browser;
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const orgId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const lesson = await insertLearnedLesson(pool, {
      organizationId: orgId,
      repositoryId: REPO_ID,
      title: "The tests check must pass",
      body: "On run 9f3c2a1b the tests check (`npm test`) failed and the change needed a repair cycle.",
      sourceKind: "verifier_finding",
      sourceRef: { runId: "9f3c2a1b-0000-4000-8000-000000000000", kind: "failed_check" },
    });
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "local",
      sourceReference: "k",
      title: "Say goodbye",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await recordRunKnowledge(
      pool,
      run.id,
      [{ noteId: lesson.id, noteVersion: 2, digestSha: null, sourceKind: "verifier_finding", risk: "high", title: lesson.title, body: lesson.body, provenance: "learned from run 9f3c2a1b, accepted by browser-knowledge, v2" }],
      () => 120,
    );

    api = await serveApi({ pool, control: { listMessages: async () => [] } }, { token: TOKEN, subject: "browser-knowledge" });
    consoleApp = await startConsole(api.url, TOKEN, `/repositories/${REPO_ID}`);
    t.diagnostic("console ready");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${consoleApp.url}/repositories/${REPO_ID}`, { waitUntil: "networkidle" });
      assert.equal(await page.getByText("Showing fixtures").count(), 0, "the console is reading the real API");
      const section = page.locator('[data-section="knowledge"]');

      // The held lesson is shown with why it is held, and accepted.
      const held = section.locator(`[data-note="${lesson.id}"]`);
      assert.match(await held.innerText(), /Held for a person/);
      await held.getByRole("button", { name: "Accept" }).click();
      await section.locator(`[data-note="${lesson.id}"][data-status="active"]`).waitFor();

      // A new note, added on the page.
      await section.locator("summary", { hasText: "Add a note" }).click();
      await section.locator('input[name="title"]').last().fill("Use the logger");
      await section.locator('textarea[name="body"]').last().fill("Write through src/log.ts, never console.log.");
      await section.getByRole("button", { name: "Add note" }).click();
      // Exact: the note's delete button carries a (closed) confirm dialog titled `Delete “Use the logger”?`.
      await section.getByText("Use the logger", { exact: true }).waitFor();
      assert.match(await section.innerText(), /Repository note by browser-knowledge/);

      const notes = await listNotes(pool, { organizationId: orgId, repositoryId: REPO_ID, status: "active" });
      assert.deepEqual(notes.map((n) => n.title).sort(), ["The tests check must pass", "Use the logger"]);

      // The run's page: what its maker was given, with provenance.
      await page.goto(`${consoleApp.url}/runs/${run.id}?tab=evidence`, { waitUntil: "networkidle" });
      const panel = page.locator('[data-panel="knowledge"]');
      await panel.locator("summary").click();
      const text = await panel.innerText();
      assert.match(text, /Knowledge used/);
      assert.match(text, /The tests check must pass/);
      assert.match(text, /source: learned from run 9f3c2a1b, accepted by browser-knowledge, v2/);
    } catch (err) {
      const shot = join(tempDir("console-knowledge"), "page.png");
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
