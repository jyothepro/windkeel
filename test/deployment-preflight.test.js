/**
 * The deployment reporting on **its own** configuration (#230).
 *
 * `windkeel doctor` validates the environment of whatever process it runs in, so from a laptop it
 * validates the laptop. Two incidents on 2026-09-18/19 were that gap: `CRON_SECRET` absent after
 * #226 shipped the sweep route, so every hourly tick 401'd silently; and the App's webhook
 * pointing at a project that did not exist. Neither was discoverable before it cost something.
 *
 * As with `sweep-cron.test.js`, the deployment *artifact* is as much the subject as the handler:
 * this project builds through the Build Output API, so a route that the build script does not
 * emit does not exist, however correct its source file is.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import handler from "../apps/ingress/dist/api/preflight.js";
import {
  DEPLOYED_VARIABLES,
  runDeploymentPreflight,
  scrubSecrets,
} from "../dist/factory/deployment-preflight.js";
import { repoRoot } from "./helpers.js";

const OUTPUT = join(repoRoot, "apps/ingress/.vercel/output");
const built = existsSync(join(OUTPUT, "config.json"));
const skip = built ? false : "run `npm run -w @windkeel/ingress build:vercel` first";

// --- the artifact -----------------------------------------------------------------------------

test("the preflight function is emitted by the build script", { skip }, () => {
  assert.ok(
    existsSync(join(OUTPUT, "functions/api/preflight.func/index.mjs")),
    "preflight.func missing — a file in api/ is not a route under the Build Output API",
  );
});

test("emitting it drops no existing function and no existing route", { skip }, () => {
  // A regression here is catastrophic and silent, which is why sweep-cron.test.js asserts the
  // same thing about the sweep: losing the SDK's routes stops every run, with nothing logged.
  for (const name of ["webhook", "sweep", "preflight"]) {
    assert.ok(existsSync(join(OUTPUT, `functions/api/${name}.func/index.mjs`)), `${name}.func`);
  }

  const config = JSON.parse(readFileSync(join(OUTPUT, "config.json"), "utf8"));
  assert.ok(
    config.routes.some((r) => String(r.dest ?? "").includes("workflow")),
    "the workflow dispatch route was lost",
  );
  assert.ok(
    (config.crons ?? []).some((c) => c.path === "/api/sweep"),
    "the sweep cron was lost",
  );
});

test("the preflight is asked, never scheduled", { skip }, () => {
  const config = JSON.parse(readFileSync(join(OUTPUT, "config.json"), "utf8"));
  assert.ok(
    !(config.crons ?? []).some((c) => c.path === "/api/preflight"),
    "a preflight on a timer produces a log nobody reads; it answers a question an operator has",
  );
});

// --- authorisation ----------------------------------------------------------------------------

function fakeRes() {
  const out = {};
  const res = {
    status(code) {
      out.code = code;
      return res;
    },
    json(body) {
      out.body = body;
    },
  };
  return { res, out };
}

async function call(headers, secret) {
  const previous = process.env.CRON_SECRET;
  if (secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secret;
  const { res, out } = fakeRes();
  try {
    await handler({ headers }, res);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
  return out;
}

/**
 * The refusals are the interesting cases, and each asserts 401 *before any database connection*.
 * `DATABASE_URL` below points at a host that does not resolve, so a handler that connected first
 * would hang or throw rather than answering 401 — which is what makes this an assertion about
 * ordering rather than a restatement of the status code.
 */
const UNREACHABLE_DB = "postgresql://u:p@preflight-must-not-connect.invalid:5432/x";

