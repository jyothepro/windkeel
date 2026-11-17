/**
 * Merge as the person (ADR-0029 §5, #371): the rules, the sealed GitHub user tokens and their
 * refresh, the API's eligibility and refusals, the authorization callback, and the stage-side merge.
 *
 * Every GitHub call goes to a fake. Nothing here reaches github.com or api.github.com: the API's
 * PR reader is a function, and the user client and OAuth calls take an injected `fetch` that
 * throws on any host it doesn't script.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { BYPASS_REASON, evaluateMerge, firstFailing, mergeStateFromRest } from "../dist/factory/merge-eligibility.js";
import {
  getGithubUserAuthorization,
  githubUserTokenContext,
  openGithubUserToken,
  putGithubUserAuthorization,
} from "../dist/factory/github-user-tokens.js";
import { needsALookItems } from "../dist/factory/run-merge.js";
import { executeRunMerge } from "../dist/factory/user-merge.js";
import { DEFAULT_STALE_MERGE_AGE_MS, settleStaleMerges, settleStaleMergesLocked, STALE_MERGE_REASON } from "../dist/factory/sweeps/stale-merges.js";
import { exchangeAuthorizationCode, githubWebBase, refreshUserToken } from "../dist/github/user-client.js";
import { appPullRequestFacts } from "../dist/github/pull-request-facts.js";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { RestGitHubClient } from "../dist/github/rest.js";
import { generateSecretKeyPair, openSecret } from "../dist/factory/secret-box.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  insertVerificationRun,
  updateEngineeringRun,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const PAIR = generateSecretKeyPair();
const SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);
const ACCESS = "ghu_" + "a".repeat(36);
const REFRESH = "ghr_" + "b".repeat(60);
const NEW_ACCESS = "ghu_" + "n".repeat(36);
const NEW_REFRESH = "ghr_" + "m".repeat(60);
const ALICE = { id: 1001, login: "alice" };
const MALLORY = { id: 6666, login: "mallory" };
const REPO_ID = "11111111-1111-1111-1111-111111111111";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------------------------
// The rules, each one

const base = (over = {}) => ({
  deploymentEnabled: true,
  verdictOfRecord: { candidateSha: SHA, verdict: "pass", needsALook: [] },
  acknowledgements: [],
  pr: { state: "OPEN", headSha: SHA, isDraft: false, changedPaths: ["src/a.ts"], changedPathsComplete: true, mergeStateStatus: "CLEAN", viewerCanMergeAsAdmin: false, viewerCanBypassRulesets: false },
  principal: { permissions: ["runs.merge"] },
  org: { allowMergingFromWindkeel: true },
  app: { workflowsPermission: null },
  markReady: false,
  authorization: { status: "valid", githubUserId: ALICE.id, githubLogin: ALICE.login },
  linkedGithubUserId: ALICE.id,
  ...over,
});
const failingId = (input) => firstFailing(evaluateMerge(input))?.id ?? null;

test("eligible: every rule holds and says why, in the order the console shows them", () => {
  const r = evaluateMerge(base());
  assert.equal(r.eligible, true);
  assert.deepEqual(r.rules.map((x) => x.id), [
    "enabled", "pr-open", "head-verified", "verdict", "warn-acknowledged", "permission", "org-allows", "draft", "workflows", "protection", "bypass", "authorization",
  ]);
  for (const x of r.rules) assert.ok(x.ok && x.reason.length > 0, x.id);
});

test("each rule refuses on its own", () => {
  const pr = base().pr;
  assert.equal(failingId(base({ deploymentEnabled: false })), "enabled");
  assert.equal(failingId(base({ pr: { ...pr, state: "CLOSED" } })), "pr-open");
  assert.equal(failingId(base({ pr: { ...pr, headSha: OTHER_SHA } })), "head-verified");
  assert.equal(failingId(base({ verdictOfRecord: { candidateSha: SHA, verdict: "fail" } })), "verdict");
  assert.equal(
    failingId(base({ verdictOfRecord: { candidateSha: SHA, verdict: "warn", needsALook: [{ id: "n1" }] } })),
    "warn-acknowledged",
  );
  assert.equal(failingId(base({ principal: { permissions: ["runs.read", "runs.write"] } })), "permission");
  assert.equal(failingId(base({ org: { allowMergingFromWindkeel: false } })), "org-allows");
  assert.equal(failingId(base({ pr: { ...pr, isDraft: true, mergeStateStatus: "DRAFT" } })), "draft");
  assert.equal(failingId(base({ pr: { ...pr, changedPaths: [".github/workflows/ci.yml"] } })), "workflows");
  assert.equal(failingId(base({ pr: { ...pr, mergeStateStatus: "BLOCKED", viewerCanMergeAsAdmin: true } })), "protection");
  assert.equal(failingId(base({ pr: { ...pr, viewerCanMergeAsAdmin: true } })), "bypass");
  assert.equal(failingId(base({ pr: { ...pr, viewerCanBypassRulesets: true, bypassRulesets: ["main"] } })), "bypass");
  assert.equal(failingId(base({ authorization: null })), "authorization");
});

test("bypass (§5.1, amended): refused with the reason that names the fix; unknown blocks for the person, not for the App's preview", () => {
  const pr = base().pr;
  const bypass = (over) => evaluateMerge(base(over)).rules.find((r) => r.id === "bypass");
  const admin = bypass({ pr: { ...pr, viewerCanMergeAsAdmin: true } });
  assert.equal(admin.reason, BYPASS_REASON);
  assert.match(admin.reason, /Do not allow bypassing the above settings/);
  assert.match(admin.reason, /empty the ruleset's bypass list/);
  const unknown = { ...pr, viewerCanMergeAsAdmin: undefined, viewerCanBypassRulesets: undefined };
  assert.equal(failingId(base({ pr: unknown })), "bypass");
  assert.equal(evaluateMerge(base({ pr: unknown, seenBy: "app" })).eligible, true);
  // GitHub saying "can't bypass" for admins (protection enforced for admins) merges.
  assert.equal(evaluateMerge(base()).eligible, true);
});

test("authorization: missing, needing renewal, another GitHub account, or no linked account all refuse", () => {
  const reason = (over) => evaluateMerge(base(over)).rules.find((r) => r.id === "authorization");
  assert.match(reason({ authorization: null }).reason, /haven't connected GitHub/);
  assert.match(reason({ authorization: { ...base().authorization, status: "needs_reauth" } }).reason, /needs renewing/);
  const other = reason({ authorization: { status: "valid", githubUserId: MALLORY.id, githubLogin: MALLORY.login } });
  assert.equal(other.ok, false);
  assert.match(other.reason, /@mallory, not the GitHub account you sign in with/);
  assert.equal(reason({ linkedGithubUserId: null }).ok, false);
});

test("an acknowledged warn and a draft with Mark ready and merge are eligible", () => {
  const warn = { candidateSha: SHA, verdict: "warn", needsALook: [{ id: "n1" }, { id: "n2" }] };
  assert.equal(evaluateMerge(base({ verdictOfRecord: warn, acknowledgements: ["n1", "n2"] })).eligible, true);
  assert.equal(evaluateMerge(base({ pr: { ...base().pr, isDraft: true, mergeStateStatus: "DRAFT" }, markReady: true })).eligible, true);
});

test("OAuth goes to the web host of the API base: github.com, a GHES host, or a GHE.com subdomain", () => {
  assert.equal(githubWebBase(undefined), "https://github.com");
  assert.equal(githubWebBase("https://api.github.com"), "https://github.com");
  assert.equal(githubWebBase("https://ghes.example.com/api/v3/"), "https://ghes.example.com");
  assert.equal(githubWebBase("https://api.octocorp.ghe.com"), "https://octocorp.ghe.com");
});

test("REST mergeable_state reads as GraphQL's MergeStateStatus", () => {
  assert.equal(mergeStateFromRest("blocked"), "BLOCKED");
  assert.equal(mergeStateFromRest("has_hooks"), "HAS_HOOKS");
  assert.equal(mergeStateFromRest(null), "UNKNOWN");
});

test("a warn always asks for at least one acknowledgement, and a pass for none", () => {
  const report = (verdict, extra = {}) => ({
    task: { criteriaProvenance: "extracted", criteriaApprovedBy: null },
    incompleteStages: [],
    verifications: [{ verdictOfRecord: true, verdict, riskSummary: {} }],
    ...extra,
  });
  assert.deepEqual(needsALookItems(report("pass")), []);
  assert.deepEqual(needsALookItems(report("warn")).map((i) => i.id), ["warn"]);
  const items = needsALookItems(
    report("warn", {
      incompleteStages: [{ stage: "security", tool: "semgrep", detail: "killed" }],
      verifications: [{ verdictOfRecord: true, verdict: "warn", riskSummary: { nonBlocking: ["f-1"] } }],
    }),
  );
  assert.deepEqual(items.map((i) => i.id), ["incomplete:security:semgrep", "finding:f-1"]);
});

// ---------------------------------------------------------------------------------------------
// The App still cannot merge

test("the App's GitHubClient has no merge, approve or ready-for-review method", () => {
  const forbidden = /merge|approve|ready/i;
  for (const Client of [FakeGitHubClient, RestGitHubClient]) {
    const names = Object.getOwnPropertyNames(Client.prototype).filter((n) => n !== "constructor");
    assert.ok(names.length > 5, `${Client.name} has methods to check`);
    const offending = names.filter((n) => forbidden.test(n));
    assert.deepEqual(offending, [], `${Client.name} must not have ${offending.join(", ")} (ADR-0009 §5)`);
  }
  // And the interface itself declares none: the only mention is the tripwire's operation names.
  const source = readFileSync(join(repoRoot, "src/github/client.ts"), "utf8");
  const iface = source.slice(source.indexOf("export interface GitHubClient"), source.indexOf("export function assertSameRepositoryHead"));
  const methods = [...iface.matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map((m) => m[1]);
  assert.ok(methods.includes("getPullRequest"));
  assert.deepEqual(methods.filter((m) => forbidden.test(m)), []);
});

// ---------------------------------------------------------------------------------------------
// GitHub calls with no GitHub

test("a failed code exchange or refresh never echoes the code, the verifier, the secret or a token", async () => {
  const code = "code-0123456789abcdef";
  const verifier = "v".repeat(50);
  await assert.rejects(
    exchangeAuthorizationCode({ clientId: "Iv1", clientSecret: "shh-secret-value", code, codeVerifier: verifier, fetchImpl: async () => json(200, { error: "bad_verification_code" }) }),
    (e) => /bad_verification_code/.test(e.message) && ![code, verifier, "shh-secret-value"].some((s) => e.message.includes(s)),
  );
  await assert.rejects(
    refreshUserToken({ clientId: "Iv1", refreshToken: REFRESH, fetchImpl: async () => json(200, { error: "bad_refresh_token" }) }),
    (e) => !e.message.includes(REFRESH),
  );
});

test("the App's PR reader asks for a read-only token and maps state, draft, merge state and files", async () => {
  const minted = [];
  const github = { mintInstallationToken: async (input) => (minted.push(input), { token: "ghs_installation_token_xyz", expiresAt: "", repository: input.repository, permissions: input.permissions }) };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url.endsWith("/pulls/7")) return json(200, { state: "open", merged: false, draft: true, head: { sha: SHA }, mergeable_state: "draft", html_url: "https://github.com/o/r/pull/7" });
    if (url.includes("/pulls/7/files")) return json(200, [{ filename: "a.ts" }, { filename: "b.ts", previous_filename: ".github/workflows/old.yml" }]);
    throw new Error(`unscripted ${url}`);
  };
  const facts = await appPullRequestFacts(github, { apiBase: "https://gh.test", fetchImpl })({ owner: "o", name: "r" }, 7);
  assert.deepEqual(minted[0].permissions, { pull_requests: "read" });
  assert.equal(facts.state, "OPEN");
  assert.equal(facts.isDraft, true);
  assert.equal(facts.mergeStateStatus, "DRAFT");
  assert.deepEqual(facts.changedPaths, ["a.ts", "b.ts", ".github/workflows/old.yml"]);
  assert.ok(calls.every((c) => c.auth === "Bearer ghs_installation_token_xyz"));
});

// ---------------------------------------------------------------------------------------------
// The database

let counter = 0;
async function withSchema(fn) {
  const schema = `windkeel_merge_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const org = (await pool.query("select id from organization where is_default")).rows[0].id;
    const person = async (who, role) => {
      const { rows } = await pool.query(
        `insert into principal (account_id, kind, display_name, github_user_id, github_login)
         select account_id, 'user', $2, $1, $2 from organization where is_default returning id`,
        [who.id, who.login],
      );
      await pool.query(
        `insert into membership (organization_id, principal_id, access_role_id)
         select $1, $2, id from access_role where key = $3 and account_id is null`,
        [org, rows[0].id, role],
      );
      return rows[0].id;
    };
    const alice = await person(ALICE, "admin");
    const bob = await person({ id: 2002, login: "bob" }, "member");
    await fn({ pool, org, alice, bob });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** A run in PR_READY with PR #7 and a completed verification of `SHA`. */
