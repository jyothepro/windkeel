import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError, WindkeelApi, effectivePermissions, scopePath } from "../packages/cli/dist/client/api.js";
import {
  MissingApiConfigError,
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "../packages/cli/dist/client/credentials.js";
import {
  loginCommand,
  loginWithTokenCommand,
  logoutCommand,
  memberCommand,
  orgUseCommand,
  parseScope,
  pollForDeviceToken,
  tokenCreateCommand,
} from "../packages/cli/dist/commands/auth.js";
import { whoamiCommand } from "../packages/cli/dist/commands/remote.js";
import { servicePrincipalCommand } from "../packages/cli/dist/commands/service-principal.js";
import { handleMcpMessage, toolsForCredential } from "../packages/cli/dist/mcp/server.js";
import { TOOLS } from "../packages/cli/dist/mcp/tools.js";

/**
 * The ADR-0024 half of the CLI, against a fake API.
 *
 * A fake rather than the real router, unlike `cli-remote.test.js`, because the API side of ADR-0024
 * is being built in parallel: these tests pin the CLI to the *contract* — paths, bodies, error codes —
 * so that when the two meet, a disagreement shows up as a failing assertion about a named field
 * rather than as a login that hangs.
 */

const URL_A = "https://factory.test";

/** A fresh config directory per test, so nothing here can read or clobber a real login. */
function sandboxEnv(extra = {}) {
  return { WINDKEEL_CONFIG_DIR: join(mkdtempSync(join(tmpdir(), "windkeel-cli-auth-")), "windkeel"), ...extra };
}

/**
 * A fetch that routes `METHOD /path` to a handler, and records every call.
 *
 * A handler returns `[status, body]`, or a body for 200.
 */
function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = {
      method: init.method ?? "GET",
      path: parsed.pathname,
      authorization: init.headers?.authorization,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response(JSON.stringify({ error: "no route", code: "not_found" }), { status: 404 });
    const result = await handler(call);
    const [status, body] = Array.isArray(result) ? result : [200, result];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

function collect() {
  const lines = [];
  return { lines, text: () => lines.join("\n"), io: { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) } };
}

const ORG_A = { id: "org-a", name: "acme", role: "admin", permissions: ["runs.read", "runs.write", "runs.approve", "secrets.manage", "repositories.manage", "members.manage", "tokens.manage"] };
const ORG_B = { id: "org-b", name: "globex", role: "viewer", permissions: ["runs.read"] };

function selfFor({ token = { id: "tok-1", name: "laptop", permissions: ["runs.read", "runs.write"], organizationId: null }, organizations = [ORG_A] } = {}) {
  return {
    principal: { id: "p-1", kind: "user", displayName: "Ada", githubLogin: "ada" },
    account: { id: "acct-1", name: "Ada's account" },
    organizations,
    token,
    subject: "user:ada",
    scopes: [],
  };
}

const TOKEN_VIEW = {
  id: "tok-new",
  name: "ada-laptop",
  prefix: "orq_abcd1234",
  organizationId: null,
  permissions: ["runs.read", "runs.write"],
  ownerPrincipalId: "p-1",
  createdBy: "p-1",
  createdAt: "2026-09-24T00:00:00Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

// --- credential resolution -------------------------------------------------

test("the environment's token wins over the stored login, and does not inherit its org", async () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_from_file", org: "org-a" }, env);
  const empty = () => ({ items: [], endCursor: null, hasNextPage: false });
  const { fetch, calls } = fakeApi({ "GET /v1/runs": empty, "GET /v1/orgs/org-a/runs": empty });

  const fromEnv = WindkeelApi.fromEnv({ ...env, WINDKEEL_API_TOKEN: "orq_from_env" }, { fetch });
  assert.equal(fromEnv.tokenSource, "env");
  await fromEnv.listRuns();
  assert.equal(calls[0].authorization, "Bearer orq_from_env", "CI and agents configure by env, and it must win");
  assert.equal(calls[0].path, "/v1/runs", "the file's org belongs to the file's credential, not to an env token");

  const fromFile = WindkeelApi.fromEnv(env, { fetch });
  assert.equal(fromFile.tokenSource, "file");
  await fromFile.listRuns();
  assert.equal(calls[1].authorization, "Bearer orq_from_file");
  assert.equal(calls[1].path, "/v1/orgs/org-a/runs");
});

test("WINDKEEL_ORG beats the file's org, and --org beats both", () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_file", org: "org-a" }, env);
  assert.equal(WindkeelApi.fromEnv(env).org, "org-a");
  assert.equal(WindkeelApi.fromEnv({ ...env, WINDKEEL_ORG: "org-b" }).org, "org-b");
  assert.equal(WindkeelApi.fromEnv({ ...env, WINDKEEL_ORG: "org-b" }, { org: "org-c" }).org, "org-c");
});