test("a missing CRON_SECRET is 401, not 200 — the route fails closed", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = UNREACHABLE_DB;
  try {
    const out = await call({ authorization: "Bearer anything" }, undefined);
    assert.equal(out.code, 401);
    assert.deepEqual(out.body, { ok: false });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("an unauthorised request is refused before any database connection is attempted", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = UNREACHABLE_DB;
  try {
    const started = Date.now();
    const out = await call({ authorization: "Bearer wrong-value-here" }, "the-real-secret-value");
    assert.equal(out.code, 401);
    assert.deepEqual(out.body, { ok: false });
    assert.ok(
      Date.now() - started < 1000,
      "the refusal took long enough to have tried to connect to an unresolvable host",
    );
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("a bearer of the wrong length is rejected without throwing", async () => {
  // `timingSafeEqual` throws on a length mismatch, so the length guard has to come first.
  const out = await call({ authorization: "Bearer x" }, "a-much-longer-secret-value");
  assert.equal(out.code, 401);
});

test("the refusal teaches an unauthorised caller nothing about what is configured", async () => {
  for (const headers of [{}, { authorization: "" }, { authorization: "Bearer wrong" }]) {
    const out = await call(headers, "sekret-value-long-enough");
    assert.deepEqual(out.body, { ok: false }, JSON.stringify(headers));
  }
});

// --- the report ---------------------------------------------------------------------------------

/**
 * A **multi-line** private key, because that is what the deployment actually holds.
 *
 * `docs/github-app.md` accepts a raw PEM, a PEM with `\n` escapes, or base64 of one. The raw
 * form is the interesting one here: JSON encodes each newline as `\n`, so a scrubber searching
 * the serialised body for the verbatim value finds nothing. This sentinel was single-line until
 * #230 review, and the gap it hid was the App's own identity appearing in a response.
 */
const SENTINEL_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "sentinel-private-key-line-one-3a9c",
  "sentinel-private-key-line-two-7b21",
  "-----END PRIVATE KEY-----",
].join("\n");

const SENTINELS = {
  DATABASE_URL: "postgresql://windkeel:sentinel-db-password-8f21@db.invalid:5432/windkeel",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: SENTINEL_PEM,
  GITHUB_WEBHOOK_SECRET: "sentinel-webhook-secret-71bd",
  OPENAI_API_KEY: "sentinel-openai-key-4e02",
  S3_ACCESS_KEY_ID: "sentinel-s3-access-2d40",
  S3_SECRET_ACCESS_KEY: "sentinel-s3-secret-6b18",
  VERCEL_TOKEN: "sentinel-vercel-token-0af3",
};

/** Never reaches the network: every check below is expected to fail or skip on its own terms. */
const offline = async () => {
  throw new Error("preflight test: no network");
};

test("CRON_SECRET's absence is reported, which is the incident this exists for", async () => {
  const report = await runDeploymentPreflight({ env: { ...SENTINELS }, fetchImpl: offline });
  const cron = report.checks.find((c) => c.id === "cron-secret");

  assert.equal(cron.status, "fail");
  assert.match(cron.summary, /CRON_SECRET is not set/);
  assert.ok(cron.details.some((d) => /hourly tick .* will 401/.test(d)));
  assert.equal(report.ok, false);
  // And in the variable inventory too, so it is visible without reading every check.
  assert.equal(report.variables.find((v) => v.name === "CRON_SECRET").present, false);
});

test("CRON_SECRET present is reported as present, and passes", async () => {
  const report = await runDeploymentPreflight({
    env: { ...SENTINELS, CRON_SECRET: "a-configured-cron-secret" },
    fetchImpl: offline,
  });

  assert.equal(report.checks.find((c) => c.id === "cron-secret").status, "pass");
  assert.equal(report.variables.find((v) => v.name === "CRON_SECRET").present, true);
});

test("a missing variable is reported as missing, and never as a value", async () => {
  const report = await runDeploymentPreflight({
    env: { DATABASE_URL: SENTINELS.DATABASE_URL },
    fetchImpl: offline,
  });

  const absent = report.variables.filter((v) => !v.present).map((v) => v.name);
  assert.ok(absent.includes("GITHUB_APP_ID"));
  assert.ok(absent.includes("S3_BUCKET"));
  for (const variable of report.variables) {
    assert.equal(typeof variable.present, "boolean");
    assert.ok("purpose" in variable, `${variable.name} should say why the deployed path wants it`);
    if (!variable.present) assert.equal(variable.length, undefined);
  }
});

test("every variable the deployed path reads is on the list", async () => {
  const names = DEPLOYED_VARIABLES.map((v) => v.name);
  // The four `deployable-env-contract.test.js` proves the ingress will not initialise without,
  // plus the one #226 added and nothing checked.
  for (const required of [
    "DATABASE_URL",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "CRON_SECRET",
  ]) {
    assert.ok(names.includes(required), `${required} is not reported by the preflight`);
  }
});

/**
 * Asserted, not merely avoided. Every check is written not to include a value; this proves the
 * property of the rendered body, which is what actually leaves the deployment.
 */
test("no secret value can appear in the response", async () => {
  const env = { ...SENTINELS, CRON_SECRET: "sentinel-cron-secret-aa11" };
  const report = scrubSecrets(await runDeploymentPreflight({ env, fetchImpl: offline }), env);
  const rendered = JSON.stringify(report);

  for (const [name, value] of Object.entries(env)) {
    assert.ok(!rendered.includes(value), `${name}'s value appears in the response`);
  }
  // The password alone, which is how a connection string escapes through a driver's error.
  assert.ok(!rendered.includes("sentinel-db-password-8f21"));
  assert.ok(!rendered.includes("sentinel-cron-secret-aa11"));
});

test("a value that arrives by an unanticipated path is still scrubbed", async () => {
  const env = { ...SENTINELS, CRON_SECRET: "sentinel-cron-secret-aa11" };
  // The shape of the failure mode: a driver error quoting the connection string verbatim.
  const smuggled = {
    ok: false,
    deployment: { id: null, url: null, environment: null, region: null },
    variables: [],
    checks: [{ id: "database", status: "fail", summary: "x", details: [env.DATABASE_URL] }],
  };

  const rendered = JSON.stringify(scrubSecrets(smuggled, env));
  assert.ok(!rendered.includes("sentinel-db-password-8f21"));
  assert.match(rendered, /\[redacted\]/);
});

/**
 * The regression for the gap the multi-line sentinel above exists to expose.
 *
 * Asserted per *line* rather than on the whole value: a scrubber that redacted only the first
 * line, or only the PEM header, would still leak key material, and a single `includes` on the
 * joined string would pass while it did.
 */
test("a multi-line secret is scrubbed even though JSON escapes its newlines", () => {
  const env = { ...SENTINELS };
  // The shape of the failure mode: a GitHub client error quoting the key it was handed.
  const smuggled = {
    ok: false,
    deployment: { id: null, url: null, environment: null, region: null },
    variables: [],
    checks: [
      { id: "github-app", status: "fail", summary: "x", details: [`key was ${SENTINEL_PEM}`] },
    ],
  };

  const rendered = JSON.stringify(scrubSecrets(smuggled, env));
  for (const line of SENTINEL_PEM.split("\n")) {
    if (line.length < 8) continue;
    assert.ok(!rendered.includes(line), `a line of the private key survived scrubbing: ${line}`);
  }
  assert.match(rendered, /\[redacted\]/);
});

/**
 * Pins behaviour that currently holds *by accident* rather than fixing a bug: the connection
 * string is registered before its password, and a `Set` iterates in insertion order, so the
 * longer value happens to be substituted first today. Reorder the registration and the password
 * goes first, leaving host, user and database name in the body. `scrubSecrets` now sorts by
 * length explicitly; this is what stops that being silently undone.
 */
test("a value containing another is redacted whole, not hollowed out", () => {
  const env = { ...SENTINELS };
  const smuggled = {
    ok: false,
    deployment: { id: null, url: null, environment: null, region: null },
    variables: [],
    checks: [{ id: "database", status: "fail", summary: "x", details: [env.DATABASE_URL] }],
  };

  const rendered = JSON.stringify(scrubSecrets(smuggled, env));
  assert.ok(!rendered.includes("db.invalid"), "the host survived, so the URL was only partly cut");
  assert.ok(!rendered.includes("sentinel-db-password-8f21"));
});

test("the report names which deployment answered", async () => {
  const report = await runDeploymentPreflight({
    env: { ...SENTINELS, VERCEL_DEPLOYMENT_ID: "dpl_123", VERCEL_ENV: "preview" },
    fetchImpl: offline,
  });

  assert.equal(report.deployment.id, "dpl_123");
  assert.equal(report.deployment.environment, "preview");
});

test("an unreachable database is a failure, not an exception", async () => {
  const report = await runDeploymentPreflight({
    env: { ...SENTINELS, DATABASE_URL: UNREACHABLE_DB, CRON_SECRET: "x-configured-secret" },
    fetchImpl: offline,
  });

  const database = report.checks.find((c) => c.id === "database");
  assert.equal(database.status, "fail");
  assert.equal(report.ok, false);
});

test("the inventory reports the sandbox variables a deployment actually requires (ORQ-14)", async () => {
  const report = await runDeploymentPreflight({
    env: { ...SENTINELS, WINDKEEL_SANDBOX_TOKEN: "t", WINDKEEL_SANDBOX_TEAM_ID: "team", WINDKEEL_SANDBOX_PROJECT_ID: "prj" },
    fetchImpl: offline,
  });
  for (const name of ["WINDKEEL_SANDBOX_TOKEN", "WINDKEEL_SANDBOX_TEAM_ID", "WINDKEEL_SANDBOX_PROJECT_ID"]) {
    assert.equal(report.variables.find((v) => v.name === name)?.present, true, name);
  }
  // The platform injects VERCEL_PROJECT_ID into every deployment, so listing it says nothing.
  assert.equal(report.variables.find((v) => v.name === "VERCEL_PROJECT_ID"), undefined);
});

test("#389: the integration switches are reported, optional, and never a failure or a value", async () => {
  const offlineFetch = async () => {
    throw new Error("offline");
  };
  const off = await runDeploymentPreflight({ env: {}, fetchImpl: offlineFetch });
  const none = off.checks.find((c) => c.id === "integrations");
  assert.equal(none.status, "skip");
  for (const name of ["WINDKEEL_CONNECT_SLACK", "WINDKEEL_CONNECT_LINEAR", "WINDKEEL_CONNECT_JIRA", "WINDKEEL_CONNECT_SENTRY", "WINDKEEL_SENTRY_CLIENT_SECRET"]) {
    assert.equal(off.variables.find((v) => v.name === name)?.present, false, name);
  }
  const secret = "sentry-client-secret-0123456789abcdef";
  const on = await runDeploymentPreflight({ env: { WINDKEEL_SENTRY_CLIENT_SECRET: secret, WINDKEEL_CONNECT_SENTRY: "sealed" }, fetchImpl: offlineFetch });
  const check = on.checks.find((c) => c.id === "integrations");
  assert.equal(check.status, "pass");
  assert.match(check.summary, /Sentry intake/);
  assert.ok(!JSON.stringify(scrubSecrets(on, { WINDKEEL_SENTRY_CLIENT_SECRET: secret })).includes(secret));
});

test("billing: the fake by default passes; stripe with a key missing fails by name, and no Stripe value leaks (#394)", async () => {
  const fake = await runDeploymentPreflight({ env: { ...SENTINELS, CRON_SECRET: "a-configured-cron-secret" }, fetchImpl: offline });
  assert.equal(fake.checks.find((c) => c.id === "billing").status, "pass");

  const env = { ...SENTINELS, WINDKEEL_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_sentinel_stripe_9c1d" };
  const report = scrubSecrets(await runDeploymentPreflight({ env, fetchImpl: offline }), env);
  const billing = report.checks.find((c) => c.id === "billing");
  assert.equal(billing.status, "fail");
  assert.match(billing.details.join(" "), /STRIPE_WEBHOOK_SECRET, STRIPE_METER_EVENT_NAME, STRIPE_PRICE_ID/);
  assert.equal(report.ok, false);
  assert.equal(report.variables.find((v) => v.name === "STRIPE_SECRET_KEY").present, true);
  assert.equal(report.variables.find((v) => v.name === "STRIPE_PRICE_ID").present, false, "#439: the metered price is listed with the other Stripe variables");
  assert.ok(!JSON.stringify(report).includes("sk_test_sentinel_stripe_9c1d"));
});
