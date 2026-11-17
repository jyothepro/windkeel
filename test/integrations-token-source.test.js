/**
 * The Vercel Connect token seam (ADR-0025 §1, M8-3).
 *
 * `@vercel/connect` is replaced by an injected fake SDK throughout: nothing here reaches the
 * network. The error classes thrown by the fake are the SDK's own, imported from the real package,
 * so what is under test is the mapping of what the SDK really throws.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import {
  IntegrationMisconfigured,
  IntegrationNotConnected,
  IntegrationUnavailable,
  ProviderUnauthorized,
} from "../dist/integrations/errors.js";
import { FakeProviderTokenSource, withProviderToken } from "../dist/integrations/token-source.js";
import {
  createConnectForwardVerifier,
  fakeConnectForwardVerifier,
  VercelConnectTokenSource,
} from "../dist/integrations/vercel-connect.js";
import { repoRoot } from "./helpers.js";

const SECRET = "xoxb-this-is-the-provider-token-and-must-never-leak";
const ENV = { WINDKEEL_CONNECT_SLACK: "slack/windkeel", WINDKEEL_CONNECT_LINEAR: "linear/windkeel", WINDKEEL_CONNECT_JIRA: "oauth/jira" };
const REQ = { provider: "slack", installationId: "inst_1" };

/** A stand-in for `@vercel/connect`: scripted answers, every call recorded. */
function fakeSdk(script = {}) {
  const calls = [];
  let issued = 0;
  return {
    calls,
    async getToken(connector, params) {
      calls.push({ fn: "getToken", connector, params });
      if (script.throws) throw script.throws();
      issued += 1;
      return `${SECRET}-${issued}`;
    },
    async getTokenResponse(connector, params) {
      calls.push({ fn: "getTokenResponse", connector, params });
      if (script.throws) throw script.throws();
      return { token: SECRET, tenantId: "T0001", name: "Acme", installationId: params.installationId };
    },
    deleteTokenCacheEntry(connector, params) {
      calls.push({ fn: "deleteTokenCacheEntry", connector, params });
    },
  };
}

