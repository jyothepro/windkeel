/**
 * ADR-0038 §3: linking an installation needs *ownership* of the account it is installed on, not
 * mere reach. Against a fake GitHub API: a collaborator who can only see the installation is
 * refused, a user-account owner and an organization admin are accepted, and an organization member
 * who is not an admin is refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { githubInstallationVerifier } from "../dist/github/installation-verifier.js";

const ADA = { id: 1001, login: "ada" };
const BOB = { id: 1002, login: "bob" };

/**
 * A fake GitHub: `code` → the user it authorizes; each user's visible installations; org
 * memberships keyed `org:login`.
 */
function fakeGitHub({ users, installations, memberships }) {
  const calls = [];
  const tokens = new Map(Object.entries(users).map(([code, user]) => [`tok_${code}`, user]));
  const respond = (status, body) => ({ status, json: async () => body });
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const u = new URL(url);
    if (u.pathname === "/login/oauth/access_token") {
      const { code } = JSON.parse(init.body);
      return users[code] ? respond(200, { access_token: `tok_${code}` }) : respond(200, { error: "bad_verification_code" });
    }
    const user = tokens.get((init.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!user) return respond(401, { message: "Bad credentials" });
    if (u.pathname === "/user") return respond(200, user);
    if (u.pathname === "/user/installations") return respond(200, { installations: installations[user.login] ?? [] });
    const m = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const membership = memberships[`${decodeURIComponent(m[1])}:${user.login}`];
      return membership ? respond(200, membership) : respond(404, { message: "Not Found" });
    }
    return respond(404, { message: "Not Found" });
  };
  return { fetchImpl, calls };
}

const verifierFor = (gh) =>
  githubInstallationVerifier({ clientId: "Iv1.x", clientSecret: "s", webBase: "https://gh.test", apiBase: "https://api.gh.test", fetchImpl: gh.fetchImpl });

const acmeOrgInstall = { id: 500, account: { id: 9000, login: "acme", type: "Organization" } };
const adaUserInstall = { id: 600, account: { id: ADA.id, login: "ada", type: "User" } };

test("a collaborator who can only see someone else's user-account installation is refused", async () => {
  // Bob collaborates on one of Ada's repositories, so GitHub lists Ada's installation for him.
  const gh = fakeGitHub({ users: { "code-bob": BOB }, installations: { bob: [adaUserInstall] }, memberships: {} });
  const verdict = await verifierFor(gh).verify({ installationId: 600, code: "code-bob" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not_owner");
});

test("a collaborator on a repository of an organization's installation, not a member, is refused", async () => {
  const gh = fakeGitHub({ users: { "code-bob": BOB }, installations: { bob: [acmeOrgInstall] }, memberships: {} });
  const verdict = await verifierFor(gh).verify({ installationId: 500, code: "code-bob" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not_owner");
  assert.ok(gh.calls.includes("GET https://api.gh.test/user/memberships/orgs/acme"), "asked GitHub about the membership");
});

test("the user who owns the account the App is installed on is accepted", async () => {
  const gh = fakeGitHub({ users: { "code-ada": ADA }, installations: { ada: [adaUserInstall] }, memberships: {} });
  assert.deepEqual(await verifierFor(gh).verify({ installationId: 600, code: "code-ada" }), { ok: true });
});

test("an active admin of the installation's organization is accepted", async () => {
  const gh = fakeGitHub({
    users: { "code-ada": ADA },
    installations: { ada: [acmeOrgInstall] },
    memberships: { "acme:ada": { state: "active", role: "admin" } },
  });
  assert.deepEqual(await verifierFor(gh).verify({ installationId: 500, code: "code-ada" }), { ok: true });
});

test("an organization member who is not an admin, or whose admin invite is pending, is refused", async () => {
  const gh = fakeGitHub({
    users: { "code-bob": BOB, "code-ada": ADA },
    installations: { bob: [acmeOrgInstall], ada: [acmeOrgInstall] },
    memberships: { "acme:bob": { state: "active", role: "member" }, "acme:ada": { state: "pending", role: "admin" } },
  });
  const member = await verifierFor(gh).verify({ installationId: 500, code: "code-bob" });
  assert.equal(member.ok, false);
  assert.equal(member.reason, "not_owner");
  const pending = await verifierFor(gh).verify({ installationId: 500, code: "code-ada" });
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, "not_owner");
});

test("no code, a refused code, or an installation not listed at all is unreachable", async () => {
  const gh = fakeGitHub({ users: { "code-ada": ADA }, installations: { ada: [adaUserInstall] }, memberships: {} });
  const v = verifierFor(gh);
  assert.equal((await v.verify({ installationId: 600, code: undefined })).reason, "unreachable");
  assert.equal((await v.verify({ installationId: 600, code: "code-forged" })).reason, "unreachable");
  assert.equal((await v.verify({ installationId: 777, code: "code-ada" })).reason, "unreachable");
});
