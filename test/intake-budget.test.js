/**
 * #394 / ADR-0037 §5: every way a new run is made is held to its organization's budget and billing
 * status — refused with a typed, user-visible reason and nothing written, or admitted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { createTaskFromIntake } from "../dist/intake/create-task.js";
import { createTaskFromIssue } from "../dist/intake/issue-intake.js";
import { startNewRun } from "../dist/billing/admitted-runs.js";
import { getEngineeringRun } from "../dist/factory/repositories.js";
import { BillingAccountSuspendedError, OrganizationBudgetExhaustedError, setBudget } from "../dist/billing/budget.js";
import { cost, createOrganization, defaultOrganization, runIn, skip, withSchema } from "./billing-fixtures.js";

const DESCRIPTION = "Fix the uploader.\n\n- [ ] retries a 500 three times";
const noStart = { startRun: async () => ({ enqueued: true }) };

function intake(org, overrides = {}) {
  return {
    organizationId: org.organizationId,
    repositoryId: org.repositoryId,
    sourceType: "api",
    sourceReference: `api:test:${Math.random()}`,
    title: "Uploader",
    description: DESCRIPTION,
    ...overrides,
  };
}

async function counts(pool, organizationId) {
  const { rows } = await pool.query(
    `select (select count(*) from engineering_task where organization_id = $1)::int as tasks,
            (select count(*) from engineering_run r join engineering_task t on t.id = r.task_id where t.organization_id = $1)::int as runs`,
    [organizationId],
  );
  return rows[0];
}

test("over its monthly limit, intake refuses with a typed reason and writes nothing", { skip }, async () => {
  await withSchema("intake_budget_refused", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 12, keySource: "orqon" });
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 10 }, null);
    const before = await counts(pool, acme.organizationId);

    await assert.rejects(createTaskFromIntake(pool, intake(acme), noStart), (error) => {
      assert.ok(error instanceof OrganizationBudgetExhaustedError);
      assert.equal(error.code, "org_budget_exhausted");
      assert.equal(error.spentUsd, 12);
      assert.equal(error.limitUsd, 10);
      assert.match(error.message, /monthly budget is spent \(\$12\.00 of \$10\.00\)/);
      return true;
    });
    assert.deepEqual(await counts(pool, acme.organizationId), before, "no task, no run");

    // On a caller's own transaction the refusal comes before the first insert, so even a caller that
    // catches it and commits has written nothing.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await assert.rejects(createTaskFromIntake(client, intake(acme), noStart), OrganizationBudgetExhaustedError);
      await client.query("commit");
    } finally {
      client.release();
    }
    assert.deepEqual(await counts(pool, acme.organizationId), before);
  });
});

test("an admitted run keeps a whole cap: the budget is enforced at maker checkpoints, not by shrinking it", { skip }, async () => {
  await withSchema("intake_budget_cap", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 6, keySource: "orqon" });
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 10 }, null);

    /*
     * $4 is left, and the run still gets ADR-0011's $25: a cap sized to the remaining budget would
     * be checked before verification and end the run instead of verifying its candidate. The
     * `org_budget` rail is what stops maker work (rails-gate.test.js).
     */
    const admitted = await createTaskFromIntake(pool, intake(acme), noStart);
    assert.equal((await getEngineeringRun(pool, admitted.runId)).spendCapUsd, 25);

    const small = await createTaskFromIntake(pool, intake(acme, { rails: { spendCapUsd: 1.5 } }), noStart);
    assert.equal((await getEngineeringRun(pool, small.runId)).spendCapUsd, 1.5, "a cap the caller names stands");

    await setBudget(pool, acme.organizationId, { defaultRunCapUsd: 3 }, null);
    const seeded = await createTaskFromIntake(pool, intake(acme), noStart);
    assert.equal((await getEngineeringRun(pool, seeded.runId)).spendCapUsd, 3, "the organization's default cap seeds a run");
  });
});

test("with no budget row nothing changes: the default cap, every time", { skip }, async () => {
  await withSchema("intake_budget_none", async (pool) => {
    const { organizationId } = await defaultOrganization(pool);
    const created = await createTaskFromIntake(
      pool,
      { organizationId, repositoryId: "11111111-1111-1111-1111-111111111111", sourceType: "api", sourceReference: "x", title: "t", description: DESCRIPTION },
      noStart,
    );
    assert.equal((await getEngineeringRun(pool, created.runId)).spendCapUsd, 25);
  });
});

test("a suspended billing account starts nothing; a past-due one still does", { skip }, async () => {
  await withSchema("intake_budget_suspended", async (pool) => {
    const acme = await createOrganization(pool, "acme", { billing: { provider: "fake", status: "past_due" } });
    await createTaskFromIntake(pool, intake(acme), noStart);
    await pool.query("update billing_account set status = 'suspended' where account_id = $1", [acme.accountId]);
    const before = await counts(pool, acme.organizationId);
    await assert.rejects(createTaskFromIntake(pool, intake(acme), noStart), (error) => {
      assert.ok(error instanceof BillingAccountSuspendedError);
      assert.equal(error.code, "billing_suspended");
      return true;
    });
    assert.deepEqual(await counts(pool, acme.organizationId), before);
  });
});

test("a further run on an existing task is held to the budget too", { skip }, async () => {
  await withSchema("intake_budget_rerun", async (pool) => {
    const acme = await createOrganization(pool, "acme");
    const { taskId, runId } = await runIn(pool, acme.organizationId, acme.repositoryId);
    await cost(pool, runId, { usd: 3, keySource: "orqon" });
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 3 }, null);
    await assert.rejects(startNewRun(pool, taskId), OrganizationBudgetExhaustedError);
    await setBudget(pool, acme.organizationId, { monthlyLimitUsd: 5 }, null);
    assert.equal((await startNewRun(pool, taskId)).status, "CREATED");
  });
});

test("the GitHub label path ignores the issue with the reason, and says so once on the issue", { skip }, async () => {
  await withSchema("intake_budget_label", async (pool) => {
    const { organizationId } = await defaultOrganization(pool);
    await setBudget(pool, organizationId, { monthlyLimitUsd: 0 }, null);
    const repository = { id: "11111111-1111-1111-1111-111111111111", owner: "jyothepro", name: "windkeel-fixture-11111111" };
    const github = new FakeGitHubClient({
      repositories: [{ owner: repository.owner, name: repository.name, defaultBranch: "main", issues: [{ number: 3, title: "t", body: DESCRIPTION, labels: ["windkeel"] }] }],
    });
    const result = await createTaskFromIssue(
      { db: pool, github, startRun: async () => ({ enqueued: true }) },
      {
        repository,
        issue: { number: 3, title: "t", body: DESCRIPTION, labels: ["windkeel"], htmlUrl: "https://github.com/x/y/issues/3", state: "open", locked: false },
      },
    );
    assert.equal(result.outcome.kind, "ignored");
    assert.match(result.outcome.reason, /^org_budget_exhausted: /);
    await result.afterCommit();
    const comments = github.commentsOn({ owner: repository.owner, name: repository.name }, 3);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Windkeel did not start a run: this organization's monthly budget is spent/);
    assert.doesNotMatch(comments[0].body, /\$/, "the issue may be public: no spend or limit figures on it");
    assert.deepEqual(await counts(pool, organizationId), { tasks: 0, runs: 0 });
  });
});