/** Everything written to the console while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const originals = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join("\n");
}

test("getToken asks Connect for an app token on the organization's installation", async () => {
  const sdk = fakeSdk();
  const source = new VercelConnectTokenSource({ env: ENV, sdk });
  const token = await source.getToken({ ...REQ, scopes: ["chat:write"] });
  assert.ok(token.startsWith(SECRET));
  assert.deepEqual(sdk.calls[0], {
    fn: "getToken",
    connector: "slack/windkeel",
    params: { subject: { type: "app" }, installationId: "inst_1", scopes: ["chat:write"] },
  });
});

test("connector uids are read on use, so an unset one is a misconfiguration, not a startup failure", async () => {
  const env = {};
  let loaded = false;
  const source = new VercelConnectTokenSource({
    env,
    sdk: async () => {
      loaded = true;
      return fakeSdk();
    },
  });
  assert.equal(loaded, false, "constructing the source loads nothing");
  await assert.rejects(source.getToken(REQ), (err) => err instanceof IntegrationMisconfigured && /WINDKEEL_CONNECT_SLACK/.test(err.message));
  env.WINDKEEL_CONNECT_SLACK = "slack/late";
  assert.ok(await source.getToken(REQ));
});

test("each Connect error class maps to the typed error a caller acts on", async () => {
  class ConnectorNotFoundError extends ConnectError {
    name = "ConnectorNotFoundError";
  }
  class ClientNotLinkedToProjectError extends ConnectError {
    name = "ClientNotLinkedToProjectError";
  }
  class ClientNotEnabledForEnvironmentError extends ConnectError {
    name = "ClientNotEnabledForEnvironmentError";
  }
  const cases = [
    [() => new ConnectorInstallationRequiredError("install it", { code: "connector_installation_required", status: 404 }), IntegrationNotConnected],
    [() => new NoValidTokenError("revoked", { code: "no_token", status: 400 }), IntegrationNotConnected],
    [() => new UserAuthorizationRequiredError("user", { code: "user_authorization_required" }), IntegrationNotConnected],
    // The three the SDK reference documents as classes; 2.3.3 raises them as a coded ConnectError.
    [() => new ConnectorNotFoundError("no connector"), IntegrationMisconfigured],
    [() => new ClientNotLinkedToProjectError("not linked"), IntegrationMisconfigured],
    [() => new ClientNotEnabledForEnvironmentError("not enabled"), IntegrationMisconfigured],
    [() => new ConnectError("x", { code: "connector_not_found", status: 404 }), IntegrationMisconfigured],
    [() => new ConnectError("x", { code: "client_not_linked_to_project", status: 403 }), IntegrationMisconfigured],
    [() => new ConnectError("x", { code: "client_not_enabled_for_environment", status: 403 }), IntegrationMisconfigured],
    [() => Object.assign(new Error("no oidc"), { name: "VercelOidcTokenError" }), IntegrationMisconfigured],
    [() => new ConnectError(`upstream said ${SECRET}`, { status: 503 }), IntegrationUnavailable],
  ];
  for (const [make, expected] of cases) {
    for (const call of ["getToken", "describeInstallation"]) {
      const source = new VercelConnectTokenSource({ env: ENV, sdk: fakeSdk({ throws: make }) });
      await assert.rejects(source[call](REQ), (err) => {
        assert.ok(err instanceof expected, `${make().name} via ${call} should be ${expected.name}, was ${err.name}`);
        assert.ok(!err.message.includes(SECRET), "the SDK's message is not carried into ours");
        return true;
      });
    }
  }
});

test("describeInstallation returns who the installation is and drops the token", async () => {
  const source = new VercelConnectTokenSource({ env: ENV, sdk: fakeSdk() });
  const identity = await source.describeInstallation(REQ);
  assert.deepEqual(identity, { tenantId: "T0001", name: "Acme" });
  assert.ok(!JSON.stringify(identity).includes(SECRET));
});

test("a 401 from the provider drops the cached token and retries exactly once", async () => {
  const sdk = fakeSdk();
  const source = new VercelConnectTokenSource({ env: ENV, sdk });
  const seen = [];
  const result = await withProviderToken(source, REQ, async (token) => {
    seen.push(token);
    return { status: seen.length === 1 ? 401 : 200 };
  });
  assert.equal(result.status, 200);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "the retry uses a fresh token");
  const deleted = sdk.calls.filter((c) => c.fn === "deleteTokenCacheEntry");
  assert.equal(deleted.length, 1);
  // The cache entry dropped is the one the token came from: same connector, same params.
  assert.deepEqual(deleted[0].params, sdk.calls[0].params);
  assert.equal(deleted[0].connector, sdk.calls[0].connector);

  // A thrown 401 is retried too; a second 401 is the caller's to handle, not a loop.
  let attempts = 0;
  await assert.rejects(
    withProviderToken(source, REQ, async () => {
      attempts += 1;
      throw new ProviderUnauthorized();
    }),
    ProviderUnauthorized,
  );
  assert.equal(attempts, 2);

  // Anything else is not retried.
  attempts = 0;
  await assert.rejects(
    withProviderToken(source, REQ, async () => {
      attempts += 1;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }),
    /rate limited/,
  );
  assert.equal(attempts, 1);
});

test("the token never reaches a log line or an error", async () => {
  const logs = await captureLogs(async () => {
    const source = new VercelConnectTokenSource({ env: ENV, sdk: fakeSdk() });
    await source.getToken(REQ);
    await source.describeInstallation(REQ);
    await withProviderToken(source, REQ, async () => ({ status: 401 }));
    const failing = new VercelConnectTokenSource({
      env: ENV,
      sdk: fakeSdk({ throws: () => new ConnectError(`echo ${SECRET}`, { status: 500 }) }),
    });
    await failing.getToken(REQ).catch((err) => console.error(err));
  });
  assert.ok(!logs.includes(SECRET), "a provider token appeared in a log line");
});

test("the fake source issues tokens only for installations it was told about", async () => {
  const fake = new FakeProviderTokenSource().install("linear", "inst_l", { tenantId: "org-1", name: "Linear Co" });
  assert.match(await fake.getToken({ provider: "linear", installationId: "inst_l" }), /^fake-linear-inst_l-/);
  await assert.rejects(fake.getToken({ provider: "linear", installationId: "nope" }), IntegrationNotConnected);
  assert.deepEqual(await fake.describeInstallation({ provider: "linear", installationId: "inst_l" }), {
    tenantId: "org-1",
    name: "Linear Co",
  });
});

test("the forward verifier accepts this deployment's own environment for this project, and fails closed", async () => {
  const seen = [];
  const createVerifier = (options) => {
    seen.push(options);
    return async (request) => {
      const auth = request.headers.get("authorization");
      if (auth === "Bearer good") return true;
      throw new Error("bad token");
    };
  };
  const verify = createConnectForwardVerifier({
    env: { VERCEL_PROJECT_ID: "prj_1", VERCEL_TARGET_ENV: "production", VERCEL_ENV: "production" },
    createVerifier,
  });
  assert.equal(await verify({ headers: { authorization: "Bearer good" } }), true);
  assert.deepEqual(seen[0], { projectId: "prj_1", environment: ["production"] });
  assert.equal(await verify({ headers: { authorization: "Bearer bad" } }), false, "a thrown verification is false");
  assert.equal(await verify({ headers: {} }), false, "no header is false");

  const noProject = createConnectForwardVerifier({ env: { VERCEL_ENV: "production" }, createVerifier });
  assert.equal(await noProject({ headers: { authorization: "Bearer good" } }), false, "no project id, no trust");

  const noEnvironment = createConnectForwardVerifier({ env: { VERCEL_PROJECT_ID: "prj_1" }, createVerifier });
  assert.equal(await noEnvironment({ headers: { authorization: "Bearer good" } }), false, "no environment, no trust");

  // The real SDK verifier, with no network: a malformed token is refused before any JWKS fetch.
  const real = createConnectForwardVerifier({ env: { VERCEL_PROJECT_ID: "prj_1", VERCEL_ENV: "production" } });
  assert.equal(await real({ headers: { authorization: "Bearer not-a-jwt" } }), false);

  const fake = fakeConnectForwardVerifier("t");
  assert.equal(await fake({ headers: { authorization: "Bearer t" } }), true);
  assert.equal(await fake({ headers: { authorization: "Bearer u" } }), false);
});

/**
 * The forged-preview-token case. A token minted by a preview deployment of the same project carries
 * `environment: "preview"`; production used to accept it, and since Slack and Linear take the
 * tenant from the body, that was a forged event into any tenant. The SDK's verifier cannot run here
 * (its JWKS is a hard-coded remote URL), so `createVerifier` applies the same claim checks
 * `verifyVercelOidcToken` makes after the signature — project, environment list, optional owner —
 * to an unsigned claims blob. What is under test is which options this module hands it.
 */