async function verifiedRun(pool, { verdict = "pass", riskSummary = {} } = {}) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: REPO_ID,
    sourceType: "api",
    sourceReference: `api:test:${Math.random()}`,
    title: "Make the gauge read zero",
    description: "- [ ] zero",
    acceptanceCriteria: [{ id: "ac-1", text: "the gauge reads zero" }],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  const v = await insertVerificationRun(pool, { engineeringRunId: run.id, candidateSha: SHA, policyVersion: "test" });
  await updateVerificationRun(pool, v.id, { verdict, riskSummary, startedAt: new Date(Date.now() - 60_000), completedAt: new Date(), evidenceManifestDigest: "sha256:abc" });
  await updateEngineeringRun(pool, run.id, { status: "PR_READY", prNumber: 7, finalVerdict: verdict });
  return { run, verification: v };
}

const tokens = (over = {}) => ({ accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 28800, refreshTokenExpiresIn: 15897600, scope: "", ...over });

test("tokens are sealed separately, bound to the person and the GitHub user, and never returned", { skip }, async () => {
  await withSchema(async ({ pool, alice, bob }) => {
    const view = await putGithubUserAuthorization(pool, { principalId: alice, githubUserId: ALICE.id, githubLogin: ALICE.login, tokens: tokens(), publicKey: PAIR.publicKey });
    assert.equal(view.status, "valid");
    assert.equal(view.hasRefreshToken, true);
    const serialised = JSON.stringify([view, await getGithubUserAuthorization(pool, alice)]);
    assert.ok(!serialised.includes(ACCESS) && !serialised.includes(REFRESH) && !serialised.includes("orqonsealv2"));

    const { rows } = await pool.query("select sealed_access_token, sealed_refresh_token from github_user_authorization");
    const row = rows[0];
    assert.match(row.sealed_access_token, /^orqonsealv2\./);
    assert.notEqual(row.sealed_access_token, row.sealed_refresh_token);
    assert.ok(!JSON.stringify(rows).includes(ACCESS) && !JSON.stringify(rows).includes(REFRESH));
    assert.equal(openSecret(PAIR.privateKey, githubUserTokenContext(alice, ALICE.id, "access"), row.sealed_access_token), ACCESS);
    // Swapped, or moved to another person, it does not open.
    assert.throws(() => openSecret(PAIR.privateKey, githubUserTokenContext(alice, ALICE.id, "refresh"), row.sealed_access_token), /authentication failed/);
    assert.throws(() => openSecret(PAIR.privateKey, githubUserTokenContext(bob, ALICE.id, "access"), row.sealed_access_token), /authentication failed/);
    assert.throws(() => openSecret(PAIR.privateKey, githubUserTokenContext(alice, MALLORY.id, "access"), row.sealed_access_token), /authentication failed/);
  });
});