test("a stored token is never sent to a URL other than the one that issued it", () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_prod" }, env);
  assert.throws(
    () => WindkeelApi.fromEnv({ ...env, WINDKEEL_API_URL: "https://staging.test" }),
    (err) => err instanceof MissingApiConfigError && /issued by https:\/\/factory\.test/.test(err.message),
  );
  // A trailing slash is the same deployment.
  assert.ok(WindkeelApi.fromEnv({ ...env, WINDKEEL_API_URL: `${URL_A}/` }));
});

test("with no login and no variables, the error says to run windkeel login", () => {
  assert.throws(
    () => WindkeelApi.fromEnv(sandboxEnv()),
    (err) => err instanceof MissingApiConfigError && /windkeel login/.test(err.message),
  );
});

test("the credentials file is 0600 in a 0700 directory", () => {
  const env = sandboxEnv();
  const path = writeCredentials({ apiUrl: URL_A, token: "orq_secret" }, env);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  // Rewriting keeps the mode: `org use` rewrites the file, and must not widen it.
  writeCredentials({ apiUrl: URL_A, token: "orq_secret", org: "org-a" }, env);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readCredentials(env), { apiUrl: URL_A, token: "orq_secret", org: "org-a" });
});

test("XDG_CONFIG_HOME is respected when WINDKEEL_CONFIG_DIR is not set", () => {
  const xdg = mkdtempSync(join(tmpdir(), "windkeel-xdg-"));
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: xdg }), join(xdg, "windkeel", "credentials.json"));
});

// --- org scoping -----------------------------------------------------------

test("org-scoped routes gain /v1/orgs/{org}; self, tokens, auth and health do not", async () => {
  assert.equal(scopePath("/v1/runs/r1/events", "org-a"), "/v1/orgs/org-a/runs/r1/events");
  assert.equal(scopePath("/v1/repositories", "org-a"), "/v1/orgs/org-a/repositories");
  assert.equal(scopePath("/v1/queue", "org-a"), "/v1/orgs/org-a/queue");
  assert.equal(scopePath("/v1/runs", undefined), "/v1/runs");
  for (const path of ["/v1/self", "/v1/tokens", "/v1/tokens/t/revoke", "/v1/auth/device", "/v1/health"]) {
    assert.equal(scopePath(path, "org-a"), path, `${path} is about the caller, not an organization`);
  }
  // No accidental prefix match: `/v1/runsomething` is not `/v1/runs`.
  assert.equal(scopePath("/v1/runsomething", "org-a"), "/v1/runsomething");

  const { fetch, calls } = fakeApi({
    "POST /v1/orgs/org-a/runs/r1/cancel": () => ({ accepted: true }),
    "GET /v1/self": () => selfFor(),
  });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", org: "org-a", fetch });
  await api.cancel("r1");
  await api.self();
  assert.deepEqual(calls.map((c) => c.path), ["/v1/orgs/org-a/runs/r1/cancel", "/v1/self"]);
});

