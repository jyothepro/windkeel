/**
 * `windkeel models credentials` against a fake API (M9-2, #320).
 *
 * The CLI's job here is narrow and the tests are about its edges: the key reaches the API only in
 * the body of the one request that stores it, it comes from stdin or `--from-env` and never from
 * the command line, and nothing printed afterwards contains it. The fake records every request so
 * the "only in that one body" half can be asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { modelsCommand } from "../packages/cli/dist/commands/models.js";
import { runCli } from "./helpers.js";

const KEY = "sk-ant-api03-CliTestKey0123456789abcdef";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function credential(overrides = {}) {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    provider: "anthropic",
    baseUrl: null,
    declaredVendor: null,
    label: "prod",
    last4: KEY.slice(-4),
    keypairId: "0123456789abcdef",
    status: "unverified",
    statusReason: null,
    validatedAt: null,
    createdByPrincipalId: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

/** A fake control plane: records each request and answers from `routes`. */
function fakeApi(routes) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method: init.method, path: parsed.pathname, search: parsed.search, body, headers: init.headers });
    const answer = routes(`${init.method} ${parsed.pathname}`, body) ?? { status: 404, body: { error: "no route", code: "no_route" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  const api = new WindkeelApi({ baseUrl: "https://windkeel.example.com", token: "orq_test", org: ORG, fetch });
  return { api, requests };
}

function recorder() {
  const out = [];
  const err = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

const fromStdin = (text) => ({ env: {}, stdinIsTty: false, readStdin: async () => text });

test("add reads the key from stdin and sends it once, in the body, to the org-scoped route", async () => {
  const { api, requests } = fakeApi((route) =>
    route === `POST /v1/orgs/${ORG}/model-credentials`
      ? { status: 201, body: { credential: credential(), validation: "started" } }
      : null,
  );
  const { io, out, err } = recorder();
  const code = await modelsCommand(api, io, { kind: "add", provider: "anthropic", label: "prod" }, fromStdin(`${KEY}\n`));
  assert.equal(code, 0, err.join("\n"));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { provider: "anthropic", label: "prod", value: KEY }, "trimmed, and nothing else");
  assert.ok(!requests[0].path.includes(KEY) && !requests[0].search.includes(KEY), "never in the URL");
  const printed = out.join("\n");
  assert.match(printed, /stored .*prod.*…/);
  assert.match(printed, /Checking the key/);
  assert.ok(!printed.includes(KEY), "the key is never printed");
});

test("add and rotate take --from-env, and refuse an unset variable without sending anything", async () => {
  const { api, requests } = fakeApi((route) =>
    route.startsWith("PUT ")
      ? { status: 200, body: { credential: credential({ last4: "WXYZ" }), validation: "failed" } }
      : null,
  );
  const { io, out, err } = recorder();
  const env = { env: { MY_KEY: "sk-or-v1-RotatedKeyWXYZ" }, stdinIsTty: true, readStdin: async () => assert.fail("stdin read") };
  assert.equal(await modelsCommand(api, io, { kind: "rotate", credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", fromEnv: "MY_KEY" }, env), 0);
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(requests[0].body, { value: "sk-or-v1-RotatedKeyWXYZ" });
  assert.match(out.join("\n"), /could not be started.*validate/);

  assert.equal(await modelsCommand(api, io, { kind: "rotate", credentialId: "x", fromEnv: "UNSET_VAR" }, env), 2);
  assert.match(err.join("\n"), /UNSET_VAR.*not set/);
  assert.equal(requests.length, 1, "nothing was sent for the refused rotate");
});

test("a key is never read from a terminal, and an empty stdin is refused", async () => {
  const { api, requests } = fakeApi(() => null);
  const { io, err } = recorder();
  const tty = { env: {}, stdinIsTty: true, readStdin: async () => assert.fail("must not read a terminal") };
  assert.equal(await modelsCommand(api, io, { kind: "add", provider: "openai", label: "p" }, tty), 2);
  assert.match(err.join("\n"), /stdin or --from-env/);
  assert.equal(await modelsCommand(api, io, { kind: "add", provider: "openai", label: "p" }, fromStdin("  \n")), 2);
  assert.equal(requests.length, 0);
});

test("list shows label, provider, last four and status, and never a value", async () => {
  const { api, requests } = fakeApi((route) =>
    route === `GET /v1/orgs/${ORG}/model-credentials`
      ? {
          status: 200,
          body: {
            items: [credential({ status: "invalid", statusReason: "the provider refused the key (HTTP 401 from GET /models)" })],
            endCursor: null,
            hasNextPage: false,
          },
        }
      : null,
  );
  const { io, out } = recorder();
  assert.equal(await modelsCommand(api, io, { kind: "list", all: true }), 0);
  assert.equal(requests[0].search, "?include=revoked");
  const printed = out.join("\n");
  assert.match(printed, /prod {2}anthropic {2}…cdef {2}invalid {2}\(the provider refused the key/);
  assert.match(printed, /cannot be/);
});

test("revoke and validate address the credential by id", async () => {
  const { api, requests } = fakeApi((route) => {
    if (route.startsWith("DELETE ")) return { status: 200, body: { credential: credential({ status: "revoked" }) } };
    if (route.endsWith("/validate")) return { status: 202, body: { accepted: true, credential: credential(), validation: "started" } };
    return null;
  });
  const { io, out } = recorder();
  assert.equal(await modelsCommand(api, io, { kind: "revoke", credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), 0);
  assert.equal(await modelsCommand(api, io, { kind: "validate", credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), 0);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    [
      `DELETE /v1/orgs/${ORG}/model-credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      `POST /v1/orgs/${ORG}/model-credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc/validate`,
    ],
  );
  assert.match(out.join("\n"), /revoked .*revoked/);
});

test("the binary refuses a key passed as a flag or an argument, before contacting anything", () => {
  // An unroutable URL: the refusal must happen before any request, or this would hang or fail differently.
  const env = { WINDKEEL_API_URL: "http://127.0.0.1:9", WINDKEEL_API_TOKEN: "orq_test", WINDKEEL_CONFIG_DIR: "/nonexistent-windkeel-config" };
  for (const args of [
    ["models", "credentials", "add", "--provider", "openai", "--label", "p", "--value", KEY],
    ["models", "credentials", "add", "--provider", "openai", "--label", "p", "--key", KEY],
    ["models", "credentials", "add", "--provider", "openai", "--label", "p", KEY],
    ["models", "credentials", "rotate", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", KEY],
  ]) {
    const result = runCli(args, { env });
    assert.equal(result.code, 2, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stderr, /shell history/);
    assert.ok(!result.stderr.includes(KEY) && !result.stdout.includes(KEY), "the refusal does not echo the key");
  }
  const usage = runCli(["models", "credentials"], { env });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /windkeel models credentials add/);
});

// --- policy (M9-3) -----------------------------------------------------------

const REPO = "11111111-1111-1111-1111-111111111111";

function policy(overrides = {}) {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    repositoryId: null,
    role: "maker",
    provider: "openai",
    model: "gpt-5",
    credentialId: null,
    keySource: "orqon",
    declaredVendor: null,
    updatedByPrincipalId: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

test("policy show, set and clear address the org-scoped policy route, with ?repositoryId= for a repository", async () => {
  const { api, requests } = fakeApi((route) => {
    if (route === `GET /v1/orgs/${ORG}/model-policy`) return { status: 200, body: { repositoryId: null, items: [policy()] } };
    if (route === `PUT /v1/orgs/${ORG}/model-policy`) {
      return { status: 200, body: { repositoryId: REPO, items: [policy({ role: "checker", provider: "openrouter", model: "google/gemini-2.5-pro", credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", keySource: "customer", repositoryId: REPO })] } };
    }
    if (route === `DELETE /v1/orgs/${ORG}/model-policy`) return { status: 200, body: { repositoryId: null, deleted: 2 } };
    return null;
  });
  const { io, out } = recorder();
  assert.equal(await modelsCommand(api, io, { kind: "policy-show" }), 0);
  assert.equal(
    await modelsCommand(api, io, {
      kind: "policy-set",
      role: "checker",
      model: "google/gemini-2.5-pro",
      credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repositoryId: REPO,
    }),
    0,
  );
  assert.equal(await modelsCommand(api, io, { kind: "policy-clear", role: "maker" }), 0);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}${r.search}`),
    [
      `GET /v1/orgs/${ORG}/model-policy`,
      `PUT /v1/orgs/${ORG}/model-policy?repositoryId=${REPO}`,
      `DELETE /v1/orgs/${ORG}/model-policy?role=maker`,
    ],
  );
  assert.deepEqual(requests[1].body, {
    checker: { model: "google/gemini-2.5-pro", credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  });
  const printed = out.join("\n");
  assert.match(printed, /maker {2}openai\/gpt-5 {2}Windkeel-managed {2}\[organization\]/);
  assert.match(printed, /set checker {2}openrouter\/google\/gemini-2\.5-pro {2}credential cccccccc/);
  assert.match(printed, /cleared 2 policy rows/);
});

test("submitting a task carries --maker-model and --checker-model as its models", async () => {
  const { submitCommand } = await import("../packages/cli/dist/commands/remote.js");
  const { api, requests } = fakeApi((route) =>
    route === `POST /v1/orgs/${ORG}/tasks`
      ? { status: 202, body: { taskId: "t", engineeringRunId: "r", enqueued: true, cursor: null } }
      : null,
  );
  const { io } = recorder();
  await submitCommand(api, io, {
    repo: REPO,
    title: "t",
    description: "d",
    models: { maker: "gpt-5-codex", checker: "claude-opus-4-1" },
  });
  assert.deepEqual(requests[0].body.models, { maker: "gpt-5-codex", checker: "claude-opus-4-1" });
});
