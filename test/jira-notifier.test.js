/**
 * M8-8: the Jira outcome notifier — ADF comment bodies per outcome, idempotent posting keyed on the
 * committed transition (#306), and registration through `registerDeploymentNotifiers` only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { registerDeploymentNotifiers } from "../dist/factory/workflow/deployment-notifiers.js";
import { getSourceNotifier, unregisterSourceNotifier } from "../dist/intake/notifiers.js";
import { adfToText } from "../dist/integrations/adf.js";
import { createConnection } from "../dist/integrations/connections.js";
import { createJiraNotifier, jiraOutcomeComment, reasonSummary } from "../dist/integrations/jira-intake.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { FakeJira } from "./jira-fake.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const RUN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T1 = "bbbbbbbb-0000-4000-8000-000000000001";
const RUN_URL = `https://console.example/runs/${RUN}`;
const PR = "https://github.com/jyothepro/windkeel-fixture-11111111/pull/7";

/** Every node in the tree is a well-formed ADF node: a type, and content arrays where present. */
function assertAdf(node) {
  assert.equal(typeof node.type, "string");
  if (node.type === "doc") assert.equal(node.version, 1);
  if (node.content !== undefined) {
    assert.ok(Array.isArray(node.content));
    node.content.forEach(assertAdf);
  }
  if (node.type === "text") assert.ok(node.text.length > 0, "ADF forbids empty text nodes");
}

const comment = (input) => jiraOutcomeComment({ runId: RUN, transitionId: T1, runUrl: RUN_URL, prUrl: null, reason: null, ...input });

test("COMPLETED with a PR links the verified draft PR and the run", () => {
  const body = comment({ state: "COMPLETED", prUrl: PR });
  assertAdf(body);
  const text = adfToText(body);
  assert.match(text, /\*\*Windkeel finished\.\*\* Verified draft PR: \[https:\/\/github\.com\/.*\/pull\/7\]/);
  assert.match(text, new RegExp(`\\[run ${RUN}\\]\\(${RUN_URL}\\)`));
  assert.match(text, new RegExp(`windkeel-transition ${T1}$`));
  // The link is an ADF link mark, not text Jira would render literally.
  const links = JSON.stringify(body).match(/"type":"link"/g) ?? [];
  assert.equal(links.length, 2);
});

test("FAILED carries a short summary of the reason", () => {
  const body = comment({ state: "FAILED", reason: "verification failed: tests red" });
  assertAdf(body);
  assert.match(adfToText(body), /\*\*Windkeel could not finish\.\*\* Reason: verification failed: tests red/);
});

test("SF: a public comment never carries the raw reason — first line, redacted, no links or paths, capped", () => {
  const raw =
    "git push failed: token ghp_abcdefghijklmnop rejected by https://x-access-token:secret@github.com/acme/app.git " +
    "while writing /var/task/sandbox/work/src/secret.ts " +
    "y".repeat(400) +
    "\n    at Object.<anonymous> (/var/task/dist/stack.js:1:1)";
  const body = adfToText(comment({ state: "FAILED", reason: raw }));
  assert.doesNotMatch(body, /ghp_/);
  assert.doesNotMatch(body, /x-access-token|secret@/);
  assert.doesNotMatch(body, /\/var\/task/);
  assert.doesNotMatch(body, /at Object/);
  const summary = reasonSummary(raw);
  assert.ok(summary.length <= 160, `summary is ${summary.length} chars`);
  assert.equal(reasonSummary(null), null);
  assert.equal(reasonSummary("\n"), null);
});

test("WAITING_FOR_HUMAN with a PR, WAITING_FOR_APPROVAL, CANCELLED", () => {
  const human = adfToText(comment({ state: "WAITING_FOR_HUMAN", prUrl: PR }));
  assert.match(human, /needs a human\.\*\* Draft PR for review/);
  const approval = comment({ state: "WAITING_FOR_APPROVAL" });
  assertAdf(approval);
  assert.match(adfToText(approval), /waiting for approval/);
  const cancelled = comment({ state: "CANCELLED", runUrl: null });
  assertAdf(cancelled);
  assert.match(adfToText(cancelled), new RegExp(`cancelled\\.\\*\\*\\n\\nDetails: run ${RUN}`));
});

test("#389: the verdict — 'Verified ✓' only on a pass; partial and missing verdicts say so", () => {
  const pass = { result: "pass", passed: 2, failed: 0, total: 2, blocking: 0, summary: "2/2 criteria met" };
  const partial = { result: "fail", passed: 1, failed: 1, total: 2, blocking: 0, summary: "1 of 2 criteria failed" };
  const verified = adfToText(comment({ state: "WAITING_FOR_HUMAN", prUrl: PR, verdict: pass }));
  assert.match(verified, /^\*\*Verified ✓ 2\/2 criteria\.\*\* Draft PR for review: \[https:\/\/github\.com\/.*\/pull\/7\]/);
  const notYet = adfToText(comment({ state: "WAITING_FOR_HUMAN", prUrl: PR, verdict: partial }));
  assert.match(notYet, /needs a human\.\*\* Not verified: 1 of 2 criteria failed\. Draft PR for review/);
  const none = adfToText(comment({ state: "WAITING_FOR_HUMAN", prUrl: PR, verdict: null }));
  assert.match(none, /needs a human\.\*\* No verification result\./);
  const failed = adfToText(comment({ state: "MAX_REPAIR_ATTEMPTS_REACHED", reason: "verification failed", verdict: partial }));
  assert.match(failed, /could not finish\.\*\* Not verified: 1 of 2 criteria failed\. Reason: verification failed/);
  for (const text of [notYet, none, failed]) assert.doesNotMatch(text, /Verified ✓/);
  for (const body of [comment({ state: "WAITING_FOR_HUMAN", prUrl: PR, verdict: pass })]) assertAdf(body);
});

