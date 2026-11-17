/**
 * M9-7 (#325) in a real browser: an organization admin adds a model key in Settings → Models and
 * sees it listed as `unverified`, with the key itself nowhere on the page; and a run's page shows
 * the Models panel built from the snapshot intake froze onto it.
 *
 * The console's dev server against the real `/v1` router and real Postgres (`console-browser.js`),
 * no factory: the run's snapshot is written the way intake writes it, and the credential check is a
 * recording port standing in for the stage deployment. Skips without `TEST_DATABASE_URL` or without
 * a Chromium for playwright-core.
 *
 * (The issue names `test/browser.test.js`; that file tests the *verifier's* browser stage, not the
 * console. The console's browser harness is `console-browser.js`, so this lives beside its other
 * user, `e2e-factory-loop.test.js`.)
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { addRoute, createConnection } from "../dist/integrations/connections.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const KEY = "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";
const TOKEN = "browser-models-token";

test("an admin adds a model key and sees it unverified; a run's page shows the models it used", { skip, timeout: 600_000 }, async (t) => {
  const schema = `windkeel_console_models_${Date.now()}_${process.pid}`;
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
      sourceReference: "acme/widgets#9",
      title: "Route the checker through OpenRouter",
      description: "- [ ] it works",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    // What intake writes (ADR-0026 §4): names, ids and labels.
    const snapshot = {
      version: 1,
      maker: { provider: "openai", vendor: "openai", model: "gpt-5-codex", keySource: "orqon", source: "operator", worker: "codex" },
      checker: [
        { provider: "openrouter", vendor: "anthropic", model: "anthropic/claude-sonnet-4.5", credentialId: "00000000-0000-4000-8000-000000000001", credentialLabel: "router", keySource: "customer", source: "organization" },
      ],
      resolvedAt: new Date().toISOString(),
      policyIds: [],
    };
    await pool.query("update engineering_run set model_config = $2 where id = $1", [run.id, JSON.stringify(snapshot)]);
    // #389: a Sentry connection, so Settings → Integrations has one to list (sharing this test's
    // `next dev`, rather than starting a second one beside it).
    const organizationId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const { connection: sentry } = await createConnection(pool, {
      organizationId,
      provider: "sentry",
      installationId: "7a485448-a9e2-4c85-8a3c-4f44175783c9",
      externalTenantId: "7a485448-a9e2-4c85-8a3c-4f44175783c9",
      externalTenantName: "acme-shop",
      createdByPrincipalId: null,
    });
    await addRoute(pool, organizationId, sentry.id, { scopeKind: "sentry_project", scopeValue: "checkout-web", repositoryId: REPO_ID });

    const checks = [];
    api = await serveApi(
      {
        pool,
        control: { listMessages: async () => [] },
        secretPublicKey: generateSecretKeyPair().publicKey,
        credentialValidation: { request: async (...ids) => void checks.push(ids) },
      },
      { token: TOKEN, subject: "browser-models" },
    );
    consoleApp = await startConsole(api.url, TOKEN, "/settings/models");
    t.diagnostic("console ready");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${consoleApp.url}/settings/models`, { waitUntil: "networkidle" });
      assert.equal(await page.getByText("Showing fixtures").count(), 0, "the console is reading the real API");

      const form = page.getByRole("form", { name: "Add a model key" });
      await form.locator("#cred-provider").selectOption("openrouter");
      await form.locator("#cred-label").fill("router");
      await form.locator("#cred-value").fill(KEY);
      await form.getByRole("button", { name: "Add key" }).click();
      await form.getByRole("status").filter({ hasText: "Stored “router”" }).waitFor();
      assert.equal(await form.locator("#cred-value").inputValue(), "", "the key field is emptied once the action answers");

      const row = page.locator('[data-credential="router"]');
      await row.waitFor();
      assert.match(await row.innerText(), /unverified/);
      assert.match(await row.innerText(), new RegExp(`…${KEY.slice(-4)}`));
      assert.ok(!(await page.content()).includes(KEY), "the key is nowhere in the page");
      assert.equal(checks.length, 1, "a check was started on the stage side");
      assert.equal(checks[0].length, 2, "with two ids and nothing else");

      // The independence rule, said as the policy is filled in: Claude can't check Claude.
      await page.locator("#maker-provider").selectOption("anthropic");
      await page.locator("#maker-model").fill("claude-opus-4-1");
      const routerOption = await page.locator("#checker-key option", { hasText: "router" }).getAttribute("value");
      await page.locator("#checker-key").selectOption(routerOption);
      await page.locator("#checker-model").fill("anthropic/claude-sonnet-4.5");
      await page.getByRole("alert").filter({ hasText: "both be anthropic's models" }).waitFor();

      await page.goto(`${consoleApp.url}/runs/${run.id}?tab=evidence`, { waitUntil: "networkidle" });
      const panel = page.locator('[data-panel="models"]');
      await panel.locator("summary").click();
      const text = await panel.innerText();
      assert.match(text, /gpt-5-codex/);
      assert.match(text, /Windkeel-managed key/);
      assert.match(text, /anthropic's model via OpenRouter · your key “router”/);

      // #389: Sentry is a provider the integrations settings list and connect.
      await page.goto(`${consoleApp.url}/settings/integrations`, { waitUntil: "networkidle" });
      assert.equal(await page.locator('#int-provider option[value="sentry"]').innerText(), "Sentry");
      const body = await page.locator("main").innerText();
      assert.match(body, /Sentry/);
      assert.match(body, /acme-shop/);
      assert.match(body, /checkout-web/);
    } catch (err) {
      const shot = join(tempDir("console-models"), "page.png");
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