test("organization_required and a missing permission each print the fix", async () => {
  const { fetch } = fakeApi({
    "GET /v1/runs": () => [400, { error: "which organization?", code: "organization_required", organizations: [{ id: "org-a", name: "acme" }, { id: "org-b", name: "globex" }] }],
    "POST /v1/runs/r1/cancel": () => [403, { error: "forbidden", code: "forbidden", missing: "runs.write" }],
  });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  const { cancelCommand } = await import("../packages/cli/dist/commands/remote.js");
  const out = collect();
  assert.equal(await cancelCommand(api, out.io, "r1"), 1);
  assert.match(out.text(), /this token lacks runs\.write; create one with `windkeel token create --name <name> --scope execute`/);

  await assert.rejects(api.listRuns(), (err) => err instanceof ApiError && err.code === "organization_required" && Array.isArray(err.body.organizations));
});

// --- login --with-token ----------------------------------------------------

test("--with-token refuses a token the server rejects, and writes nothing", async () => {
  const env = sandboxEnv();
  const { fetch } = fakeApi({ "GET /v1/self": () => [401, { error: "unknown token", code: "unauthenticated" }] });
  const out = collect();
  const code = await loginWithTokenCommand(out.io, { url: URL_A }, { env, fetch, stdinIsTty: false, readStdin: async () => "orq_bogus\n" });
  assert.equal(code, 1);
  assert.match(out.text(), /did not accept that token/);
  assert.equal(existsSync(credentialsPath(env)), false, "a rejected token must never be stored");
});

test("--with-token stores a token the server accepts, trimmed, and says who it is", async () => {
  const env = sandboxEnv();
  const { fetch, calls } = fakeApi({ "GET /v1/self": () => selfFor() });
  const out = collect();
  const code = await loginWithTokenCommand(out.io, { url: URL_A }, { env, fetch, stdinIsTty: false, readStdin: async () => "orq_good\n" });
  assert.equal(code, 0);
  assert.equal(calls[0].authorization, "Bearer orq_good");
  assert.deepEqual(readCredentials(env), { apiUrl: URL_A, token: "orq_good" });
  assert.equal(statSync(credentialsPath(env)).mode & 0o777, 0o600);
  assert.match(out.text(), /@ada/);
});

test("--with-token refuses to read a token from a terminal", async () => {
  const out = collect();
  assert.equal(await loginWithTokenCommand(out.io, { url: URL_A }, { env: sandboxEnv(), stdinIsTty: true }), 2);
  assert.match(out.text(), /--with-token < token\.txt/);
});

test("replacing a stored login says whose, and that the old token still works", async () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_oldoldold1234" }, env);
  const { fetch } = fakeApi({
    "GET /v1/self": (call) =>
      call.authorization === "Bearer orq_oldoldold1234"
        ? selfFor({ token: { id: "tok-old", name: "old-laptop", permissions: ["runs.read"], organizationId: null } })
        : selfFor(),
  });
  const out = collect();
  await loginWithTokenCommand(out.io, { url: URL_A }, { env, fetch, stdinIsTty: false, readStdin: async () => "orq_new" });
  const text = out.text();
  assert.match(text, /Replacing the stored login for @ada/);
  assert.match(text, /old-laptop/);
  assert.match(text, /orq_oldoldol…/, "the prefix identifies the token without leaking it");
  assert.doesNotMatch(text, /orq_oldoldold1234/);
  assert.match(text, /windkeel token revoke tok-old/);
});

// --- the device flow -------------------------------------------------------

function devicePoller(answers) {
  let index = 0;
  return () => {
    const answer = answers[Math.min(index++, answers.length - 1)];
    return typeof answer === "string" ? [400, { error: answer, code: answer }] : answer;
  };
}

const DEVICE = {
  deviceCode: "dev-123",
  userCode: "WDJB-MJHT",
  verificationUri: `${URL_A}/device`,
  verificationUriComplete: `${URL_A}/device?code=WDJB-MJHT`,
  interval: 5,
  expiresIn: 900,
};

