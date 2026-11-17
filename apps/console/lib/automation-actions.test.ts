import { test } from "node:test";
import assert from "node:assert/strict";
import * as actions from "./automation-actions.ts";
import type { AutomationsApi } from "./automations.ts";
import { ApiError } from "./http.ts";

type Call = { name: string; args: unknown[] };

function fakeApi(overrides: Partial<Record<keyof AutomationsApi, (...args: unknown[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const endpoint = { id: "whe-1", name: "pd", repositoryId: "repo-1", enabled: true, defaultRiskLevel: "low", secretVersion: 1, path: "/api/intake/webhook/whe-1", createdAt: "", rotatedAt: null };
  const defaults: Record<string, (...args: unknown[]) => unknown> = {
    connectIntegration: () => ({ id: "int-1", externalTenantId: "T1", externalTenantName: "Acme" }),
    createWebhookEndpoint: () => ({ endpoint, secret: "whsec_created" }),
    rotateWebhookEndpoint: () => ({ endpoint: { ...endpoint, secretVersion: 2 }, secret: "whsec_rotated" }),
    updateWebhookEndpoint: () => ({ ...endpoint, enabled: false, secret: "whsec_leak" }),
    createServiceToken: () => ({ token: { id: "tok-1" }, secret: "orq_service_value" }),
    fireSchedule: () => ({ accepted: true, taskId: "task-1", engineeringRunId: "run-1" }),
    previewSchedule: (_org: unknown, cron: unknown, timezone: unknown) => ({ cron, timezone, nextFireTimes: ["2026-09-26T03:00:00.000Z"] }),
  };
  const api = new Proxy({} as AutomationsApi, {
    get: (_t, name: string) =>
      async (...args: unknown[]) => {
        calls.push({ name, args });
        const fn = overrides[name as keyof AutomationsApi] ?? defaults[name];
        return fn ? fn(...args) : undefined;
      },
  });
  return { api, calls };
}

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) f.append(k, one);
  return f;
};

const refuse = (status: number, code: string, message = "api words") => () => {
  throw new ApiError(status, code, message);
};

test("creating a webhook endpoint returns its secret, once, and nothing else does", async () => {
  const { api, calls } = fakeApi();
  const created = await actions.createWebhook(api, "org-1", form({ name: "pd", repositoryId: "repo-1", defaultRiskLevel: "medium" }));
  assert.deepEqual(created, { ok: true, secret: "whsec_created" });
  assert.deepEqual(calls[0]!.args, ["org-1", { name: "pd", repositoryId: "repo-1", defaultRiskLevel: "medium" }]);

  const rotated = await actions.rotateWebhook(api, "org-1", "whe-1");
  assert.deepEqual(rotated, { ok: true, secret: "whsec_rotated" });

  const toggled = await actions.setWebhookEnabled(api, "org-1", "whe-1", false);
  assert.deepEqual(toggled, { ok: true });
  assert.ok(!JSON.stringify(toggled).includes("whsec_"), "an update never hands the form a secret");

  const removed = await actions.deleteWebhook(api, "org-1", "whe-1");
  assert.deepEqual(removed, { ok: true });
});

test("a refused create or rotate carries no secret, and says why in words", async () => {
  const { api } = fakeApi({ createWebhookEndpoint: refuse(503, "webhook_signing_unconfigured"), rotateWebhookEndpoint: refuse(404, "not_found", "webhook endpoint not found") });
  const created = await actions.createWebhook(api, "org-1", form({ name: "pd", repositoryId: "repo-1" }));
  assert.equal(created.ok, false);
  assert.ok(!("secret" in created));
  assert.match(created.ok ? "" : created.message, /WINDKEEL_WEBHOOK_SIGNING_KEY/);
  const rotated = await actions.rotateWebhook(api, "org-1", "whe-x");
  assert.deepEqual(rotated, { ok: false, message: "webhook endpoint not found" });
});