test("a production deployment refuses a preview deployment's OIDC token, and pins owner_id when known", async () => {
  const claims = (environment, owner = "team_ours") => ({
    iss: "https://oidc.vercel.com/acme",
    project_id: "prj_1",
    owner_id: owner,
    environment,
  });
  const seen = [];
  // What `createConnectWebhookVerifier` would do with these options, minus the signature: the
  // project, environment and owner checks `verifyVercelOidcToken` makes after `jwtVerify`.
  const createVerifier = (options) => {
    seen.push(options);
    return async (request) => {
      const token = request.headers.get("authorization").replace(/^Bearer /, "");
      const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      if (payload.project_id !== options.projectId) throw new Error("project");
      if (!options.environment.includes(payload.environment)) throw new Error("environment");
      if (options.ownerId !== undefined && payload.owner_id !== options.ownerId) throw new Error("owner");
      return true;
    };
  };
  const bearer = (payload) => ({
    headers: { authorization: `Bearer ${Buffer.from(JSON.stringify(payload)).toString("base64url")}` },
  });

  const production = createConnectForwardVerifier({
    env: { VERCEL_PROJECT_ID: "prj_1", VERCEL_TARGET_ENV: "production", VERCEL_ENV: "production", VERCEL_TEAM_ID: "team_ours" },
    createVerifier,
  });
  assert.equal(await production(bearer(claims("production"))), true, "production accepts production");
  assert.equal(await production(bearer(claims("preview"))), false, "production refuses a preview token");
  assert.equal(await production(bearer(claims("production", "team_theirs"))), false, "another owner is refused");
  assert.deepEqual(seen.at(-1), { projectId: "prj_1", environment: ["production"], ownerId: "team_ours" });

  // A preview deployment trusts preview tokens and nothing else: the boundary runs both ways.
  const preview = createConnectForwardVerifier({
    env: { VERCEL_PROJECT_ID: "prj_1", VERCEL_ENV: "preview" },
    createVerifier,
  });
  assert.equal(await preview(bearer(claims("preview"))), true);
  assert.equal(await preview(bearer(claims("production"))), false);
  assert.equal(seen.at(-1).ownerId, undefined, "no team id known, owner unchecked");

  // VERCEL_TARGET_ENV wins over VERCEL_ENV (it names custom environments); the explicit option
  // wins over both, for tests; WINDKEEL_CONNECT_OWNER_ID wins over a VERCEL_TEAM_ID that is a slug.
  const custom = createConnectForwardVerifier({
    env: { VERCEL_PROJECT_ID: "prj_1", VERCEL_TARGET_ENV: "staging", VERCEL_ENV: "preview", VERCEL_TEAM_ID: "acme" },
    createVerifier,
  });
  assert.equal(await custom(bearer(claims("preview"))), false);
  assert.equal(await custom(bearer(claims("staging"))), true);
  assert.equal(seen.at(-1).ownerId, undefined, "a slug in VERCEL_TEAM_ID is not taken for an owner id");
  const overridden = createConnectForwardVerifier({
    env: { VERCEL_PROJECT_ID: "prj_1", VERCEL_ENV: "production", WINDKEEL_CONNECT_OWNER_ID: "team_ours" },
    environment: "test",
    createVerifier,
  });
  assert.equal(await overridden(bearer(claims("test"))), true);
  assert.equal(await overridden(bearer(claims("production"))), false);
  assert.equal(seen.at(-1).ownerId, "team_ours");
});

test("no file outside src/integrations imports @vercel/connect", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".next"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
        const source = readFileSync(full, "utf8");
        if (/from\s+["']@vercel\/connect|import\(\s*["']@vercel\/connect/.test(source)) {
          offenders.push(relative(repoRoot, full));
        }
      }
    }
  };
  for (const dir of ["src", "apps", "packages"]) walk(join(repoRoot, dir));
  assert.deepEqual(offenders.filter((f) => !f.startsWith(join("src", "integrations"))), []);
  assert.ok(offenders.length > 0, "the walk found no importer at all, so it is not checking anything");
});