test("the poll loop waits, honours slow_down for good, and returns the approved token", async () => {
  const { fetch, calls } = fakeApi({
    "POST /v1/auth/device/token": devicePoller(["authorization_pending", "slow_down", "authorization_pending", { token: TOKEN_VIEW, secret: "orq_minted" }]),
  });
  const slept = [];
  const api = new WindkeelApi({ baseUrl: URL_A, token: "", fetch });
  const outcome = await pollForDeviceToken(api, DEVICE, { sleep: async (ms) => slept.push(ms), now: () => 0 });

  assert.equal(outcome.status, "approved");
  assert.equal(outcome.created.secret, "orq_minted");
  // RFC 8628 §3.5: slow_down adds 5s to every poll after it, not just the next one.
  assert.deepEqual(slept, [5000, 5000, 10000, 10000]);
  assert.equal(calls[0].authorization, undefined, "the device endpoints are public; there is no bearer to send");
  assert.deepEqual(calls[0].body, { deviceCode: "dev-123" });
});

test("expired_token and access_denied end the loop; so does the code's own deadline", async () => {
  const run = async (answers, now = () => 0) => {
    const { fetch } = fakeApi({ "POST /v1/auth/device/token": devicePoller(answers) });
    return pollForDeviceToken(new WindkeelApi({ baseUrl: URL_A, token: "", fetch }), DEVICE, { sleep: async () => {}, now });
  };
  assert.equal((await run(["authorization_pending", "expired_token"])).status, "expired");
  assert.equal((await run(["access_denied"])).status, "denied");

  // A server that never answers anything but pending is not polled for ever.
  let clock = 0;
  const outcome = await run(["authorization_pending"], () => (clock += 60_000));
  assert.equal(outcome.status, "expired");
});

test("windkeel login asks for the scope, shows the code, and saves what comes back", async () => {
  const env = sandboxEnv();
  const { fetch, calls } = fakeApi({
    "POST /v1/auth/device": () => DEVICE,
    "POST /v1/auth/device/token": devicePoller(["authorization_pending", { token: TOKEN_VIEW, secret: "orq_minted" }]),
    "GET /v1/self": () => selfFor(),
  });
  const opened = [];
  const out = collect();
  const code = await loginCommand(
    out.io,
    { url: URL_A, scope: "read" },
    { env, fetch, sleep: async () => {}, now: () => 0, machineName: "ada-mbp", openBrowser: (u) => opened.push(u) > 0 },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls[0].body, { machineName: "ada-mbp", preset: "read" });
  assert.match(out.text(), /WDJB-MJHT/);
  assert.deepEqual(opened, [DEVICE.verificationUriComplete]);
  assert.deepEqual(readCredentials(env), { apiUrl: URL_A, token: "orq_minted" });
  assert.match(out.text(), /principal Ada \(@ada\)/);
});

test("--admin asks for the admin preset, and --no-browser opens nothing", async () => {
  const { fetch, calls } = fakeApi({
    "POST /v1/auth/device": () => DEVICE,
    "POST /v1/auth/device/token": () => [400, { code: "expired_token" }],
  });
  let opened = false;
  const out = collect();
  const code = await loginCommand(out.io, { url: URL_A, admin: true, noBrowser: true }, {
    env: sandboxEnv(), fetch, sleep: async () => {}, now: () => 0, machineName: "m", openBrowser: () => (opened = true),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls[0].body, { machineName: "m", preset: "admin", admin: true });
  assert.equal(opened, false);
  assert.match(out.text(), /expired/);
});

test("a deployment with no console says to use --with-token", async () => {
  const { fetch } = fakeApi({ "POST /v1/auth/device": () => [503, { error: "no console", code: "console_unconfigured" }] });
  const out = collect();
  assert.equal(await loginCommand(out.io, { url: URL_A }, { env: sandboxEnv(), fetch, openBrowser: () => true }), 1);
  assert.match(out.text(), /no console to approve a login in; use `windkeel login --with-token`/);
});

test("scope flags are checked before anything is sent", () => {
  assert.deepEqual(parseScope({}), { preset: "execute" }, "execute is the default a login asks for");
  assert.deepEqual(parseScope({ permissions: "runs.read, runs.approve" }), { permissions: ["runs.read", "runs.approve"] });
  assert.match(parseScope({ permissions: "runs.wirte" }), /not a permission: runs\.wirte/);
  assert.match(parseScope({ scope: "root" }), /--scope must be one of/);
  assert.match(parseScope({ scope: "read", admin: true }), /choose one/);
});

test("windkeel auth accepts every permission the server defines, including takeover, merge, knowledge and billing", () => {
  for (const permission of ["runs.takeover", "runs.merge", "knowledge.manage", "billing.manage"]) {
    assert.deepEqual(parseScope({ permissions: permission }), { permissions: [permission] });
  }
});

// --- logout ----------------------------------------------------------------

test("logout revokes the token on the server before deleting the file", async () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_live" }, env);
  const order = [];
  const { fetch } = fakeApi({
    "GET /v1/self": () => selfFor({ token: { id: "tok-1", name: "laptop", permissions: [], organizationId: null } }),
    "POST /v1/tokens/tok-1/revoke": () => {
      order.push(`revoke while file exists: ${existsSync(credentialsPath(env))}`);
      return { token: { ...TOKEN_VIEW, id: "tok-1", revokedAt: "now" } };
    },
  });
  const out = collect();
  assert.equal(await logoutCommand(out.io, { env, fetch }), 0);
  assert.deepEqual(order, ["revoke while file exists: true"]);
  assert.equal(existsSync(credentialsPath(env)), false);
  assert.match(out.text(), /Revoked token "laptop"/);
});

