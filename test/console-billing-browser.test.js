/**
 * #394 in a real browser: an organization admin sees the month's usage with verification on its own
 * line, sets a monthly budget and sees it saved; a member has no Billing tab (and the page is not
 * found); and with invite-only signup on, the welcome wizard renders its steps and its first task
 * goes through the ordinary intake to a run page.
 *
 * The console's dev server against the real `/v1` router and real Postgres (`console-browser.js`),
 * with the fake billing provider. Skips without `TEST_DATABASE_URL` or without a Chromium.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { DEFAULT_PRICING } from "../dist/factory/config/billing.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? await browserSkip() : "TEST_DATABASE_URL not set";

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "browser-billing-token";
const MEMBER = "session:sub-mona:9919:mona";

const sessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    return kind === "session" ? { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login } : null;
  },
};

test("an admin sets the budget and sees usage; a member has no Billing tab; the welcome wizard starts a run", { skip, timeout: 900_000 }, async (t) => {
  const schema = `windkeel_console_billing_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });

  let api;
  let consoleApp;
  let browser;
  const previousSignup = process.env.WINDKEEL_SELF_SERVE_SIGNUP;
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "github_issue",
      sourceReference: "acme/widgets#4",
      title: "Count the widgets",
      description: "- [ ] it counts",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await recordCost(pool, { engineeringRunId: run.id, stageType: "agent_run", stageId: run.id, kind: "model", usd: 1.25, keySource: "orqon" });
    await recordCost(pool, { engineeringRunId: run.id, stageType: "verification_run", stageId: run.id, kind: "model", usd: 0.5, keySource: "orqon" });
    // #431: the default account on a credit plan — 2,000 Starter credits this period.
    const { rows: acct } = await pool.query("select account_id from organization where is_default");
    await pool.query("update billing_account set credit_billing_since = now() - interval '1 day', credit_plan = 'starter' where account_id = $1", [acct[0].account_id]);
    await pool.query("update cost_event set recorded_at = now() where engineering_run_id = $1", [run.id]);
    await pool.query(
      `insert into credit_grant (account_id, source, product, amount_micro, starts_at, expires_at, idempotency_key)
       values ($1, 'plan', 'starter', 2000000000, now() - interval '1 day', now() + interval '20 days', 'browser:plan')`,
      [acct[0].account_id],
    );

    const enqueued = [];
    api = await serveApi(
      {
        pool,
        control: { listMessages: async () => [], enqueue: async (id) => (enqueued.push(id), { enqueued: true }) },
        githubUsers: { lookup: async (login) => (login === "mona" ? { id: 9919, login } : null) },
        consoleUrl: "http://127.0.0.1",
        billing: { provider: new FakeBillingProvider(), providerName: "fake", pricing: DEFAULT_PRICING, selfServe: "invite" },
      },
      { token: TOKEN, subject: "browser-billing", sessions },
    );
    // Mona is a Member: invited, then signed in once (which accepts the invitation).
    const invited = await fetch(`${api.url}/v1/invitations`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ githubLogin: "mona", role: "member" }),
    });
    assert.equal(invited.status, 201);
    assert.equal((await fetch(`${api.url}/v1/self`, { headers: { authorization: `Bearer ${MEMBER}` } })).status, 200);

    process.env.WINDKEEL_SELF_SERVE_SIGNUP = "invite";
    consoleApp = await startConsole(api.url, TOKEN, "/settings/billing");
    t.diagnostic("console ready (admin)");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${consoleApp.url}/settings/billing`, { waitUntil: "networkidle" });
      const verification = page.locator('[data-usage-line="verification"]');
      await verification.waitFor();
      assert.match(await verification.innerText(), /Verification[\s\S]*\$0\.50/, "verification is its own line");
      assert.match(await page.locator("[data-billable]").innerText(), /\$1\.75/);
      assert.match(await page.locator("[data-budget-summary]").innerText(), /No monthly budget/);
      // #431: the credit balance — $1.75 of Windkeel-key AI is 175 credits of the plan's 2,000.
      assert.match(await page.locator("[data-credits-balance]").innerText(), /1,825\.00 credits left · plan resets in (20|21) days/);
      assert.match(await page.locator('[data-credit-line="plan"]').innerText(), /Starter plan[\s\S]*1,825\.00 of 2,000\.00/);

      await page.locator("#budget-limit").fill("50");
      await page.locator("#budget-alert").fill("75");
      await page.getByRole("button", { name: "Save budget" }).click();
      await page.locator("[data-budget-summary]").filter({ hasText: "of $50.00" }).waitFor();
      const { rows } = await pool.query("select monthly_limit_usd, alert_threshold_pct from organization_budget");
      assert.deepEqual([Number(rows[0].monthly_limit_usd), rows[0].alert_threshold_pct], [50, 75], "saved through the API");
      assert.equal(await page.locator('a[href="/settings/billing"]').count() > 0, true, "the admin has the tab");

      // #431: the run page's receipt, in credits, per role.
      await page.goto(`${consoleApp.url}/runs/${run.id}?tab=evidence&view=cost`, { waitUntil: "networkidle" });
      await page.locator("[data-receipt]").waitFor();
      assert.match(await page.locator("[data-receipt]").innerText(), /Verifier[\s\S]*50\.00/);
      assert.match(await page.locator("[data-receipt-total]").innerText(), /175\.00/);

      // The welcome wizard, for someone already in an organization: steps 2–5, and a first task.
      await page.goto(`${consoleApp.url}/welcome`, { waitUntil: "networkidle" });
      for (const step of ["install", "task", "verdict"]) await page.locator(`[data-step="${step}"]`).waitFor();
      await page.locator("#welcome-title").fill("Say hello");
      await page.locator("#welcome-description").fill("Print hello.\n\n- [ ] `node index.js` prints hello");
      await page.getByRole("button", { name: "Start the run" }).click();
      await page.waitForURL(/\/runs\/[0-9a-f-]{36}/, { timeout: 120_000 });
      assert.equal(enqueued.length, 1, "the ordinary intake started one run");

      // The docs the wizard links to render (#394, 09e).
      await page.goto(`${consoleApp.url}/docs/verification`, { waitUntil: "networkidle" });
      assert.match(await page.locator("h1").innerText(), /How verification works/);
    } catch (err) {
      const shot = join(tempDir("console-billing"), "page.png");
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new Error(`${err instanceof Error ? err.message : err}\n(screenshot: ${shot})`);
    }
    await consoleApp.stop();
    consoleApp = undefined;

    // The same console as Mona, a Member.
    consoleApp = await startConsole(api.url, MEMBER, "/settings");
    t.diagnostic("console ready (member)");
    const memberPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await memberPage.goto(`${consoleApp.url}/settings`, { waitUntil: "networkidle" });
    assert.equal(await memberPage.locator('a[href="/settings/billing"]').count(), 0, "no Billing tab for a member");
    const direct = await memberPage.goto(`${consoleApp.url}/settings/billing`, { waitUntil: "networkidle" });
    assert.equal(direct.status(), 404, "and the page is not found, not refused");
  } finally {
    if (previousSignup === undefined) delete process.env.WINDKEEL_SELF_SERVE_SIGNUP;
    else process.env.WINDKEEL_SELF_SERVE_SIGNUP = previousSignup;
    await browser?.close();
    await consoleApp?.stop();
    await api?.close();
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