test("a service token's value comes back once; the scope never exceeds what the creator holds", async () => {
  const { api, calls } = fakeApi();
  const held = ["runs.read", "runs.write", "runs.approve", "tokens.manage"];
  const now = Date.parse("2026-09-25T00:00:00Z");
  const made = await actions.createServiceToken(api, "org-1", "sp-1", held, form({ name: "ci", preset: "execute", expiresInDays: "30" }), now);
  assert.deepEqual(made, { ok: true, secret: "orq_service_value" });
  assert.deepEqual(calls[0]!.args, ["org-1", "sp-1", { name: "ci", preset: "execute", expiresAt: "2026-10-25T00:00:00.000Z" }]);

  const never = await actions.createServiceToken(api, "org-1", "sp-1", held, form({ name: "ci", preset: "read", expiresInDays: "never" }), now);
  assert.equal(never.ok, true);
  assert.equal((calls[1]!.args[2] as { expiresAt: unknown }).expiresAt, null);

  const tooWide = await actions.createServiceToken(api, "org-1", "sp-1", held, form({ name: "ci", preset: "admin" }), now);
  assert.equal(tooWide.ok, false);
  assert.equal(calls.length, 2, "refused before the API is asked");

  const custom = await actions.createServiceToken(api, "org-1", "sp-1", held, form({ name: "ci", preset: "custom", permissions: ["runs.read", "members.manage"] }), now);
  assert.match(custom.ok ? "" : custom.message, /Manage members/);
  assert.equal((await actions.createServiceToken(api, "org-1", "sp-1", held, form({ preset: "read" }))).ok, false, "a name is required");
});

test("connecting a workspace: refusals in words, and input checked first", async () => {
  const claimed = fakeApi({ connectIntegration: refuse(409, "tenant_claimed") });
  const r1 = await actions.connectIntegration(claimed.api, "org-1", form({ provider: "slack", installationId: "icfg_1" }));
  assert.match(r1.ok ? "" : r1.message, /Another organization already has this workspace connected/);

  const missing = fakeApi({ connectIntegration: refuse(422, "integration_not_connected") });
  const r2 = await actions.connectIntegration(missing.api, "org-1", form({ provider: "linear", installationId: "icfg_2" }));
  assert.match(r2.ok ? "" : r2.message, /Vercel Connect has no usable installation/);

  const { api, calls } = fakeApi();
  assert.equal((await actions.connectIntegration(api, "org-1", form({ provider: "github", installationId: "x" }))).ok, false);
  assert.equal((await actions.connectIntegration(api, "org-1", form({ provider: "slack", installationId: "  " }))).ok, false);
  assert.equal(calls.length, 0);
  const ok = await actions.connectIntegration(api, "org-1", form({ provider: "slack", installationId: " icfg_1 " }));
  assert.deepEqual(ok, { ok: true, message: "Connected Acme." });
  assert.deepEqual(calls[0]!.args, ["org-1", { provider: "slack", installationId: "icfg_1" }]);
});