test("MF5: the notifier is registered by registerDeploymentNotifiers only when WINDKEEL_CONNECT_JIRA is set", () => {
  const pool = { query: async () => ({ rows: [] }) };
  const tokenSource = new FakeProviderTokenSource();
  try {
    assert.deepEqual(registerDeploymentNotifiers({ pool, env: {}, tokenSource, log: () => {} }), []);
    assert.equal(getSourceNotifier("jira"), undefined, "no Jira connector: no notifier");
    assert.deepEqual(
      registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_JIRA: "jira/windkeel" }, tokenSource, log: () => {} }),
      ["jira"],
    );
    assert.equal(getSourceNotifier("jira")?.sourceType, "jira");
    registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_JIRA: " " }, tokenSource, log: () => {} });
    assert.equal(getSourceNotifier("jira"), undefined, "blank is unset");
  } finally {
    unregisterSourceNotifier("jira");
  }
});

test("MF5: stage-wiring.ts (shared by the local worker and tests) imports no provider notifier", () => {
  const source = readFileSync(join(repoRoot, "src", "factory", "stage-wiring.ts"), "utf8");
  assert.doesNotMatch(source, /jira-intake|createJiraNotifier|registerSourceNotifier/);
});

test("the notifier comments once per committed transition", { skip }, async () => {
  const schema = `windkeel_jira_notifier_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    // A GitHub Enterprise clone URL: the PR link must come from the record, not a hand-built host.
    const repositoryId = await seedFixtureRepository(pool, {
      cloneUrl: "https://ghe.acme.example/platform/uploads.git",
    });
    const organizationId = (await pool.query("select id from organization where is_default")).rows[0].id;
    await createConnection(pool, {
      organizationId,
      provider: "jira",
      installationId: "inst_acme",
      externalTenantId: "cloud-acme",
      externalTenantName: "Acme",
      createdByPrincipalId: null,
    });
    const jira = new FakeJira().site("cloud-acme");
    const tokens = new FakeProviderTokenSource().install("jira", "inst_acme", { tenantId: "cloud-acme", name: "Acme" });
    const logs = [];
    const notifier = createJiraNotifier({
      pool,
      tokens,
      fetch: jira.fetch,
      consoleUrl: () => "https://console.example",
      log: (message, fields) => logs.push({ message, fields }),
    });
    assert.equal(notifier.sourceType, "jira");

    const task = {
      organizationId,
      repositoryId,
      sourceType: "jira",
      sourceContext: { cloudId: "cloud-acme", issueKey: "ENG-42", issueId: "10042", siteUrl: "https://cloud-acme.atlassian.net" },
    };
    const run = { id: RUN, prNumber: 7 };
    const t = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
    const human = (n) => ({ transitionId: t(n), state: "WAITING_FOR_HUMAN", reason: null, terminal: false });

    await notifier.notify(task, run, human(1));
    await notifier.notify(task, run, human(1)); // a replayed step: the same transition row
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 1);
    assert.match(adfToText(jira.commentsOn("cloud-acme", "ENG-42")[0]), /https:\/\/ghe\.acme\.example\/platform\/uploads\/pull\/7/);

    // A rework cycle enters WAITING_FOR_HUMAN again: a new transition, so a new comment.
    await notifier.notify(task, run, human(2));
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 2);
    await notifier.notify(task, run, human(2));
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 2);

    // A "started" outcome (#307: the run first left CREATED) posts nothing — the intake already
    // acknowledged the issue.
    await notifier.notify(task, run, { kind: "started", transitionId: t(5), state: "IMPLEMENTING", reason: null, terminal: false });
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 2);

    // #389: `progress` (entering VERIFYING) is one comment per run — a replay and a repair loop's
    // second entry are found by the run's marker and post nothing.
    const verifying = (n) => ({ kind: "progress", transitionId: t(n), state: "VERIFYING", reason: null, terminal: false });
    await notifier.notify(task, run, verifying(6));
    await notifier.notify(task, run, verifying(6));
    await notifier.notify(task, run, verifying(7));
    const afterProgress = jira.commentsOn("cloud-acme", "ENG-42");
    assert.equal(afterProgress.length, 3);
    const progressText = adfToText(afterProgress[2]);
    assert.match(progressText, /Verifying in an independent sandbox…/);
    assert.match(progressText, new RegExp(`windkeel-run ${RUN} verifying`));
    assert.doesNotMatch(progressText, /verified|ready/i);

    // An aborted signal stops the request; the notifier logs and never throws.
    const controller = new AbortController();
    controller.abort(new Error("time is up"));
    await notifier.notify(task, { ...run, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab" }, verifying(8), controller.signal);
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 3);

    // A task another organization owns, or without routing, is not notified.
    const cancelled = { transitionId: t(3), state: "CANCELLED", reason: null, terminal: true };
    await notifier.notify({ ...task, organizationId: "00000000-0000-0000-0000-000000000000" }, run, cancelled);
    await notifier.notify({ ...task, sourceContext: {} }, run, cancelled);
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 3);

    // A failing Jira is logged and swallowed: a notification never fails the run.
    jira.failAll = 500;
    await notifier.notify(task, run, { transitionId: t(4), state: "FAILED", reason: "x", terminal: true });
    assert.ok(logs.find((l) => l.message === "jira notification failed"));
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
});
