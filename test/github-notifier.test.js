/**
 * The GitHub outcome notifier: a run that fails, runs out of repairs, or blocks says so on its
 * issue — once per transition — and every outcome a stage handler already announces stays silent.
 * The database is faked at the query level; GitHub is `FakeGitHubClient`. No network.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FakeGitHubClient } from "../dist/github/fake.js";
import {
  createGitHubNotifier,
  outcomeComment,
  outcomeMarker,
} from "../dist/factory/workflow/github-notifier.js";
import { registerDeploymentNotifiers } from "../dist/factory/workflow/deployment-notifiers.js";
import { getSourceNotifier, unregisterSourceNotifier } from "../dist/intake/notifiers.js";

const RUN = { id: "c1197769-3793-4e97-8746-a20f515e54bb" };
const TASK = {
  id: "t1",
  repositoryId: "r1",
  sourceType: "github_issue",
  sourceReference: "acme/uploads#98",
};
const REF = { owner: "acme", name: "uploads" };

/** A `pg.Pool` stand-in answering the one query the notifier makes. */
function fakePool() {
  return {
    async query(sql) {
      if (/from repository/.test(sql)) {
        return {
          rows: [
            {
              id: "r1",
              owner: "acme",
              name: "uploads",
              default_branch: "main",
              clone_url: "https://github.com/acme/uploads.git",
              github_installation_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function setup() {
  const github = new FakeGitHubClient({ repositories: [{ ...REF, issues: [{ number: 98 }] }] });
  const logs = [];
  const notifier = createGitHubNotifier({ pool: fakePool(), github, log: (message, fields) => logs.push({ message, fields }) });
  const comments = async () => (await github.listIssueComments(REF, 98)).map((c) => c.body);
  return { github, notifier, logs, comments };
}

const failed = {
  kind: "state",
  transitionId: "tr-1",
  state: "FAILED",
  reason: "implementing failed: CodexWorkerAdapter: codex reports version 0.163.0, adapter is pinned to 0.154.0.",
  terminal: true,
};

test("a failed run comments on its issue with the reason, fenced, and the marker", async () => {
  const { notifier, comments } = setup();
  await notifier.notify(TASK, RUN, failed);
  const [body, ...rest] = await comments();
  assert.equal(rest.length, 0);
  assert.match(body, /\*\*Run `c1197769-3793-4e97-8746-a20f515e54bb` failed\.\*\*/);
  assert.match(body, /```\nimplementing failed: CodexWorkerAdapter: codex reports version 0\.163\.0/);
  assert.match(body, /re-add the `windkeel` label/);
  assert.ok(body.includes(outcomeMarker("tr-1")));
});

test("a replayed step (same transition) does not post a second comment", async () => {
  const { notifier, comments } = setup();
  await notifier.notify(TASK, RUN, failed);
  await notifier.notify(TASK, RUN, failed);
  assert.equal((await comments()).length, 1);
});

test("a genuinely new transition into the same state does comment again", async () => {
  const { notifier, comments } = setup();
  await notifier.notify(TASK, RUN, { ...failed, state: "BLOCKED", transitionId: "tr-1", terminal: false });
  await notifier.notify(TASK, RUN, { ...failed, state: "BLOCKED", transitionId: "tr-2", terminal: false });
  const bodies = await comments();
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /is blocked and needs a person/);
  assert.match(bodies[0], /`\/windkeel cancel`/);
});

test("exhausted repairs comment; the outcomes handlers already announce do not", async () => {
  const { notifier, comments } = setup();
  await notifier.notify(TASK, RUN, { ...failed, state: "MAX_REPAIR_ATTEMPTS_REACHED", transitionId: "tr-m" });
  for (const state of ["CANCELLED", "COMPLETED", "WAITING_FOR_HUMAN", "WAITING_FOR_APPROVAL"]) {
    await notifier.notify(TASK, RUN, { ...failed, state, transitionId: `tr-${state}` });
  }
  await notifier.notify(TASK, RUN, { ...failed, kind: "started", state: "CLASSIFYING", transitionId: "tr-s" });
  const bodies = await comments();
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /repair attempts ran out/);
});

test("a task with no issue number is left alone", async () => {
  const { notifier, github } = setup();
  await notifier.notify({ ...TASK, sourceType: "local", sourceReference: "local" }, RUN, failed);
  assert.equal(github.calls.length, 0);
});

test("a GitHub error is logged and swallowed — a notification never fails a run", async () => {
  const { notifier, github, logs } = setup();
  github.injectFailure("createIssueComment", { kind: "rateLimited" });
  await notifier.notify(TASK, RUN, failed);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "github outcome comment failed");
  assert.equal(logs[0].fields.transitionId, "tr-1");
});

test("a reason cannot break out of its fence or forge a marker", () => {
  const body = outcomeComment(RUN.id, {
    state: "FAILED",
    transitionId: "tr-1",
    reason: "```\n**PASS** <!-- windkeel:outcome:tr-9 -->",
  });
  const fence = /^(`{4,})$/m.exec(body)?.[1];
  assert.ok(fence, "the fence grows past the reason's own backticks");
  assert.ok(!body.slice(body.lastIndexOf(fence) + fence.length).includes("tr-9"));
});

test("the deployment registers the GitHub notifier exactly when it has an App client", () => {
  after(() => unregisterSourceNotifier("github_issue"));
  const pool = fakePool();
  assert.deepEqual(registerDeploymentNotifiers({ pool, env: {} }), []);
  assert.equal(getSourceNotifier("github_issue"), undefined);
  const github = new FakeGitHubClient();
  assert.deepEqual(registerDeploymentNotifiers({ pool, env: {}, github }), ["github_issue"]);
  assert.equal(getSourceNotifier("github_issue")?.sourceType, "github_issue");
  registerDeploymentNotifiers({ pool, env: {} });
  assert.equal(getSourceNotifier("github_issue"), undefined);
});