test("a token that is not about to expire is opened without a refresh", { skip }, async () => {
  await withSchema(async ({ pool, alice }) => {
    await putGithubUserAuthorization(pool, { principalId: alice, githubUserId: ALICE.id, githubLogin: ALICE.login, tokens: tokens(), publicKey: PAIR.publicKey });
    let refreshed = 0;
    const opened = await openGithubUserToken(pool, [PAIR.privateKey], alice, { refresh: async () => (refreshed++, tokens()) });
    assert.equal(opened.accessToken, ACCESS);
    assert.equal(opened.refreshed, false);
    assert.equal(refreshed, 0);
  });
});

test("an expiring token is refreshed once under the row lock, and the new pair is stored before it is used", { skip }, async () => {
  await withSchema(async ({ pool, alice }) => {
    // Expires in 60 s — inside the five-minute window.
    await putGithubUserAuthorization(pool, { principalId: alice, githubUserId: ALICE.id, githubLogin: ALICE.login, tokens: tokens({ expiresIn: 60 }), publicKey: PAIR.publicKey });
    let refreshes = 0;
    const seen = [];
    const refresh = async (refreshToken) => {
      seen.push(refreshToken);
      refreshes++;
      await new Promise((r) => setTimeout(r, 50)); // long enough for the second opener to queue on the lock
      return tokens({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH });
    };
    const [a, b] = await Promise.all([
      openGithubUserToken(pool, [PAIR.privateKey], alice, { refresh }),
      openGithubUserToken(pool, [PAIR.privateKey], alice, { refresh }),
    ]);
    assert.equal(refreshes, 1, "the single-use refresh token is spent exactly once");
    assert.deepEqual(seen, [REFRESH]);
    assert.equal(a.accessToken, NEW_ACCESS);
    assert.equal(b.accessToken, NEW_ACCESS);
    assert.equal([a, b].filter((x) => x.refreshed).length, 1);
    const { rows } = await pool.query("select sealed_access_token, sealed_refresh_token, refreshed_at from github_user_authorization");
    assert.equal(openSecret(PAIR.privateKey, githubUserTokenContext(alice, ALICE.id, "access"), rows[0].sealed_access_token), NEW_ACCESS);
    assert.equal(openSecret(PAIR.privateKey, githubUserTokenContext(alice, ALICE.id, "refresh"), rows[0].sealed_refresh_token), NEW_REFRESH);
    assert.ok(rows[0].refreshed_at);
  });
});

test("a refused refresh marks the authorization needs_reauth and says so without the token", { skip }, async () => {
  await withSchema(async ({ pool, alice }) => {
    await putGithubUserAuthorization(pool, { principalId: alice, githubUserId: ALICE.id, githubLogin: ALICE.login, tokens: tokens({ expiresIn: 1 }), publicKey: PAIR.publicKey });
    await assert.rejects(
      openGithubUserToken(pool, [PAIR.privateKey], alice, {
        refresh: (refreshToken) => refreshUserToken({ clientId: "Iv1", refreshToken, fetchImpl: async () => json(200, { error: "bad_refresh_token" }) }),
      }),
      (e) => e.code === "refresh_failed" && !e.message.includes(REFRESH),
    );
    const after = await getGithubUserAuthorization(pool, alice);
    assert.equal(after.status, "needs_reauth");
    await assert.rejects(openGithubUserToken(pool, [PAIR.privateKey], alice, { refresh: async () => tokens() }), (e) => e.code === "needs_reauth");
  });
});

// ---------------------------------------------------------------------------------------------
// The API

const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    return { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login };
  },
};
const ALICE_SESSION = `session:sub-alice:${ALICE.id}:alice`;
const BOB_SESSION = "session:sub-bob:2002:bob";
const BOOTSTRAP = "test-bootstrap-token";