test("a route: default has no value, a scoped one needs one, and only its provider's scope", async () => {
  const { api, calls } = fakeApi();
  await actions.addRoute(api, "org-1", "int-1", "slack", form({ scopeKind: "default", scopeValue: "ignored", repositoryId: "repo-1", triggerLabel: "orqon", enabled: "on" }));
  assert.deepEqual(calls[0]!.args[2], { scopeKind: "default", scopeValue: null, repositoryId: "repo-1", triggerLabel: "orqon", enabled: true });

  await actions.addRoute(api, "org-1", "int-1", "slack", form({ scopeKind: "slack_channel", scopeValue: "C1", repositoryId: "repo-1", triggerLabel: "bot" }));
  assert.deepEqual(calls[1]!.args[2], { scopeKind: "slack_channel", scopeValue: "C1", repositoryId: "repo-1", triggerLabel: "bot", enabled: false });

  const noLabel = await actions.addRoute(api, "org-1", "int-1", "slack", form({ scopeKind: "default", repositoryId: "repo-1" }));
  assert.match(noLabel.ok ? "" : noLabel.message, /trigger label/);
  assert.equal(calls.length, 2);

  assert.equal((await actions.addRoute(api, "org-1", "int-1", "slack", form({ scopeKind: "slack_channel", repositoryId: "repo-1" }))).ok, false);
  assert.equal((await actions.addRoute(api, "org-1", "int-1", "slack", form({ scopeKind: "jira_project", scopeValue: "ENG", repositoryId: "r" }))).ok, false);
  assert.equal(calls.length, 2);

  const notGranted = fakeApi({ addIntegrationRoute: refuse(422, "repository_not_granted") });
  const r = await actions.addRoute(notGranted.api, "org-1", "int-1", "linear", form({ scopeKind: "linear_team", scopeValue: "ENG", repositoryId: "r", triggerLabel: "orqon" }));
  assert.match(r.ok ? "" : r.message, /isn't granted/);

  await actions.updateRoute(api, "org-1", "int-1", "rt-1", form({ repositoryId: "repo-2", triggerLabel: "bot" }));
  assert.deepEqual(calls.at(-1)!.args, ["org-1", "int-1", "rt-1", { repositoryId: "repo-2", triggerLabel: "bot", enabled: false }]);
});

test("schedules: the form is read and checked; fire says where its run is; preview answers times or words", async () => {
  const read = actions.scheduleInput(
    form({ name: " Nightly ", repositoryId: "repo-1", cron: "0  3 * * *", timezone: "", title: "t", description: "- [ ] x", riskLevel: "medium", enabled: "on" }),
  );
  assert.ok("input" in read);
  assert.deepEqual(read.input, { name: "Nightly", repositoryId: "repo-1", cron: "0 3 * * *", timezone: "UTC", title: "t", description: "- [ ] x", riskLevel: "medium", enabled: true });
  assert.ok("problem" in actions.scheduleInput(form({ name: "n", repositoryId: "r", cron: "", title: "t", description: "d" })));
  assert.ok("problem" in actions.scheduleInput(form({ name: "n", repositoryId: "r", cron: "* * * * *", title: "t", description: "d", riskLevel: "extreme" })));

  const { api, calls } = fakeApi();
  assert.deepEqual(await actions.fireSchedule(api, "org-1", "sch-1"), { ok: true, message: "Fired. Its run has started.", hrefLabel: "Open run", href: "/runs/run-1" });
  const busy = fakeApi({ fireSchedule: refuse(409, "run_in_flight") });
  const r = await actions.fireSchedule(busy.api, "org-1", "sch-1");
  assert.match(r.ok ? "" : r.message, /previous run is still going/);

  assert.deepEqual(await actions.previewCron(api, "org-1", " 0 3  * * * ", ""), { ok: true, times: ["2026-09-26T03:00:00.000Z"] });
  assert.deepEqual(calls.at(-1)!.args, ["org-1", "0 3 * * *", "UTC", 3]);
  const bad = fakeApi({ previewSchedule: refuse(422, "invalid_cron", "minute field: 61 is out of range") });
  assert.deepEqual(await actions.previewCron(bad.api, "org-1", "61 * * * *", "UTC"), { ok: false, message: "minute field: 61 is out of range" });
  assert.equal((await actions.previewCron(api, "org-1", "  ", "UTC")).ok, false);

  assert.deepEqual(await actions.setScheduleEnabled(api, "org-1", "sch-1", false), { ok: true });
  assert.deepEqual(calls.at(-1)!.args, ["org-1", "sch-1", { enabled: false }]);
});

test("a schedule switched off stays off when an edit form rendered earlier is saved", async () => {
  const row = { enabled: true, name: "Nightly" };
  const { api } = fakeApi({
    updateSchedule: (_org: unknown, _id: unknown, input: unknown) => Object.assign(row, input as object),
  });
  assert.deepEqual(await actions.setScheduleEnabled(api, "org-1", "sch-1", false), { ok: true });
  assert.equal(row.enabled, false);
  const stale = form({ name: "Nightly v2", repositoryId: "repo-1", cron: "0 3 * * *", timezone: "UTC", title: "t", description: "d", riskLevel: "low", enabled: "on" });
  assert.deepEqual(await actions.updateSchedule(api, "org-1", "sch-1", stale), { ok: true });
  assert.equal(row.name, "Nightly v2");
  assert.equal(row.enabled, false, "an edit never switches a schedule back on");

  const read = actions.scheduleInput(stale, "create");
  assert.ok("input" in read && read.input.enabled === true);
  const edit = actions.scheduleInput(stale, "edit");
  assert.ok("input" in edit && !("enabled" in edit.input));
});

test("sample mode's stand-in secret is flagged, so the panel can say so without guessing from the value", async () => {
  const { api } = fakeApi({
    createWebhookEndpoint: () => ({ endpoint: {}, secret: "whsec_x", sample: true }),
    createServiceToken: () => ({ token: {}, secret: "orq_x", sample: true }),
  });
  assert.deepEqual(await actions.createWebhook(api, "org-1", form({ name: "pd", repositoryId: "r" })), { ok: true, secret: "whsec_x", sample: true });
  const tok = await actions.createServiceToken(api, "org-1", "sp-1", ["runs.read", "runs.write"], form({ name: "ci", preset: "read" }));
  assert.deepEqual(tok, { ok: true, secret: "orq_x", sample: true });
  const live = fakeApi();
  assert.ok(!("sample" in (await actions.createWebhook(live.api, "org-1", form({ name: "pd", repositoryId: "r" })))));
});

test("anything that isn't an API refusal is not swallowed", async () => {
  const boom = fakeApi({
    deleteSchedule: () => {
      throw new Error("NEXT_REDIRECT");
    },
  });
  await assert.rejects(actions.deleteSchedule(boom.api, "org-1", "sch-1"), /NEXT_REDIRECT/);
});