test("when revoking fails, logout still deletes the file and says the token is live", async () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_stilllive99" }, env);
  const { fetch } = fakeApi({
    "GET /v1/self": () => selfFor(),
    "POST /v1/tokens/tok-1/revoke": () => [500, { error: "database down", code: "internal" }],
  });
  const out = collect();
  assert.equal(await logoutCommand(out.io, { env, fetch }), 1);
  assert.equal(existsSync(credentialsPath(env)), false);
  const text = out.text();
  assert.match(text, /NOT revoked/);
  assert.match(text, /still live/);
  assert.match(text, /begins orq_stillliv…/);
  assert.doesNotMatch(text, /orq_stilllive99/, "enough to recognise the token, not enough to use it");
  assert.match(text, /tok-1/);
});

// --- tokens, orgs, members -------------------------------------------------

test("token create prints the secret once and says it will not be shown again", async () => {
  const { fetch, calls } = fakeApi({ "POST /v1/tokens": () => [201, { token: { ...TOKEN_VIEW, name: "claude-code", permissions: ["runs.read"] }, secret: "orq_agent" }] });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  const out = collect();
  assert.equal(await tokenCreateCommand(api, out.io, { name: "claude-code", scope: "read", expiresInDays: "30" }), 0);
  assert.deepEqual(calls[0].body, { name: "claude-code", preset: "read", expiresInDays: 30 });
  assert.equal(out.lines.filter((l) => l.includes("orq_agent")).length, 1);
  assert.ok(out.lines.includes("orq_agent"), "the secret sits on a line of its own");
  assert.match(out.text(), /will not be shown again/);
});

test("org use checks membership, stores the id, and refuses when the token is from the environment", async () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_file" }, env);
  const { fetch } = fakeApi({ "GET /v1/self": () => selfFor({ organizations: [ORG_A, ORG_B] }) });

  const fileApi = WindkeelApi.fromEnv(env, { fetch });
  const ok = collect();
  assert.equal(await orgUseCommand(fileApi, ok.io, "globex", { env }), 0);
  assert.equal(readCredentials(env).org, "org-b", "a name is accepted, the id is stored");

  const bad = collect();
  assert.equal(await orgUseCommand(fileApi, bad.io, "initech", { env }), 1);
  assert.match(bad.text(), /not a member of initech/);

  const envApi = WindkeelApi.fromEnv({ ...env, WINDKEEL_API_TOKEN: "orq_env" }, { fetch });
  const refused = collect();
  assert.equal(await orgUseCommand(envApi, refused.io, "org-a", { env }), 1);
  assert.match(refused.text(), /WINDKEEL_ORG=org-a/);
});

