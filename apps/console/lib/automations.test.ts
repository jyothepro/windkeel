import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { automationsClient, orgPath } from "./automations.ts";
import { ApiError, callApi, refusal, type Method } from "./http.ts";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let seen: Seen[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: {} };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      method: String(init.method),
      url,
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const client = automationsClient(async <T,>(method: Method, path: string, body?: unknown): Promise<T> => {
  const a = await callApi("https://api.test", "orq_test", method, path, body);
  if (!a.ok) throw refusal(a);
  return a.json as T;
});

const ORG = "org-1";

test("paths are organization-scoped, and an organization with no id takes the plain route", () => {
  assert.equal(orgPath("org 1", "/schedules"), "/orgs/org%201/schedules");
  assert.equal(orgPath("", "/schedules"), "/schedules");
});

test("integrations: list, connect, route, change a route, remove, disconnect", async () => {
  answer.body = { items: [{ id: "int-1", provider: "slack", routes: [] }], endCursor: null, hasNextPage: false };
  const list = await client.listIntegrations(ORG);
  assert.equal(list[0]!.id, "int-1");
  assert.equal(seen[0]!.method, "GET");
  assert.equal(seen[0]!.url, "https://api.test/v1/orgs/org-1/integrations");
  assert.equal(seen[0]!.headers["authorization"], "Bearer orq_test");

  answer = { status: 201, body: { connection: { id: "int-2", externalTenantName: "Acme" } } };
  const connected = await client.connectIntegration(ORG, { provider: "slack", installationId: "icfg_1" });
  assert.equal(connected.id, "int-2");
  assert.deepEqual(seen[1], {
    method: "POST",
    url: "https://api.test/v1/orgs/org-1/integrations",
    headers: { authorization: "Bearer orq_test", "content-type": "application/json" },
    body: { provider: "slack", installationId: "icfg_1" },
  });

  answer = { status: 201, body: { route: { id: "rt-1" } } };
  await client.addIntegrationRoute(ORG, "int-2", { scopeKind: "slack_channel", scopeValue: "C1", repositoryId: "repo-1", enabled: true });
  assert.equal(seen[2]!.url, "https://api.test/v1/orgs/org-1/integrations/int-2/routes");
  assert.deepEqual(seen[2]!.body, { scopeKind: "slack_channel", scopeValue: "C1", repositoryId: "repo-1", enabled: true });

  answer = { status: 200, body: { route: { id: "rt-1", enabled: false } } };
  const changed = await client.updateIntegrationRoute(ORG, "int-2", "rt-1", { enabled: false });
  assert.equal(changed.enabled, false);
  assert.equal(seen[3]!.method, "PATCH");
  assert.equal(seen[3]!.url, "https://api.test/v1/orgs/org-1/integrations/int-2/routes/rt-1");

  answer = { status: 200, body: { deleted: "rt-1" } };
  await client.deleteIntegrationRoute(ORG, "int-2", "rt-1");
  await client.disconnectIntegration(ORG, "int-2");
  assert.deepEqual(
    seen.slice(4).map((s) => `${s.method} ${s.url}`),
    ["DELETE https://api.test/v1/orgs/org-1/integrations/int-2/routes/rt-1", "DELETE https://api.test/v1/orgs/org-1/integrations/int-2"],
  );
});

test("a refusal carries the API's code: tenant_claimed, integration_not_connected", async () => {
  answer = { status: 409, body: { error: "workspace T1 is connected to another organization", code: "tenant_claimed" } };
  await assert.rejects(client.connectIntegration(ORG, { provider: "slack", installationId: "x" }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 409);
    assert.equal(err.code, "tenant_claimed");
    return true;
  });
  answer = { status: 422, body: { error: "no installation", code: "integration_not_connected" } };
  await assert.rejects(client.connectIntegration(ORG, { provider: "jira", installationId: "x" }), { code: "integration_not_connected" });
});

test("schedules: page, preview, create, change, fire, delete", async () => {
  answer.body = { items: [], endCursor: "c2", hasNextPage: true };
  const page = await client.listSchedules(ORG, "c1");
  assert.equal(page.endCursor, "c2");
  assert.equal(seen[0]!.url, "https://api.test/v1/orgs/org-1/schedules?cursor=c1");

  answer.body = { cron: "0 3 * * *", timezone: "Europe/Berlin", nextFireTimes: ["2026-09-26T01:00:00.000Z"] };
  const preview = await client.previewSchedule(ORG, "0 3 * * *", "Europe/Berlin");
  assert.deepEqual(preview.nextFireTimes, ["2026-09-26T01:00:00.000Z"]);
  const url = new URL(seen[1]!.url);
  assert.equal(url.pathname, "/v1/orgs/org-1/schedules/preview");
  assert.equal(url.searchParams.get("cron"), "0 3 * * *");
  assert.equal(url.searchParams.get("timezone"), "Europe/Berlin");
  assert.equal(url.searchParams.get("count"), "3");

  answer = { status: 201, body: { schedule: { id: "sch-1" } } };
  const input = { name: "n", repositoryId: "r", cron: "0 3 * * *", timezone: "UTC", title: "t", description: "d" };
  assert.equal((await client.createSchedule(ORG, input)).id, "sch-1");
  assert.deepEqual(seen[2]!.body, input);

  answer = { status: 200, body: { schedule: { id: "sch-1", enabled: false } } };
  await client.updateSchedule(ORG, "sch-1", { enabled: false });
  assert.equal(seen[3]!.method, "PATCH");
  assert.deepEqual(seen[3]!.body, { enabled: false });

  answer = { status: 202, body: { accepted: true, taskId: "task-1", engineeringRunId: "run-1", enqueued: true } };
  const fired = await client.fireSchedule(ORG, "sch-1");
  assert.equal(fired.engineeringRunId, "run-1");
  assert.equal(seen[4]!.url, "https://api.test/v1/orgs/org-1/schedules/sch-1/fire");
  assert.equal(seen[4]!.body, undefined, "fire sends no body");

  answer = { status: 409, body: { error: "this schedule's previous run is still in flight", code: "run_in_flight" } };
  await assert.rejects(client.fireSchedule(ORG, "sch-1"), { code: "run_in_flight" });

  answer = { status: 200, body: { deleted: "sch-1" } };
  await client.deleteSchedule(ORG, "sch-1");
  assert.equal(seen.at(-1)!.method, "DELETE");
});

