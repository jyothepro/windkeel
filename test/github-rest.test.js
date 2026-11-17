import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  APP_JWT_MAX_LIFETIME_SECONDS,
  GitHubConfigError,
  createAppJwt,
  loadGitHubConfig,
  normalizePrivateKey,
} from "../dist/github/app.js";
import {
  GitHubApiError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitedError,
} from "../dist/github/client.js";
import { RestGitHubClient, githubClientFromEnv } from "../dist/github/rest.js";
import { CONFORMANCE_SEED, runGitHubConformanceSuite } from "./github-conformance.js";
import { createGitHubStub } from "./github-stub.js";

/** Generated per process, never committed — the ticket is explicit about that. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const REPOSITORY = { owner: CONFORMANCE_SEED.owner, name: CONFORMANCE_SEED.name };
const FORK = { owner: CONFORMANCE_SEED.owner, name: "windkeel-fixture-fork" };

const ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
  GITHUB_WEBHOOK_SECRET: "shhh",
};

function makeStub() {
  return createGitHubStub({
    repositories: [CONFORMANCE_SEED, { ...CONFORMANCE_SEED, name: FORK.name, fork: true }],
  });
}

function makeClient(stub, options = {}) {
  return new RestGitHubClient({
    config: loadGitHubConfig(ENV),
    fetch: stub.fetch,
    // No real waiting anywhere in the suite: retries are asserted through `onRetry`.
    sleep: async () => {},
    ...options,
  });
}

runGitHubConformanceSuite("RestGitHubClient", async () => {
  const stub = makeStub();
  return {
    client: makeClient(stub),
    repository: REPOSITORY,
    forkRepository: FORK,
    injectFailure: (method, failure) => stub.injectFailure(method, failure),
  };
});

// --- App JWT ---

test("the App JWT is RS256, issued by the App id, backdated, and within GitHub's 10-minute cap", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  const jwt = createAppJwt({ appId: "123456", privateKeyPem: PRIVATE_KEY_PEM }, now);
  const [encodedHeader, encodedPayload, signature] = jwt.split(".");

  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "123456");
  assert.equal(payload.iat, Math.floor(now / 1000) - 60, "backdated 60s for clock skew");
  assert.ok(payload.exp - payload.iat <= APP_JWT_MAX_LIFETIME_SECONDS, "within GitHub's cap");

  const verified = createVerify("RSA-SHA256")
    .update(`${encodedHeader}.${encodedPayload}`)
    .verify(publicKey, Buffer.from(signature, "base64url"));
  assert.equal(verified, true, "signature verifies against the matching public key");
});

// --- Token scoping and caching (ADR-0014 §2) ---

test("token scoping is asserted on the request body: maker writes, verifier reads", async () => {
  const stub = makeStub();
  const client = makeClient(stub);

  await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "read" },
  });

  const mints = stub.requestsFor("mintInstallationToken");
  assert.equal(mints.length, 2);
  // A bug here silently removes ADR-0004's independence guarantee, so the assertion is on the
  // bytes that go to GitHub, not on what came back.
  assert.deepEqual(mints[0].body, {
    repositories: [CONFORMANCE_SEED.name],
    permissions: { contents: "write" },
  });
  assert.deepEqual(mints[1].body, {
    repositories: [CONFORMANCE_SEED.name],
    permissions: { contents: "read" },
  });
});

test("tokens are cached per permission set, re-minted past the safety margin", async () => {
  let now = Date.parse("2026-09-06T12:00:00.000Z");
  const stub = createGitHubStub({ repositories: [CONFORMANCE_SEED] }, { now: () => now });
  const client = makeClient(stub, { now: () => now });

  const first = await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  const second = await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  assert.equal(second.token, first.token, "inside the window, one HTTP call serves both");
  assert.equal(stub.requestsFor("mintInstallationToken").length, 1);

  // A different permission set never shares a cache entry — that confusion is the one that
  // would hand a verifier a writable token.
  await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "read" },
  });
  assert.equal(stub.requestsFor("mintInstallationToken").length, 2);

  // 56 minutes in, the one-hour token is inside the 5-minute margin: re-mint.
  now += 56 * 60 * 1000;
  const third = await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  assert.notEqual(third.token, first.token);
  assert.equal(stub.requestsFor("mintInstallationToken").length, 3);
});

test("every request pins the API version and identifies itself", async () => {
  const stub = makeStub();
  await makeClient(stub).getIssue(REPOSITORY, 7);
  for (const request of stub.requests) {
    assert.equal(request.headers["x-github-api-version"], "2022-11-28");
    assert.equal(request.headers["user-agent"], "windkeel-control-plane");
    assert.equal(request.headers.accept, "application/vnd.github+json");
  }
});

test("a draft is the only pull request this client can open", async () => {
  const stub = makeStub();
  await makeClient(stub).createPullRequest({
    repository: REPOSITORY,
    headRef: "windkeel/issue-7-add-retry",
    baseRef: "main",
    title: "t",
    body: "b",
  });
  assert.equal(stub.requestsFor("createPullRequest")[0].body.draft, true);
});

// --- Error mapping ---

test("404 becomes NotFoundError and 403-missing-permission becomes PermissionDeniedError", async () => {
  const stub = makeStub();
  const client = makeClient(stub);

  stub.injectFailure("getIssue", { kind: "notFound" });
  await assert.rejects(() => client.getIssue(REPOSITORY, 7), NotFoundError);

  stub.injectFailure("createCheckRun", { kind: "permissionDenied" });
  await assert.rejects(
    () =>
      client.createCheckRun({
        repository: REPOSITORY,
        headSha: "b".repeat(40),
        name: "windkeel/verification",
        status: "queued",
      }),
    (error) => {
      // ADR-0009 §6 needs the *reason*, so the missing permission is named.
      assert.ok(error instanceof PermissionDeniedError);
      assert.equal(error.permission, "checks");
      return true;
    },
  );
});

test("a 403 rate limit is distinguished from a 403 permission denial, and honours the reset", async () => {
  const stub = makeStub();
  const client = makeClient(stub);
  stub.injectFailure("getIssue", { kind: "rateLimited", retryAfterMs: 45_000 });
  await assert.rejects(
    () => client.getIssue(REPOSITORY, 7),
    (error) => {
      assert.ok(error instanceof RateLimitedError, "same status code, opposite meaning");
      assert.equal(error.retryAfterMs, 45_000, "Retry-After is carried, not slept on");
      return true;
    },
  );
});

test("5xx is retried within budget, observably, then surfaced", async () => {
  const stub = makeStub();
  const retries = [];
  const client = makeClient(stub, { onRetry: (event) => retries.push(event) });

  stub.injectFailure("getIssue", { kind: "apiError", status: 502, detail: "bad gateway" }, {
    count: 1,
  });
  const issue = await client.getIssue(REPOSITORY, 7);
  assert.equal(issue.number, 7, "one 502, then success");
  assert.deepEqual(
    retries.map((r) => r.reason),
    ["server-error"],
  );

  retries.length = 0;
  stub.injectFailure("getIssue", { kind: "apiError", status: 503, detail: "down" }, { count: 5 });
  await assert.rejects(() => client.getIssue(REPOSITORY, 7), GitHubApiError);
  assert.equal(retries.length, 2, "maxAttempts 3 means two retries, then the error surfaces");
});

test("a transport fault is retried and then surfaced as a GitHubApiError", async () => {
  let calls = 0;
  const client = makeClient(
    {
      fetch: async () => {
        calls++;
        throw new Error("ECONNRESET");
      },
    },
    { maxAttempts: 2 },
  );
  await assert.rejects(() => client.getRepository(REPOSITORY), GitHubApiError);
  assert.equal(calls, 2);
});

// --- Secret hygiene ---

test("a failing request's error carries neither the private key nor an installation token", async () => {
  const stub = makeStub();
  const client = makeClient(stub);
  // Mint first so a token exists to leak, then fail a request that used it.
  const token = await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  stub.injectFailure("getIssue", { kind: "apiError", status: 422, detail: "unprocessable" });

  await assert.rejects(
    () => client.getIssue(REPOSITORY, 7),
    (error) => {
      const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      assert.ok(!serialized.includes(token.token), "no installation token in the error");
      assert.ok(!serialized.includes("PRIVATE KEY"), "no PEM in the error");
      assert.ok(
        !serialized.includes(PRIVATE_KEY_PEM.split("\n")[1]),
        "not even a line of the key",
      );
      return true;
    },
  );
});

// --- Configuration ---

test("configuration fails at construction, naming the variable at fault", () => {
  assert.throws(() => loadGitHubConfig({}), /GITHUB_APP_ID is not set/);
  assert.throws(
    () => loadGitHubConfig({ GITHUB_APP_ID: "abc", GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM }),
    /GITHUB_APP_ID must be numeric/,
  );
  assert.throws(
    () => loadGitHubConfig({ GITHUB_APP_ID: "1" }),
    /GITHUB_APP_PRIVATE_KEY is not set/,
  );
  assert.throws(
    () => loadGitHubConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not-a-key" }),
    GitHubConfigError,
  );
  // The worker mints tokens and never verifies a signature, so the secret is required only
  // where it is used — the ingress asks for it explicitly (M6.4).
  assert.equal(loadGitHubConfig({ ...ENV, GITHUB_WEBHOOK_SECRET: undefined }).webhookSecret, undefined);
  assert.throws(
    () =>
      loadGitHubConfig({ ...ENV, GITHUB_WEBHOOK_SECRET: undefined }, {
        requireWebhookSecret: true,
      }),
    /GITHUB_WEBHOOK_SECRET is not set/,
  );
});

test("the private key is accepted as raw PEM, escaped PEM, or base64 — and nothing else", () => {
  assert.equal(normalizePrivateKey(PRIVATE_KEY_PEM, "K"), PRIVATE_KEY_PEM.trim());
  assert.equal(
    normalizePrivateKey(PRIVATE_KEY_PEM.replace(/\n/g, "\\n"), "K"),
    PRIVATE_KEY_PEM.trim(),
  );
  assert.equal(
    normalizePrivateKey(Buffer.from(PRIVATE_KEY_PEM).toString("base64"), "K"),
    PRIVATE_KEY_PEM.trim(),
  );
  assert.throws(() => normalizePrivateKey("nope", "MY_KEY"), /MY_KEY is not a private key/);
  assert.throws(() => normalizePrivateKey("  ", "MY_KEY"), /MY_KEY is empty/);
});

test("githubClientFromEnv builds a usable client from the environment", async () => {
  const stub = makeStub();
  const client = githubClientFromEnv(ENV, { fetch: stub.fetch, sleep: async () => {} });
  const repository = await client.getRepository(REPOSITORY);
  assert.equal(repository.defaultBranch, "main");
});

test("no live network: the suite never touches api.github.com", () => {
  // Every client in this file is constructed with an injected `fetch`; the default is only
  // reached in production. Asserted as a reminder rather than a mechanism.
  assert.equal(loadGitHubConfig(ENV).baseUrl, "https://api.github.com");
  assert.equal(
    loadGitHubConfig({ ...ENV, GITHUB_API_BASE_URL: "https://ghes.example/api/v3/" }).baseUrl,
    "https://ghes.example/api/v3",
  );
});
