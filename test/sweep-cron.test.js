/**
 * The scheduler ADR-0015 lost when the worker container went (#200 step 2).
 *
 * `apps/worker` ran both sweeps on `setInterval`. ADR-0020 removes that container and nothing
 * replaced the timer, so on the deployed control plane evidence retention was never enforced and
 * no expired sandbox was ever reaped. Neither failure announces itself — storage grows, and a
 * forgotten sandbox bills until its own deadline — which is why the tests below are about the
 * *deployment artifact* as much as the handler: a cron that is not declared schedules nothing,
 * and looks exactly like one that is.
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

const OUTPUT = join(repoRoot, "apps/ingress/.vercel/output");
const built = existsSync(join(OUTPUT, "config.json"));
const skip = built ? false : "run `npm run -w @windkeel/ingress build:vercel` first";

test("the sweep is declared as a cron in the Build Output config", { skip }, () => {
  const config = JSON.parse(readFileSync(join(OUTPUT, "config.json"), "utf8"));
  const cron = (config.crons ?? []).find((c) => c.path === "/api/sweep");
  assert.ok(cron, "no cron declared for /api/sweep — nothing would ever run the sweeps");
  assert.match(cron.schedule, /^[\d*\/,\- ]+$/, "schedule must be a cron expression");
});

test("declaring the cron does not drop the routes that dispatch workflow messages", { skip }, () => {
  // The SDK writes these; overwriting `config.json` instead of merging would stop every run,
  // and the symptom would be "runs stopped starting" with nothing logged.
  const config = JSON.parse(readFileSync(join(OUTPUT, "config.json"), "utf8"));
  assert.ok(Array.isArray(config.routes) && config.routes.length > 0, "workflow routes were lost");
  assert.ok(
    config.routes.some((r) => String(r.dest ?? "").includes("workflow")),
    "the workflow webhook route is missing",
  );
});

test("the cron's function is actually emitted beside the webhook's", { skip }, () => {
  // A declared cron pointing at a path with no function is a scheduled 404.
  assert.ok(existsSync(join(OUTPUT, "functions/api/sweep.func/index.mjs")), "sweep.func missing");
  assert.ok(existsSync(join(OUTPUT, "functions/api/webhook.func/index.mjs")), "webhook.func missing");
});

test("the sweep gets more headroom than the webhook, because it deletes packages", { skip }, () => {
  const vc = (name) => JSON.parse(readFileSync(join(OUTPUT, `functions/api/${name}.func/.vc-config.json`), "utf8"));
  assert.ok(vc("sweep").maxDuration > vc("webhook").maxDuration);
});

/**
 * The route deletes evidence and destroys sandboxes, so the interesting cases are the refusals.
 * Each asserts the handler answers 401 *without* reaching a database — a sweep that authorised
 * itself after connecting would already have done the expensive, privileged part.
 */

import handler from "../apps/ingress/dist/api/sweep.js";

/** Minimal res double; records the status and body instead of writing them. */
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

test("an unauthenticated deployment refuses rather than defaulting to open", async () => {
  // CRON_SECRET unset. The tempting default — "nothing configured, so allow" — would expose a
  // route that destroys sandboxes to anyone who finds it.
  const out = await call({ authorization: "Bearer anything" }, undefined);
  assert.equal(out.code, 401);
  assert.deepEqual(out.body, { ok: false });
});

test("a wrong or missing bearer is refused, and learns nothing from the refusal", async () => {
  for (const headers of [{}, { authorization: "" }, { authorization: "Bearer wrong" }, { authorization: "sekret" }]) {
    const out = await call(headers, "sekret");
    assert.equal(out.code, 401, JSON.stringify(headers));
    // The body never says whether a secret is configured, nor how the value was wrong.
    assert.deepEqual(out.body, { ok: false });
  }
});

test("a bearer of the wrong length is rejected without throwing", async () => {
  // `timingSafeEqual` throws on a length mismatch; the length guard has to come first or every
  // short header would be a 500 instead of a 401.
  const out = await call({ authorization: "Bearer x" }, "a-much-longer-secret-value");
  assert.equal(out.code, 401);
});