function api(pool, { enabled = true, pr = {}, started = [], fetchImpl, startFails = false } = {}) {
  const prFacts = { state: "OPEN", headSha: SHA, isDraft: false, mergeStateStatus: "CLEAN", changedPaths: ["src/a.ts"], changedPathsComplete: true, htmlUrl: "https://github.com/o/r/pull/7" };
  const deps = {
    pool,
    control: {},
    secretPublicKey: PAIR.publicKey,
    merge: {
      enabled,
      start: async (id) => {
        if (startFails) throw new Error("queue down");
        started.push(id);
      },
      pullRequestFacts: async () => ({ ...prFacts, ...(typeof pr === "function" ? pr() : pr) }),
      githubApp: { clientId: "Iv1.test", clientSecret: "client-secret-test" },
      apiBase: "https://api.github.test",
      fetchImpl: fetchImpl ?? (async (url) => { throw new Error(`unscripted ${url}`); }),
    },
  };
  const auth = { token: BOOTSTRAP, subject: "operator", sessions: fakeSessions };
  return (method, path, bearer = ALICE_SESSION, body) =>
    handleApiRequest(deps, auth, { method, path, query: { get: () => undefined }, headers: { authorization: `Bearer ${bearer}` }, body });
}

async function allowAndConnect(pool, org, alice) {
  await pool.query("update organization set allow_merge = true where id = $1", [org]);
  await putGithubUserAuthorization(pool, { principalId: alice, githubUserId: ALICE.id, githubLogin: ALICE.login, tokens: tokens(), publicKey: PAIR.publicKey });
}

test("with WINDKEEL_MERGE off nothing is reachable", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const { run } = await verifiedRun(pool);
    const call = api(pool, { enabled: false });
    for (const [method, path, body] of [
      ["GET", `/v1/runs/${run.id}/merge-eligibility`],
      ["POST", `/v1/runs/${run.id}/merge`, {}],
      ["GET", "/v1/merging"],
      ["PUT", "/v1/merging", { allowMerge: true }],
      ["GET", "/v1/github-authorization"],
      ["POST", "/v1/github-authorization", { code: "x", codeVerifier: "v".repeat(43) }],
      ["DELETE", "/v1/github-authorization"],
    ]) {
      const res = await call(method, path, ALICE_SESSION, body);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.body.code, "merging_disabled");
    }
  });
});

test("the organization setting is off by default and only an admin turns it on", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const call = api(pool);
    const read = await call("GET", "/v1/merging");
    assert.equal(read.status, 200);
    assert.equal(read.body.allowMerge, false);
    assert.equal(read.body.canManage, true);
    assert.equal(read.body.authorization, null);
    const refused = await call("PUT", "/v1/merging", BOB_SESSION, { allowMerge: true });
    assert.equal(refused.status, 403);
    const on = await call("PUT", "/v1/merging", ALICE_SESSION, { allowMerge: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.allowMerge, true);
  });
});

test("runs.merge is Admin's, not Member's", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const call = api(pool);
    const self = async (s) => (await call("GET", "/v1/self", s)).body.organizations.find((o) => o.id === org).permissions;
    assert.ok((await self(ALICE_SESSION)).includes("runs.merge"));
    assert.ok(!(await self(BOB_SESSION)).includes("runs.merge"));
  });
});

test("eligibility answers each rule with its reason, and a warn lists what to acknowledge", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    const { run } = await verifiedRun(pool, { verdict: "warn", riskSummary: { nonBlocking: ["f-1"] } });
    const call = api(pool);
    const before = await call("GET", `/v1/runs/${run.id}/merge-eligibility`);
    assert.equal(before.status, 200);
    assert.equal(before.body.eligible, false);
    const rule = (body, id) => body.rules.find((r) => r.id === id);
    assert.equal(rule(before.body, "org-allows").ok, false);
    assert.equal(rule(before.body, "authorization").ok, false);
    assert.equal(before.body.verifiedSha, SHA);
    assert.deepEqual(before.body.needsAcknowledgement.map((i) => i.id), ["finding:f-1"]);

    await allowAndConnect(pool, org, alice);
    const after = await call("GET", `/v1/runs/${run.id}/merge-eligibility`);
    assert.equal(after.body.eligible, true, JSON.stringify(after.body.failing));
    assert.match(rule(after.body, "warn-acknowledged").reason, /1 Needs-a-look item to acknowledge/);
    assert.equal(after.body.authorization.githubLogin, "alice");
    assert.ok(!JSON.stringify(after.body).includes(ACCESS));

    // A member sees why they can't, by name.
    const bob = await call("GET", `/v1/runs/${run.id}/merge-eligibility`, BOB_SESSION);
    assert.equal(bob.body.failing.id, "permission");
  });
});

test("merge refusals: each names its rule, and nothing is recorded or started", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const { run } = await verifiedRun(pool);
    const started = [];
    const refusedBy = async (opts, body = {}, bearer = ALICE_SESSION) => {
      const res = await api(pool, { started, ...opts })("POST", `/v1/runs/${run.id}/merge`, bearer, body);
      return res;
    };
    const expect = async (res, rule) => {
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, "merge_refused");
      assert.equal(res.body.rule, rule);
    };
    await expect(await refusedBy({ pr: { headSha: OTHER_SHA } }), "head-verified");
    await expect(await refusedBy({ pr: { mergeStateStatus: "BLOCKED" } }), "protection");
    await expect(await refusedBy({ pr: { changedPaths: ["src/a.ts", ".github/workflows/ci.yml"] } }), "workflows");
    await expect(await refusedBy({ pr: { isDraft: true, mergeStateStatus: "DRAFT" } }), "draft");

    const member = await refusedBy({}, {}, BOB_SESSION);
    assert.equal(member.status, 403);
    assert.equal(member.body.missing, "runs.merge");

    const viaToken = await refusedBy({}, {}, BOOTSTRAP);
    assert.equal(viaToken.status, 403);
    assert.equal(viaToken.body.code, "session_required");

    await pool.query("update organization set allow_merge = false where id = $1", [org]);
    await expect(await refusedBy({}), "org-allows");
    await pool.query("update organization set allow_merge = true where id = $1", [org]);

    // An authorization for another GitHub account than the one alice signs in with.
    await pool.query("update github_user_authorization set github_user_id = $1, github_login = 'mallory'", [MALLORY.id]);
    await expect(await refusedBy({}), "authorization");

    assert.deepEqual(started, []);
    assert.equal((await pool.query("select count(*)::int as n from run_merge")).rows[0].n, 0);
  });
});