test("webhook endpoints: the secret comes out of create and rotate, and out of nothing else", async () => {
  const endpoint = { id: "whe-1", name: "pd", path: "/api/intake/webhook/whe-1", secretVersion: 1 };
  answer = { status: 201, body: { endpoint, secret: "whsec_created" } };
  const created = await client.createWebhookEndpoint(ORG, { name: "pd", repositoryId: "repo-1" });
  assert.equal(created.secret, "whsec_created");
  assert.equal(seen[0]!.url, "https://api.test/v1/orgs/org-1/webhook-endpoints");

  answer = { status: 200, body: { endpoint: { ...endpoint, secretVersion: 2 }, secret: "whsec_rotated" } };
  const rotated = await client.rotateWebhookEndpoint(ORG, "whe-1");
  assert.equal(rotated.secret, "whsec_rotated");
  assert.equal(rotated.endpoint.secretVersion, 2);
  assert.equal(seen[1]!.url, "https://api.test/v1/orgs/org-1/webhook-endpoints/whe-1/rotate");

  answer = { status: 200, body: { endpoint: { ...endpoint, enabled: false }, secret: "whsec_should_not_travel" } };
  const updated = await client.updateWebhookEndpoint(ORG, "whe-1", { enabled: false });
  assert.ok(!JSON.stringify(updated).includes("whsec_"), "an update never returns a secret");

  answer = { status: 200, body: { items: [endpoint], endCursor: null, hasNextPage: false } };
  const list = await client.listWebhookEndpoints(ORG);
  assert.ok(!JSON.stringify(list).includes("whsec_"));

  assert.ok(seen.every((s) => !s.url.includes("whsec_")));

  answer = { status: 503, body: { error: "unset", code: "webhook_signing_unconfigured" } };
  await assert.rejects(client.createWebhookEndpoint(ORG, { name: "x", repositoryId: "r" }), { code: "webhook_signing_unconfigured" });
});

test("service principals and their tokens", async () => {
  answer.body = { items: [{ id: "sp-1", system: false }], endCursor: null, hasNextPage: false };
  assert.equal((await client.listServicePrincipals(ORG))[0]!.id, "sp-1");
  assert.equal(seen[0]!.url, "https://api.test/v1/orgs/org-1/service-principals");

  answer = { status: 201, body: { servicePrincipal: { id: "sp-2" } } };
  await client.createServicePrincipal(ORG, { name: "release-ci", role: "member" });
  assert.deepEqual(seen[1]!.body, { name: "release-ci", role: "member" });

  answer = { status: 201, body: { token: { id: "tok-1", prefix: "orq_ab" }, secret: "orq_value" } };
  const created = await client.createServiceToken(ORG, "sp-2", { name: "ci", preset: "execute", expiresAt: null });
  assert.equal(created.secret, "orq_value");
  assert.equal(seen[2]!.url, "https://api.test/v1/orgs/org-1/service-principals/sp-2/tokens");

  answer = { status: 200, body: { items: [{ id: "tok-1" }], endCursor: null, hasNextPage: false } };
  await client.listServiceTokens(ORG, "sp-2");
  answer = { status: 200, body: {} };
  await client.revokeServiceToken(ORG, "sp-2", "tok-1");
  await client.deleteServicePrincipal(ORG, "sp-2");
  assert.deepEqual(
    seen.slice(3).map((s) => `${s.method} ${s.url}`),
    [
      "GET https://api.test/v1/orgs/org-1/service-principals/sp-2/tokens",
      "DELETE https://api.test/v1/orgs/org-1/service-principals/sp-2/tokens/tok-1",
      "DELETE https://api.test/v1/orgs/org-1/service-principals/sp-2",
    ],
  );
});

test("an unreachable API and a gateway's HTML page are errors, not answers", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(client.listSchedules(ORG), { code: "unreachable" });
  globalThis.fetch = (async () => new Response("<html>502</html>", { status: 502 }));
  await assert.rejects(client.listSchedules(ORG), { code: "bad_gateway" });
});
