/**
 * `windkeel env status|rebuild|invalidate --repo …` against a fake API (#387): the repository is
 * resolved from `owner/name`, each subcommand reaches its route, and a refusal is said in words.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { envCommand } from "../packages/cli/dist/commands/environment.js";
import { runCli } from "./helpers.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO = "11111111-1111-4111-8111-111111111111";

function fakeApi(routes) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    requests.push({ method: init.method, path: parsed.pathname });
    const answer = routes(`${init.method} ${parsed.pathname}`) ?? { status: 404, body: { error: "no route", code: "no_route" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return { api: new WindkeelApi({ baseUrl: "https://windkeel.example.com", token: "orq_test", org: ORG, fetch }), requests };
}

function recorder() {
  const out = [];
  const err = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

const repositories = { status: 200, body: { items: [{ id: REPO, fullName: "acme/widgets" }], endCursor: null, hasNextPage: false } };
const base = `/v1/orgs/${ORG}/repositories/${REPO}/environment`;

test("status resolves owner/name and prints the snapshots and the suggested setup", async () => {
  const { api, requests } = fakeApi((route) => {
    if (route === `GET /v1/orgs/${ORG}/repositories`) return repositories;
    if (route === `GET ${base}`) {
      const ready = { id: "snap-row-1", status: "ready", cacheKey: "f".repeat(64), baseSha: "a".repeat(40), sizeBytes: 5_000_000, detail: "npm ci; secret scan clean", readyAt: "2026-10-21T00:00:00Z" };
      return {
        status: 200,
        body: {
          items: [ready],
          current: ready,
          pendingRequest: null,
          proposedSetup: { setup: { commands: [{ name: "bootstrap", run: "make bootstrap" }] }, reasons: ["Makefile has a `bootstrap` target"] },
        },
      };
    }
    return null;
  });
  const { io, out, err } = recorder();
  assert.equal(await envCommand(api, io, { kind: "status", repo: "acme/widgets" }), 0, err.join("\n"));
  const printed = out.join("\n");
  assert.match(printed, /Current: snap-row-1/);
  assert.match(printed, /ready\s+ffffffffffff\s+aaaaaaaaaaaa\s+5\.0 MB\s+npm ci; secret scan clean/);
  assert.match(printed, /make bootstrap/);
  assert.match(printed, /review it, then commit it on the default branch/);
  assert.deepEqual(requests.map((r) => r.path), [`/v1/orgs/${ORG}/repositories`, base]);
});

test("rebuild and invalidate post to their routes; a repository id skips the lookup", async () => {
  const { api, requests } = fakeApi((route) => {
    if (route === `POST ${base}/rebuild`) return { status: 202, body: { accepted: true, started: true } };
    if (route === `POST ${base}/invalidate`) return { status: 200, body: { invalidated: 2 } };
    return null;
  });
  const { io, out } = recorder();
  assert.equal(await envCommand(api, io, { kind: "rebuild", repo: REPO }), 0);
  assert.equal(await envCommand(api, io, { kind: "invalidate", repo: REPO }), 0);
  assert.match(out[0], /Rebuild started/);
  assert.match(out[1], /Invalidated 2 snapshot\(s\).*next run is cold/);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [`POST ${base}/rebuild`, `POST ${base}/invalidate`]);
});

test("a refusal is printed, and an unknown repository is said plainly", async () => {
  const { api } = fakeApi((route) => {
    if (route === `GET /v1/orgs/${ORG}/repositories`) return repositories;
    if (route === `GET ${base}`) return { status: 403, body: { error: "needs secrets.manage", code: "forbidden", missing: "secrets.manage" } };
    return null;
  });
  const refused = recorder();
  assert.equal(await envCommand(api, refused.io, { kind: "status", repo: "acme/widgets" }), 1);
  assert.match(refused.err.join("\n"), /refused: needs secrets.manage/);
  const unknown = recorder();
  assert.equal(await envCommand(api, unknown.io, { kind: "status", repo: "acme/nope" }), 1);
  assert.match(unknown.err.join("\n"), /no repository acme\/nope/);
});

test("`windkeel env` without a subcommand or --repo prints its usage", () => {
  const result = runCli(["env", "status"], { env: { WINDKEEL_API_URL: "https://windkeel.example.invalid", WINDKEEL_API_TOKEN: "orq_x" } });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /usage: windkeel env status/);
});