test("a fail verdict and an unacknowledged warn are refused", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const failed = await verifiedRun(pool, { verdict: "fail" });
    const res = await api(pool)("POST", `/v1/runs/${failed.run.id}/merge`, ALICE_SESSION, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.rule, "verdict");

    const warned = await verifiedRun(pool, { verdict: "warn", riskSummary: { nonBlocking: ["f-1", "f-2"] } });
    const partial = await api(pool)("POST", `/v1/runs/${warned.run.id}/merge`, ALICE_SESSION, { acknowledgements: ["finding:f-1"] });
    assert.equal(partial.status, 409);
    assert.equal(partial.body.rule, "warn-acknowledged");
    assert.match(partial.body.error, /finding:f-2/);
    // #393 8A: a failed verification leaves no merge in the audit trail, requested or done.
    const { rows } = await pool.query("select count(*)::int as n from audit_event where action in ('run.merge_requested', 'run.merged')");
    assert.equal(rows[0].n, 0);
  });
});

test("an eligible merge is recorded pending with its acknowledgements and started by id", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const { run, verification } = await verifiedRun(pool, { verdict: "warn", riskSummary: { nonBlocking: ["f-1"] } });
    const started = [];
    const call = api(pool, { started, pr: { isDraft: true, mergeStateStatus: "DRAFT" } });
    const res = await call("POST", `/v1/runs/${run.id}/merge`, ALICE_SESSION, { acknowledgements: ["finding:f-1"], markReady: true, mergeMethod: "squash" });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.merge.status, "pending");
    assert.deepEqual(started, [res.body.merge.id]);
    const { rows } = await pool.query("select * from run_merge");
    assert.equal(rows[0].principal_id, alice);
    assert.equal(rows[0].verified_sha, SHA);
    assert.equal(rows[0].verification_run_id, verification.id);
    assert.equal(rows[0].verdict, "warn");
    assert.equal(rows[0].verdict_digest, "sha256:abc");
    assert.equal(rows[0].mark_ready, true);
    assert.deepEqual(rows[0].acknowledgements.map((a) => a.id), ["finding:f-1"]);

    const again = await call("POST", `/v1/runs/${run.id}/merge`, ALICE_SESSION, { acknowledgements: ["finding:f-1"], markReady: true });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "merge_in_progress");

    const eligibility = await call("GET", `/v1/runs/${run.id}/merge-eligibility`);
    assert.equal(eligibility.body.merge.status, "pending");

    // #393 8A: the request is audited as the person, naming the verification it rests on.
    const { rows: events } = await pool.query("select action, actor_principal_id, detail from audit_event where action like 'run.merge%'");
    assert.deepEqual(events.map((e) => e.action), ["run.merge_requested"], "the refused second request records nothing");
    assert.equal(events[0].actor_principal_id, alice);
    assert.equal(events[0].detail.verificationRunId, verification.id);
    assert.equal(events[0].detail.verifiedSha, SHA);
  });
});

test("a merge that cannot be started is settled failed and says nothing was merged", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const { run } = await verifiedRun(pool);
    const res = await api(pool, { startFails: true })("POST", `/v1/runs/${run.id}/merge`, ALICE_SESSION, {});
    assert.equal(res.status, 503);
    assert.equal((await pool.query("select status from run_merge")).rows[0].status, "failed");
  });
});