test("member invite uses the only org, defaults to member, and says how to accept", async () => {
  const { fetch, calls } = fakeApi({
    "GET /v1/self": () => selfFor(),
    "POST /v1/orgs/org-a/invitations": () => [201, { githubLogin: "grace", role: "member" }],
  });
  const out = collect();
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  assert.equal(await memberCommand(api, out.io, { kind: "invite", githubLogin: "@grace" }), 0);
  assert.deepEqual(calls.at(-1).body, { githubLogin: "grace", role: "member" });
  assert.match(out.text(), /signing in to the console with that GitHub account/);
});

test("member commands refuse to guess among several organizations", async () => {
  const { fetch, calls } = fakeApi({ "GET /v1/self": () => selfFor({ organizations: [ORG_A, ORG_B] }) });
  const out = collect();
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  assert.equal(await memberCommand(api, out.io, { kind: "invite", githubLogin: "grace" }), 2);
  assert.match(out.text(), /org-a \(acme\), org-b \(globex\)/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nobody is invited anywhere");
});

test("member role, remove and an unknown GitHub login", async () => {
  const { fetch, calls } = fakeApi({
    "POST /v1/orgs/org-b/members/p-9/role": () => ({ principalId: "p-9", role: "viewer" }),
    "POST /v1/orgs/org-b/members/p-9/delete": () => ({ removed: "p-9" }),
    "POST /v1/orgs/org-b/invitations": () => [404, { error: "no such user", code: "github_user_not_found" }],
  });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", org: "org-b", fetch });
  assert.equal(await memberCommand(api, collect().io, { kind: "role", principalId: "p-9", role: "viewer" }), 0);
  assert.deepEqual(calls.at(-1).body, { role: "viewer" });
  assert.equal(await memberCommand(api, collect().io, { kind: "remove", principalId: "p-9" }), 0);
  assert.equal(await memberCommand(api, collect().io, { kind: "role", principalId: "p-9", role: "owner" }), 2);
  await assert.rejects(
    memberCommand(api, collect().io, { kind: "invite", githubLogin: "nobody" }),
    (err) => err instanceof ApiError && err.code === "github_user_not_found",
  );
});

// --- service principals (M8-2) ------------------------------------------------

test("service-principal commands hit the organization's routes, and the secret is printed once", async () => {
  const SP = { id: "sp-1", organizationId: "org-b", displayName: "Slack intake", role: "member", permissions: ["runs.read", "runs.write", "runs.approve"], system: false, systemPurpose: null, createdAt: "2026-09-25T00:00:00Z", deactivatedAt: null };
  const { fetch, calls } = fakeApi({
    "GET /v1/orgs/org-b/service-principals": () => ({ items: [SP], endCursor: null, hasNextPage: false }),
    "POST /v1/orgs/org-b/service-principals": () => [201, { servicePrincipal: SP }],
    "POST /v1/orgs/org-b/service-principals/sp-1/delete": () => ({ deleted: "sp-1", servicePrincipal: SP }),
    "POST /v1/orgs/org-b/service-principals/sp-1/tokens": () => [
      201,
      { token: { ...TOKEN_VIEW, ownerPrincipalId: "sp-1", organizationId: "org-b" }, secret: "orq_servicesecret" },
    ],
    "GET /v1/orgs/org-b/service-principals/sp-1/tokens": () => ({ items: [TOKEN_VIEW] }),
    "POST /v1/orgs/org-b/service-principals/sp-1/tokens/tok-new/revoke": () => ({ token: TOKEN_VIEW }),
  });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", org: "org-b", fetch });

  const listed = collect();
  assert.equal(await servicePrincipalCommand(api, listed.io, { kind: "list" }), 0);
  assert.match(listed.text(), /sp-1 +member +service +Slack intake/);

  assert.equal(await servicePrincipalCommand(api, collect().io, { kind: "create", name: "Slack intake", role: "member" }), 0);
  assert.deepEqual(calls.at(-1).body, { name: "Slack intake", role: "member" });
  assert.equal(await servicePrincipalCommand(api, collect().io, { kind: "create" }), 2, "a name is required");
  assert.equal(await servicePrincipalCommand(api, collect().io, { kind: "create", name: "x", role: "owner" }), 2);

  const minted = collect();
  assert.equal(
    await servicePrincipalCommand(api, minted.io, {
      kind: "token-create",
      principalId: "sp-1",
      name: "slack",
      scope: "execute",
      expiresAt: "2027-01-01T00:00:00Z",
    }),
    0,
  );
  assert.deepEqual(calls.at(-1).body, { name: "slack", preset: "execute", expiresAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(minted.lines.filter((l) => l.includes("orq_servicesecret")).length, 1, "the secret appears exactly once");

  // No scope given: the server picks the default, so none is sent.
  await servicePrincipalCommand(api, collect().io, { kind: "token-create", principalId: "sp-1", name: "plain" });
  assert.deepEqual(calls.at(-1).body, { name: "plain" });

  const tokens = collect();
  assert.equal(await servicePrincipalCommand(api, tokens.io, { kind: "token-list", principalId: "sp-1" }), 0);
  assert.ok(!tokens.text().includes("orq_servicesecret"));
  assert.equal(await servicePrincipalCommand(api, collect().io, { kind: "token-revoke", principalId: "sp-1", tokenId: "tok-new" }), 0);
  assert.equal(await servicePrincipalCommand(api, collect().io, { kind: "delete", principalId: "sp-1" }), 0);
  assert.equal(calls.at(-1).path, "/v1/orgs/org-b/service-principals/sp-1/delete");
});

// --- whoami ----------------------------------------------------------------

test("whoami names the principal, each org's effective permissions, the token, and the source", async () => {
  const env = sandboxEnv();
  writeCredentials({ apiUrl: URL_A, token: "orq_file" }, env);
  const { fetch } = fakeApi({
    "GET /v1/self": () => selfFor({ organizations: [ORG_A, ORG_B] }),
    "GET /v1/health": () => ({ ok: true, database: "reachable" }),
  });
  const out = collect();
  assert.equal(await whoamiCommand(WindkeelApi.fromEnv(env, { fetch }), out.io), 0);
  const text = out.text();
  assert.match(text, /principal Ada \(@ada\) {2}\[user\]/);
  assert.match(text, /token {5}laptop {2}runs\.read, runs\.write/);
  // The admin's role allows everything; this token only reads and writes runs.
  assert.match(text, /acme {2}\(org-a\) {2}admin {2}can: runs\.read, runs\.write$/m);
  assert.match(text, /globex {2}\(org-b\) {2}viewer {2}can: runs\.read$/m);
  assert.match(text, new RegExp(`source {4}${credentialsPath(env).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const envOut = collect();
  await whoamiCommand(WindkeelApi.fromEnv({ ...env, WINDKEEL_API_TOKEN: "orq_env" }, { fetch }), envOut.io);
  assert.match(envOut.text(), /source {4}WINDKEEL_API_TOKEN, from the environment/);

  const json = collect();
  await whoamiCommand(WindkeelApi.fromEnv(env, { fetch }), json.io, { json: true });
  assert.equal(JSON.parse(json.text()).principal.githubLogin, "ada");
});

test("effective permissions are the role's intersected with the token's", () => {
  const self = selfFor({ organizations: [ORG_A, ORG_B], token: { id: "t", name: "n", permissions: ["runs.read", "runs.write"], organizationId: null } });
  assert.deepEqual(effectivePermissions(self, "org-b"), ["runs.read"], "a viewer's write-scoped token still cannot write");
  assert.deepEqual(effectivePermissions(self, "org-a"), ["runs.read", "runs.write"]);
  assert.equal(effectivePermissions({ subject: "operator", scopes: ["operator"] }), null, "an older server: unknown, not nothing");
});

// --- MCP -------------------------------------------------------------------

async function listedTools(self) {
  const { fetch } = fakeApi({ "GET /v1/self": self });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  const { tools } = await toolsForCredential(api);
  const reply = await handleMcpMessage(api, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { tools });
  return { api, tools, names: reply.result.tools.map((t) => t.name).sort() };
}

test("a read-only token gives an agent a read-only tool set", async () => {
  const { names } = await listedTools(() => selfFor({ token: { id: "t", name: "claude-code", permissions: ["runs.read"], organizationId: null } }));
  assert.ok(names.includes("windkeel_whoami"), "whoami is always there: it is how an agent learns what it may do");
  assert.ok(names.includes("windkeel_list_runs"));
  assert.ok(names.includes("windkeel_run_events"));
  for (const write of ["windkeel_submit_task", "windkeel_cancel", "windkeel_guide", "windkeel_approve", "windkeel_list_secrets"]) {
    assert.ok(!names.includes(write), `${write} must not be offered to a read-only token`);
  }
});

test("each write tool appears with exactly the permission it needs", async () => {
  const execute = await listedTools(() => selfFor({ token: { id: "t", name: "n", permissions: ["runs.read", "runs.write"], organizationId: null } }));
  assert.ok(execute.names.includes("windkeel_submit_task"));
  assert.ok(execute.names.includes("windkeel_cancel"));
  assert.ok(execute.names.includes("windkeel_guide"));
  assert.ok(!execute.names.includes("windkeel_approve"), "approving criteria is its own permission");

  const admin = await listedTools(() => selfFor({ token: { id: "t", name: "n", permissions: ORG_A.permissions, organizationId: null } }));
  assert.equal(admin.names.length, TOOLS.length);
});

test("the role limits the tools as well as the token", async () => {
  // An admin-scoped token held by a viewer can only view.
  const { names } = await listedTools(() => selfFor({ organizations: [ORG_B], token: { id: "t", name: "n", permissions: ORG_A.permissions, organizationId: null } }));
  assert.ok(!names.includes("windkeel_submit_task"));
  assert.ok(names.includes("windkeel_list_runs"));
});

test("when /v1/self fails at startup, every tool is listed and the API decides", async () => {
  const { names } = await listedTools(() => [503, { error: "down", code: "unavailable" }]);
  assert.equal(names.length, TOOLS.length);
});

test("a 403 naming a permission becomes a tool error that says which token to create", async () => {
  const { fetch } = fakeApi({ "POST /v1/runs/r1/cancel": () => [403, { error: "forbidden", code: "forbidden", missing: "runs.write" }] });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  const reply = await handleMcpMessage(api, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "windkeel_cancel", arguments: { runId: "r1" } },
  });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /this token lacks runs\.write; create one with `windkeel token create --name <name> --scope execute`/);
});

test("calling a tool that was not listed is refused before it reaches the API", async () => {
  const { api, tools } = await listedTools(() => selfFor({ token: { id: "t", name: "n", permissions: ["runs.read"], organizationId: null } }));
  const reply = await handleMcpMessage(api, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "windkeel_approve", arguments: { runId: "r1" } },
  }, { tools });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /lacks runs\.approve/);
});

test("windkeel_whoami reports the effective permissions alongside the raw self", async () => {
  const { fetch } = fakeApi({
    "GET /v1/self": () => selfFor({ token: { id: "t", name: "claude-code", permissions: ["runs.read"], organizationId: null } }),
    "GET /v1/health": () => ({ ok: true, database: "reachable" }),
  });
  const api = new WindkeelApi({ baseUrl: URL_A, token: "t", fetch });
  const reply = await handleMcpMessage(api, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "windkeel_whoami", arguments: {} } });
  const payload = JSON.parse(reply.result.content[0].text);
  assert.deepEqual(payload.effectivePermissions, ["runs.read"]);
  assert.equal(payload.token.name, "claude-code");
  assert.equal(payload.principal.githubLogin, "ada");
  assert.equal(payload.database, "reachable");
});

test("no MCP tool manages members, invitations or tokens", () => {
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.name, /member|invit|token/, `${tool.name}: an agent must not be able to invite people or mint tokens`);
  }
});

test("only an orq_ token is ever partly printed; the bootstrap credential never is", async () => {
  const { tokenPrefix } = await import("../packages/cli/dist/commands/auth.js");
  assert.equal(tokenPrefix("orq_abcdefghijklmnopqrstuvwxyz"), "orq_abcdefgh…");
  const bootstrap = tokenPrefix("local-dev-token");
  assert.ok(!bootstrap.includes("local"), "no part of a non-orq_ secret may reach a terminal");
});
