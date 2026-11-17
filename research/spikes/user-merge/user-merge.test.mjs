/**
 * Offline checks of the harness's call sequence against a scripted fake GitHub. These prove the
 * harness does what FINDINGS.md says it does (order, sha guard, no token in output); they prove
 * nothing about GitHub itself — that is the live run's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMergeEligibility } from "./eligibility.mjs";
import { deviceFlow, redact, refreshUserToken, runMergeSequence, userClient } from "./github-user.mjs";

const SHA = "c".repeat(40);
const TOKEN = "ghu_" + "x".repeat(36);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeGitHub({ isDraft = true, files = ["src/a.ts"], afterReady = "CLEAN", mergedBy = "alice", admin = false, rulesetBypass = null } = {}) {
  const pr = { id: "PR_1", state: "OPEN", isDraft, headRefOid: SHA, baseRefName: "main", mergeStateStatus: isDraft ? "DRAFT" : afterReady, mergeable: "MERGEABLE", reviewDecision: "APPROVED", viewerCanMergeAsAdmin: admin, author: { login: "windkeel[bot]" }, mergedBy: null };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: u.pathname, body, auth: init.headers.Authorization });
    if (u.pathname === "/user") return json(200, { login: "alice" });
    if (u.pathname === "/graphql") {
      if (body.query.includes("markPullRequestReadyForReview")) {
        pr.isDraft = false;
        pr.mergeStateStatus = afterReady;
        return json(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
      return json(200, { data: { repository: { pullRequest: { ...pr } } } });
    }
    if (u.pathname.endsWith("/files")) return json(200, files.map((filename) => ({ filename })));
    if (u.pathname === "/repos/o/r/rules/branches/main") return json(200, [{ type: "pull_request", ruleset_id: 42, ruleset_source: "o/r" }]);
    if (u.pathname === "/repos/o/r/rulesets/42") return json(200, { id: 42, name: "main protection", current_user_can_bypass: rulesetBypass ?? "never" });
    if (u.pathname.endsWith("/merge") && init.method === "PUT") {
      if (body.sha !== pr.headRefOid) return json(409, { message: "Head branch was modified. Review and try the merge again." });
      pr.state = "MERGED";
      return json(200, { merged: true, sha: "d".repeat(40), message: "Pull Request successfully merged" });
    }
    if (u.pathname.endsWith("/pulls/7")) return json(200, { merged_by: { login: mergedBy }, merge_commit_sha: "d".repeat(40) });
    return json(404, { message: "Not Found" });
  };
  return { fetchImpl, calls };
}

const stand = { verdictOfRecord: { candidateSha: SHA, verdict: "pass" }, principal: { permissions: ["runs.merge"] }, org: { allowMergingFromWindkeel: true }, app: {} };
const decide = (pr, { markReady }) => evaluateMergeEligibility({ ...stand, pr, markReady });

test("draft: mark ready, re-check, wrong-sha probe gets 409, merge with the verified sha, merged_by is the person", async () => {
  const gh = fakeGitHub();
  const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl: gh.fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide });
  assert.equal(r.ok, true);
  assert.equal(r.mergedBy, "alice");
  const order = r.steps.map((s) => s.step);
  assert.deepEqual(order, ["whoami", "read-pr", "eligibility", "mark-ready", "re-read-pr", "eligibility-after-ready", "stale-sha-probe", "merge", "merged-by"]);
  assert.equal(r.steps.find((s) => s.step === "stale-sha-probe").status, 409);
  const merges = gh.calls.filter((c) => c.path.endsWith("/merge"));
  assert.equal(merges.at(-1).body.sha, SHA);
  assert.ok(gh.calls.every((c) => c.auth === `Bearer ${TOKEN}`), "every call uses the person's token");
  assert.ok(!JSON.stringify(r).includes(TOKEN), "token never in the result");
});

test("dry run performs no mutation", async () => {
  const gh = fakeGitHub();
  const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl: gh.fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide, dryRun: true });
  assert.equal(r.ok, true);
  assert.ok(!gh.calls.some((c) => c.method === "PUT" || c.body?.query?.includes("mutation")));
});

test("a workflow-touching PR is refused before any mutation when the App lacks Workflows", async () => {
  const gh = fakeGitHub({ files: [".github/workflows/ci.yml"] });
  const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl: gh.fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide });
  assert.equal(r.refused, true);
  assert.ok(!gh.calls.some((c) => c.method === "PUT" || c.body?.query?.includes("mutation")));
});

test("BLOCKED after marking ready stops before merge (no implicit admin bypass)", async () => {
  const gh = fakeGitHub({ afterReady: "BLOCKED" });
  const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl: gh.fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide });
  assert.equal(r.refused, true);
  assert.ok(!gh.calls.some((c) => c.method === "PUT"));
});

test("an admin who can bypass, or a ruleset bypass actor, is refused before any mutation (§5.1, amended)", async () => {
  for (const opts of [{ admin: true }, { rulesetBypass: "always" }, { rulesetBypass: "pull_requests_only" }]) {
    const gh = fakeGitHub({ isDraft: false, ...opts });
    const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl: gh.fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide });
    assert.equal(r.refused, true, JSON.stringify(opts));
    assert.equal(r.steps.find((s) => s.step === "eligibility").rules.find((x) => x.id === "bypass").ok, false);
    assert.ok(!gh.calls.some((c) => c.method === "PUT" || c.body?.query?.includes("mutation")));
  }
});

test("merged_by someone else is reported as not attributed", async () => {
  const gh = fakeGitHub({ isDraft: false, mergedBy: "windkeel[bot]" });
  const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl: gh.fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide, probeStaleSha: false });
  assert.equal(r.ok, false);
  assert.equal(r.steps.at(-1).attributedToPerson, false);
});

test("device flow honours authorization_pending and slow_down, and prompts with the code only", async () => {
  const replies = [
    { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
    { error: "authorization_pending" },
    { error: "slow_down", interval: 10 },
    { access_token: TOKEN, expires_in: 28800, refresh_token: "ghr_" + "y".repeat(60), refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" },
  ];
  const sleeps = [];
  const prompts = [];
  let t = 0;
  const set = await deviceFlow({
    clientId: "Iv23test",
    fetchImpl: async () => json(200, replies.shift()),
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    onPrompt: (p) => prompts.push(p),
  });
  assert.equal(set.accessToken, TOKEN);
  assert.equal(set.expiresIn, 28800);
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.deepEqual(Object.keys(prompts[0]).sort(), ["expiresIn", "userCode", "verificationUri"]);
});

test("device flow surfaces access_denied", async () => {
  const replies = [{ device_code: "dc", user_code: "U", verification_uri: "v", expires_in: 900, interval: 1 }, { error: "access_denied" }];
  await assert.rejects(
    deviceFlow({ clientId: "c", fetchImpl: async () => json(200, replies.shift()), sleep: async () => {} }),
    /cancelled/,
  );
});

test("refresh failure never echoes the refresh token", async () => {
  const rt = "ghr_" + "z".repeat(60);
  await assert.rejects(
    refreshUserToken({ clientId: "c", refreshToken: rt, fetchImpl: async () => json(200, { error: "bad_refresh_token" }) }),
    (e) => !e.message.includes(rt) && /bad_refresh_token/.test(e.message),
  );
});

test("redact removes GitHub token shapes", () => {
  assert.equal(redact(`a ${TOKEN} b ghr_${"q".repeat(20)}`), "a [redacted] b [redacted]");
});

test("the wrong-sha probe must get exactly 409; anything else stops before the real merge", async () => {
  for (const status of [403, 405, 422, 500]) {
    const gh = fakeGitHub({ isDraft: false });
    const inner = gh.fetchImpl;
    const fetchImpl = async (url, init) =>
      new URL(url).pathname.endsWith("/merge") && init.method === "PUT" && JSON.parse(init.body).sha !== SHA ? json(status, { message: "no" }) : inner(url, init);
    const r = await runMergeSequence({ client: userClient({ token: TOKEN, fetchImpl }), repo: "o/r", number: 7, expectedSha: SHA, decide });
    assert.equal(r.ok, false, `status ${status}`);
    assert.match(r.error, new RegExp(`got ${status}, not 409`));
    assert.equal(gh.calls.filter((c) => c.path.endsWith("/merge")).length, 0, "no real merge after a failed probe");
  }
});