/** The OAuth endpoint and /user, for the authorization callback. The API base is api.github.test, so OAuth is on github.test (`githubWebBase`). */
function oauthFake(user) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url === "https://github.test/login/oauth/access_token") {
      const params = new URLSearchParams(init.body);
      if (params.get("code") !== "good-code" || params.get("code_verifier") !== "v".repeat(43)) return json(200, { error: "bad_verification_code" });
      return json(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 28800, refresh_token_expires_in: 15897600, scope: "", token_type: "bearer" });
    }
    if (url === "https://api.github.test/user") return json(200, user);
    if (url === "https://api.github.test/applications/Iv1.test/token" && init.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unscripted ${url}`);
  };
  return { fetchImpl, calls };
}

test("connecting GitHub stores the person's tokens sealed, and answers without them", { skip }, async () => {
  await withSchema(async ({ pool, alice }) => {
    const gh = oauthFake(ALICE);
    const res = await api(pool, { fetchImpl: gh.fetchImpl })("POST", "/v1/github-authorization", ALICE_SESSION, { code: "good-code", codeVerifier: "v".repeat(43) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.authorization.githubLogin, "alice");
    assert.ok(!JSON.stringify(res.body).includes(ACCESS) && !JSON.stringify(res.body).includes(REFRESH));
    const exchange = new URLSearchParams(gh.calls[0].body);
    assert.equal(exchange.get("client_secret"), "client-secret-test");
    assert.equal(exchange.get("code_verifier"), "v".repeat(43));
    const stored = await getGithubUserAuthorization(pool, alice);
    assert.equal(stored.githubUserId, ALICE.id);

    const bad = await api(pool, { fetchImpl: gh.fetchImpl })("POST", "/v1/github-authorization", ALICE_SESSION, { code: "wrong", codeVerifier: "v".repeat(43) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "github_authorization_failed");

    const viaToken = await api(pool, { fetchImpl: gh.fetchImpl })("POST", "/v1/github-authorization", BOOTSTRAP, { code: "good-code", codeVerifier: "v".repeat(43) });
    assert.equal(viaToken.body.code, "session_required");

    const gone = await api(pool)("DELETE", "/v1/github-authorization", ALICE_SESSION);
    assert.equal(gone.body.deleted, true);
    assert.equal(await getGithubUserAuthorization(pool, alice), null);
  });
});

test("authorizing as another GitHub account is refused, the token revoked, and nothing stored", { skip }, async () => {
  await withSchema(async ({ pool, alice }) => {
    const gh = oauthFake(MALLORY);
    const res = await api(pool, { fetchImpl: gh.fetchImpl })("POST", "/v1/github-authorization", ALICE_SESSION, { code: "good-code", codeVerifier: "v".repeat(43) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "github_account_mismatch");
    assert.match(res.body.error, /@mallory/);
    assert.ok(gh.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/applications/Iv1.test/token")), "the token handed over is revoked");
    assert.equal(await getGithubUserAuthorization(pool, alice), null);
  });
});

// ---------------------------------------------------------------------------------------------
// The merge step, with the person's token, against a fake GitHub

function personGitHub({ user = ALICE, isDraft = false, afterReady = "CLEAN", files = ["src/a.ts"], head = SHA, initialState, admin = false, rulesetBypass = "never" } = {}) {
  const pr = { id: "PR_1", state: "OPEN", isDraft, headRefOid: head, baseRefName: "main", mergeStateStatus: initialState ?? (isDraft ? "DRAFT" : afterReady), viewerCanMergeAsAdmin: admin };
  const ruleset = { id: 42, name: "main protection", current_user_can_bypass: rulesetBypass };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body && init.headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body ?? null;
    calls.push({ method: init.method, path: u.pathname, host: u.host, body, auth: init.headers.Authorization });
    if (u.host === "github.test" && u.pathname === "/login/oauth/access_token") {
      return json(200, { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (u.host !== "api.github.test") throw new Error(`unscripted host ${u.host}`);
    if (u.pathname === "/user") return json(200, user);
    if (u.pathname === "/graphql") {
      if (body.query.includes("markPullRequestReadyForReview")) {
        pr.isDraft = false;
        pr.mergeStateStatus = afterReady;
        return json(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
      return json(200, { data: { repository: { pullRequest: { ...pr } } } });
    }
    if (u.pathname.endsWith("/files")) return json(200, files.map((filename) => ({ filename })));
    if (u.pathname.endsWith("/rules/branches/main")) return json(200, [{ type: "pull_request", ruleset_id: 42, ruleset_source: "jyothepro/windkeel-fixture" }]);
    if (u.pathname.endsWith("/rulesets/42")) {
      const { current_user_can_bypass, ...rest } = ruleset;
      return json(200, current_user_can_bypass == null ? rest : ruleset);
    }
    if (u.pathname.endsWith("/merge") && init.method === "PUT") {
      if (body.sha !== pr.headRefOid) return json(409, { message: "Head branch was modified. Review and try the merge again." });
      pr.state = "MERGED";
      return json(200, { merged: true, sha: "e".repeat(40), message: "Pull Request successfully merged" });
    }
    return json(404, { message: "Not Found" });
  };
  const mutations = () => calls.filter((c) => c.method === "PUT" || (c.path === "/graphql" && c.body?.query?.includes("mutation")));
  return { fetchImpl, calls, pr, ruleset, mutations };
}

async function pendingMerge(pool, org, alice, { markReady = false, acks = [] } = {}) {
  const { run, verification } = await verifiedRun(pool);
  const { rows } = await pool.query(
    `insert into run_merge (engineering_run_id, organization_id, principal_id, repository_id, pr_number, verified_sha,
       verification_run_id, verdict, verdict_digest, acknowledgements, mark_ready)
     values ($1, $2, $3, $4, 7, $5, $6, 'pass', 'sha256:abc', $7, $8) returning id`,
    [run.id, org, alice, REPO_ID, SHA, verification.id, JSON.stringify(acks), markReady],
  );
  return rows[0].id;
}

const stepDeps = (pool, gh, over = {}) => ({
  pool,
  privateKeys: [PAIR.privateKey],
  enabled: true,
  clientId: "Iv1.test",
  clientSecret: "client-secret-test",
  apiBase: "https://api.github.test",
  fetchImpl: gh.fetchImpl,
  sleep: async () => {},
  ...over,
});
const settled = async (pool, id) => (await pool.query("select status, reason, merged_sha, github_login from run_merge where id = $1", [id])).rows[0];

test("the merge step: marks the draft ready, re-checks, merges the verified SHA with the person's token", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice, { markReady: true });
    const gh = personGitHub({ isDraft: true });
    const outcome = await executeRunMerge(stepDeps(pool, gh), id);
    assert.equal(outcome.status, "merged", outcome.reason);
    const row = await settled(pool, id);
    assert.equal(row.status, "merged");
    assert.equal(row.merged_sha, "e".repeat(40));
    assert.equal(row.github_login, "alice");
    const order = gh.calls.filter((c) => c.host === "api.github.test").map((c) => (c.path === "/graphql" ? (c.body.query.includes("mutation") ? "mark-ready" : "read") : `${c.method} ${c.path.split("/").slice(-2).join("/")}`));
    const reads = ["read", "GET 7/files", "GET branches/main", "GET rulesets/42"];
    assert.deepEqual(order, ["GET /user", ...reads, "mark-ready", ...reads, "PUT 7/merge"]);
    assert.equal(gh.calls.find((c) => c.method === "PUT").body.sha, SHA);
    assert.ok(gh.calls.filter((c) => c.host === "api.github.test").every((c) => c.auth === `Bearer ${ACCESS}`), "every call is the person's token");
    // #393 8A: `run.merged`, as the person, joined to the passing verification it merged.
    const { rows: merged } = await pool.query("select actor_principal_id, actor_text, detail from audit_event where action = 'run.merged'");
    assert.equal(merged.length, 1);
    assert.equal(merged[0].actor_principal_id, alice);
    assert.equal(merged[0].actor_text, "alice");
    assert.equal(merged[0].detail.verifiedSha, SHA);
    assert.equal(merged[0].detail.mergedSha, "e".repeat(40));
    assert.equal(merged[0].detail.verdict, "pass");
    // A second run of the step for the same row does nothing.
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "skipped");
  });
});

test("the merge step refuses a head that moved: GitHub's sha guard answers 409", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub();
    // Between the read and the merge, someone pushes.
    const original = gh.fetchImpl;
    gh.fetchImpl = async (url, init) => {
      if (url.endsWith("/merge")) gh.pr.headRefOid = OTHER_SHA;
      return original(url, init);
    };
    const outcome = await executeRunMerge(stepDeps(pool, gh), id);
    assert.equal(outcome.status, "refused");
    assert.match((await settled(pool, id)).reason, /commit landed after verification/);
  });
});

test("the merge step refuses a stale head before any mutation", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub({ head: OTHER_SHA });
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "refused");
    assert.match((await settled(pool, id)).reason, /stale/);
    assert.deepEqual(gh.mutations(), []);
  });
});

test("the merge step refuses BLOCKED after marking ready, and an admin who could bypass before marking it ready", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice, { markReady: true });
    const gh = personGitHub({ isDraft: true, afterReady: "BLOCKED" });
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "refused");
    assert.match((await settled(pool, id)).reason, /marked ready, then: GitHub reports BLOCKED/);
    assert.ok(!gh.calls.some((c) => c.method === "PUT"), "no merge call");

    const admin = await pendingMerge(pool, org, alice, { markReady: true });
    const gh2 = personGitHub({ isDraft: true, afterReady: "BLOCKED", admin: true });
    assert.equal((await executeRunMerge(stepDeps(pool, gh2), admin)).status, "refused");
    assert.equal((await settled(pool, admin)).reason, BYPASS_REASON);
    assert.deepEqual(gh2.mutations(), [], "not even marked ready");
  });
});

test("the merge step refuses anyone GitHub reports can bypass, on a CLEAN PR, before any mutation (§5.1, amended)", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    for (const opts of [{ admin: true }, { rulesetBypass: "always" }, { rulesetBypass: "pull_requests_only" }, { rulesetBypass: "exempt" }]) {
      const id = await pendingMerge(pool, org, alice);
      const gh = personGitHub(opts);
      const outcome = await executeRunMerge(stepDeps(pool, gh), id);
      assert.equal(outcome.status, "refused", JSON.stringify(opts));
      assert.equal((await settled(pool, id)).reason, BYPASS_REASON);
      assert.deepEqual(gh.mutations(), [], JSON.stringify(opts));
    }
  });
});

test("the merge step refuses when GitHub doesn't say whether the person can bypass a ruleset, and when the rulesets can't be read", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const silent = await pendingMerge(pool, org, alice);
    const gh = personGitHub({ rulesetBypass: null }); // GitHub omits current_user_can_bypass
    assert.equal((await executeRunMerge(stepDeps(pool, gh), silent)).status, "refused");
    assert.match((await settled(pool, silent)).reason, /didn't say whether you can bypass/);
    assert.deepEqual(gh.mutations(), []);

    const unreadable = await pendingMerge(pool, org, alice);
    const gh2 = personGitHub();
    const original = gh2.fetchImpl;
    gh2.fetchImpl = async (url, init) => (url.includes("/rulesets/") ? json(403, { message: "Resource not accessible" }) : original(url, init));
    assert.equal((await executeRunMerge(stepDeps(pool, gh2), unreadable)).status, "failed");
    assert.match((await settled(pool, unreadable)).reason, /rulesets/);
    assert.deepEqual(gh2.mutations(), []);
  });
});

test("the merge step re-checks bypass after marking a draft ready", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice, { markReady: true });
    const gh = personGitHub({ isDraft: true });
    const original = gh.fetchImpl;
    gh.fetchImpl = async (url, init) => {
      // A bypass actor added to the ruleset between the first read and the one after marking ready.
      if (init.body?.includes?.("markPullRequestReadyForReview")) gh.ruleset.current_user_can_bypass = "always";
      return original(url, init);
    };
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "refused");
    assert.equal((await settled(pool, id)).reason, `marked ready, then: ${BYPASS_REASON}`);
    assert.ok(!gh.calls.some((c) => c.method === "PUT"), "no merge call");
  });
});

test("bypass detected only at merge time: the App's preview can't see it, the merge step refuses, and the card's next preview names it", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const { run } = await verifiedRun(pool);
    const started = [];
    const call = api(pool, { started });
    const rule = (body) => body.rules.find((r) => r.id === "bypass");

    const before = await call("GET", `/v1/runs/${run.id}/merge-eligibility`);
    assert.equal(before.body.eligible, true, JSON.stringify(before.body.failing));
    assert.equal(rule(before.body).checked, false);
    assert.equal(rule(before.body).blocking, false);
    assert.match(rule(before.body).reason, /Checked with your GitHub token when you merge/);

    const accepted = await call("POST", `/v1/runs/${run.id}/merge`, ALICE_SESSION, {});
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    const gh = personGitHub({ admin: true });
    assert.equal((await executeRunMerge(stepDeps(pool, gh), started[0])).status, "refused");
    assert.deepEqual(gh.mutations(), []);

    const after = await call("GET", `/v1/runs/${run.id}/merge-eligibility`);
    assert.equal(after.body.merge.status, "refused");
    assert.equal(after.body.merge.reason, BYPASS_REASON);
    assert.equal(rule(after.body).ok, false);
    assert.equal(rule(after.body).checked, true);
    assert.equal(rule(after.body).reason, BYPASS_REASON);
    // Not blocking: once the repository enforces its protection, merging again is checked afresh.
    assert.equal(after.body.eligible, true);
    // Someone else's preview isn't coloured by alice's bypass.
    const bob = await call("GET", `/v1/runs/${run.id}/merge-eligibility`, BOB_SESSION);
    assert.equal(rule(bob.body).checked, false);
  });
});

test("the merge step refuses a workflow-touching PR before any mutation", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub({ files: [".github/workflows/deploy.yml"] });
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "refused");
    assert.match((await settled(pool, id)).reason, /merge it on GitHub/);
    assert.deepEqual(gh.mutations(), []);
  });
});

test("the merge step refuses a token whose GitHub user is not the person, and asks them to reconnect", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub({ user: MALLORY });
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "refused");
    assert.match((await settled(pool, id)).reason, /@mallory/);
    assert.equal((await getGithubUserAuthorization(pool, alice)).status, "needs_reauth");
    assert.deepEqual(gh.mutations(), []);
  });
});

test("the merge step re-checks the organization setting, the flag and the permission before opening a token", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const gh = personGitHub();
    const off = await pendingMerge(pool, org, alice);
    await pool.query("update organization set allow_merge = false where id = $1", [org]);
    assert.equal((await executeRunMerge(stepDeps(pool, gh), off)).status, "refused");
    assert.match((await settled(pool, off)).reason, /off for this organization/);
    await pool.query("update organization set allow_merge = true where id = $1", [org]);

    const flag = await pendingMerge(pool, org, alice);
    assert.equal((await executeRunMerge(stepDeps(pool, gh, { enabled: false }), flag)).status, "refused");

    const demoted = await pendingMerge(pool, org, alice);
    await pool.query(
      `update membership set access_role_id = (select id from access_role where key = 'member' and account_id is null)
        where principal_id = $1`,
      [alice],
    );
    assert.equal((await executeRunMerge(stepDeps(pool, gh), demoted)).status, "refused");
    assert.match((await settled(pool, demoted)).reason, /runs.merge/);
    assert.equal(gh.calls.length, 0, "no GitHub call when Postgres already says no");
  });
});

test("the merge step refreshes an expiring token first, then merges with the new one", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await pool.query("update organization set allow_merge = true where id = $1", [org]);
    await putGithubUserAuthorization(pool, { principalId: alice, githubUserId: ALICE.id, githubLogin: ALICE.login, tokens: tokens({ expiresIn: 30 }), publicKey: PAIR.publicKey });
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub();
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "merged");
    const refresh = gh.calls.find((c) => c.host === "github.test"); // the web host for the API base, not github.com
    assert.equal(new URLSearchParams(refresh.body).get("refresh_token"), REFRESH);
    assert.equal(gh.calls.find((c) => c.method === "PUT").auth, `Bearer ${NEW_ACCESS}`);
    const reason = JSON.stringify(await settled(pool, id));
    assert.ok(![ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH].some((t) => reason.includes(t)));
  });
});

// ---------------------------------------------------------------------------------------------
// The sweep for merges whose step died

test("the sweep settles a merge still pending after 15 minutes as failed, with a reason; fresh and settled rows are left alone", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const ageBy = (id, ms) => pool.query("update run_merge set created_at = now() - ($2::bigint * interval '1 millisecond') where id = $1", [id, String(ms)]);
    const stale = await pendingMerge(pool, org, alice);
    await ageBy(stale, DEFAULT_STALE_MERGE_AGE_MS + 60_000);
    const fresh = await pendingMerge(pool, org, alice);
    await ageBy(fresh, DEFAULT_STALE_MERGE_AGE_MS - 60_000);
    const merged = await pendingMerge(pool, org, alice);
    await pool.query("update run_merge set status = 'merged', completed_at = now() where id = $1", [merged]);
    await ageBy(merged, DEFAULT_STALE_MERGE_AGE_MS + 60_000);

    const logged = [];
    const outcome = await settleStaleMergesLocked({ pool, log: (msg, fields) => logged.push({ msg, fields }) });
    assert.equal(outcome.kind, "ran");
    assert.deepEqual(outcome.result.settled, [stale]);
    const row = (await pool.query("select status, reason, completed_at from run_merge where id = $1", [stale])).rows[0];
    assert.equal(row.status, "failed");
    assert.equal(row.reason, STALE_MERGE_REASON);
    assert.match(row.reason, /Check the pull request on GitHub/);
    assert.ok(row.completed_at);
    assert.equal((await settled(pool, fresh)).status, "pending");
    assert.equal((await settled(pool, merged)).status, "merged");
    assert.equal(logged.length, 1);
    assert.deepEqual(Object.keys(logged[0].fields).sort(), ["engineeringRunId", "runMergeId"]);

    // Idempotent; and the merge step arriving late finds the row settled and does nothing.
    assert.deepEqual((await settleStaleMerges({ pool })).settled, []);
    const gh = personGitHub();
    assert.equal((await executeRunMerge(stepDeps(pool, gh), stale)).status, "skipped");
    assert.equal(gh.calls.length, 0);

    // The console's next look shows the failure, and a new merge of the run can be asked for.
    const runId = (await pool.query("select engineering_run_id from run_merge where id = $1", [stale])).rows[0].engineering_run_id;
    await pool.query("delete from run_merge where id <> $1", [stale]);
    const started = [];
    const eligibility = await api(pool, { started })("GET", `/v1/runs/${runId}/merge-eligibility`);
    assert.equal(eligibility.body.merge.status, "failed");
    assert.equal(eligibility.body.merge.reason, STALE_MERGE_REASON);
    const again = await api(pool, { started })("POST", `/v1/runs/${runId}/merge`, ALICE_SESSION, {});
    assert.equal(again.status, 202, JSON.stringify(again.body));
  });
});

test("the sweep's bound is configurable and says so in the reason", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    const id = await pendingMerge(pool, org, alice);
    await pool.query("update run_merge set created_at = now() - interval '6 minutes' where id = $1", [id]);
    assert.deepEqual((await settleStaleMerges({ pool, maximumAgeMs: 5 * 60_000 })).settled, [id]);
    assert.match((await settled(pool, id)).reason, /after 5 minutes/);
  });
});

test("the sweep leaves a pending merge whose step is still heartbeating alone, however old the row", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    const id = await pendingMerge(pool, org, alice);
    await pool.query("update run_merge set created_at = now() - interval '40 minutes', heartbeat_at = now() - interval '1 minute' where id = $1", [id]);
    assert.deepEqual((await settleStaleMerges({ pool })).settled, []);
    await pool.query("update run_merge set heartbeat_at = now() - interval '16 minutes' where id = $1", [id]);
    assert.deepEqual((await settleStaleMerges({ pool })).settled, [id]);
  });
});

test("a step whose row the sweep settled mid-flight stops before it merges", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub();
    const original = gh.fetchImpl;
    let swept = null;
    gh.fetchImpl = async (url, init) => {
      if (url.includes("/rulesets/") && swept === null) {
        // The step stalls here long enough for its heartbeat to go stale, and the sweep runs.
        await pool.query("update run_merge set heartbeat_at = now() - interval '20 minutes' where id = $1", [id]);
        swept = (await settleStaleMerges({ pool })).settled;
      }
      return original(url, init);
    };
    const outcome = await executeRunMerge(stepDeps(pool, gh), id);
    assert.deepEqual(swept, [id]);
    assert.equal(outcome.status, "skipped");
    assert.match(outcome.reason, /nothing was changed on GitHub/);
    assert.deepEqual(gh.mutations(), [], "no merge after the sweep settled the row");
    const row = await settled(pool, id);
    assert.equal(row.status, "failed");
    assert.equal(row.reason, STALE_MERGE_REASON);
  });
});

test("a retry after GitHub accepted the merge but before it was recorded settles merged, not refused", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub();
    // The first delivery stamps merge_sent_at, GitHub merges, and the step dies before settling.
    const original = gh.fetchImpl;
    gh.fetchImpl = async (url, init) => {
      const res = await original(url, init);
      if (url.endsWith("/merge") && init.method === "PUT") {
        Object.assign(gh.pr, { mergedBy: { login: "alice" }, mergeCommit: { oid: "e".repeat(40) } });
        throw new Error("function killed");
      }
      return res;
    };
    const first = await executeRunMerge(stepDeps(pool, gh), id);
    // The catch-all settles it failed; put it back to pending to model a crash that never reached it.
    assert.equal(first.status, "failed");
    await pool.query("update run_merge set status = 'pending', reason = null, completed_at = null where id = $1", [id]);
    assert.ok((await pool.query("select merge_sent_at from run_merge where id = $1", [id])).rows[0].merge_sent_at);

    gh.fetchImpl = original;
    const puts = gh.calls.filter((c) => c.method === "PUT").length;
    const retry = await executeRunMerge(stepDeps(pool, gh), id);
    assert.equal(retry.status, "merged", retry.reason);
    const row = await settled(pool, id);
    assert.equal(row.merged_sha, "e".repeat(40));
    assert.equal(row.github_login, "alice");
    assert.equal(gh.calls.filter((c) => c.method === "PUT").length, puts, "no second merge call");
  });
});

test("a PR merged on GitHub without this attempt having sent its merge is refused, not claimed", { skip }, async () => {
  await withSchema(async ({ pool, org, alice }) => {
    await allowAndConnect(pool, org, alice);
    const id = await pendingMerge(pool, org, alice);
    const gh = personGitHub();
    Object.assign(gh.pr, { state: "MERGED", mergedBy: { login: "alice" }, mergeCommit: { oid: "e".repeat(40) } });
    assert.equal((await executeRunMerge(stepDeps(pool, gh), id)).status, "refused");
    assert.match((await settled(pool, id)).reason, /PR is merged/);
  });
});
