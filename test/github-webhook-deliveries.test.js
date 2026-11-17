/**
 * #229: whether anything the GitHub App sends actually arrives.
 *
 * On 2026-09-18 the App's webhook pointed at `https://windkeel-ingress.vercel.app/api/webhook`, a
 * Vercel project that does not exist. Every delivery 404'd for roughly a day; labelling an issue
 * with `windkeel` did nothing, repeatedly, and produced no signal anywhere. `windkeel doctor` was green
 * throughout, because every component it checked was healthy and the message was going somewhere
 * else. It was found by opening the App's *Advanced → Recent Deliveries* tab.
 *
 * The API is mocked. The endpoints need the App's own JWT and no extra permission, so there is
 * nothing here that requires live credentials — and this repository already carries seven
 * credential-gated tests, which is seven more than something mockable should add to.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { checkWebhookDeliveries, DELIVERY_SAMPLE } from "../dist/github/app-deliveries.js";

/** A real key, because `createAppJwt` signs with it — a placeholder would fail for the wrong reason. */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONFIG = {
  credentials: {
    appId: "123456",
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  },
  webhookSecret: undefined,
  installationId: undefined,
  baseUrl: "https://api.github.com",
};

const HOOK_URL = "https://windkeel-ingress.vercel.app/api/webhook";

/** Answers the two endpoints the check reads, and records what it was asked for. */
function stubGitHub({ deliveries, hookUrl = HOOK_URL, deliveriesStatus = 200, configStatus = 200 }) {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, headers: init?.headers ?? {} });
    if (url.includes("/app/hook/config")) {
      return {
        status: configStatus,
        // The real payload carries `secret` alongside `url`; planted here so a test can prove
        // the check never carries it into a report.
        json: async () => ({ url: hookUrl, secret: "sentinel-webhook-secret-71bd" }),
      };
    }
    return { status: deliveriesStatus, json: async () => deliveries };
  };
  return { fetchImpl, requested };
}

const delivery = (status_code, status, extra = {}) => ({
  id: Math.floor(status_code * 1000 + Math.random() * 999),
  status_code,
  status,
  event: "issues",
  delivered_at: "2026-09-18T10:00:00Z",
  ...extra,
});

const ok = (n) => Array.from({ length: n }, () => delivery(200, "OK"));

test("all recent deliveries succeeded — pass, with the URL still reported", async () => {
  const { fetchImpl } = stubGitHub({ deliveries: ok(12) });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "pass");
  assert.match(verdict.summary, /all 12 recent deliveries were accepted/);
  // On every outcome, not only failures: in the incident, seeing the URL ended the investigation.
  assert.ok(verdict.details.some((d) => d.includes(HOOK_URL)));
});

/**
 * The exact incident, and the single most important test in this file.
 */
test("every delivery 404 is a failure, and the message names the configured webhook URL", async () => {
  const { fetchImpl } = stubGitHub({
    deliveries: Array.from({ length: 18 }, () => delivery(404, "Not Found")),
  });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "fail");
  assert.match(verdict.summary, /all 18 recent deliveries failed/);
  assert.ok(
    verdict.details.some((d) => d.includes(HOOK_URL)),
    `the URL is the whole diagnosis and is missing: ${JSON.stringify(verdict.details)}`,
  );
  assert.ok(verdict.details.some((d) => /404 Not Found \(18×\)/.test(d)));
  // Why nothing else reported it, which is the part an operator does not otherwise learn.
  assert.ok(verdict.details.some((d) => /no run, no.*error and no alert/s.test(d)));
});

/**
 * A freshly installed App that has never been triggered is indistinguishable from a broken one at
 * the delivery level. The object-store check reads its own write back for the same reason — an
 * empty answer must not be allowed to read as a healthy one.
 */
test("no deliveries at all is nothing to judge — neither pass nor fail", async () => {
  const { fetchImpl } = stubGitHub({ deliveries: [] });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "skip");
  assert.notEqual(verdict.status, "pass");
  assert.notEqual(verdict.status, "fail");
  assert.match(verdict.summary, /nothing to judge/);
  assert.ok(verdict.details.some((d) => d.includes(HOOK_URL)));
});

/**
 * The ingress deliberately returns non-2xx for some payloads (`docs/webhook-ingress.md`: 400 for
 * a malformed body, 401 for a bad signature, 500 retried). A check that fired on one of those
 * would be a permanent false alarm, and an operator would mute it.
 */
test("a mix of successes and one failure is not a failure", async () => {
  const { fetchImpl } = stubGitHub({
    deliveries: [...ok(9), delivery(500, "Internal Server Error")],
  });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "pass");
  assert.match(verdict.summary, /9 of 10 recent deliveries succeeded/);
  // Still surfaced, because "mostly working" is worth seeing — it is just not a broken trigger.
  assert.ok(verdict.details.some((d) => /500 Internal Server Error \(1×\)/.test(d)));
});

/**
 * The systematic failure this is really for, in its other shape: the trigger is reachable and
 * every delivery is rejected. A uniform 401 is a mismatched `GITHUB_WEBHOOK_SECRET`, which is
 * why 400 and 401 are not counted as healthy even though the ingress returns them on purpose.
 */
test("a uniformly rejected history fails even though 401 is a documented response", async () => {
  const { fetchImpl } = stubGitHub({
    deliveries: Array.from({ length: 7 }, () => delivery(401, "Unauthorized")),
  });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "fail");
  assert.ok(verdict.details.some((d) => /401 Unauthorized \(7×\)/.test(d)));
});

test("a delivery that never reached a server is described as that, not as a status code", async () => {
  const { fetchImpl } = stubGitHub({
    deliveries: Array.from({ length: 4 }, () => delivery(0, null)),
  });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "fail");
  assert.ok(verdict.details.some((d) => /never reached a server/.test(d)));
  assert.ok(!verdict.details.some((d) => /\b0 \(/.test(d)), "a bare 0 explains nothing");
});

test("the webhook secret is never carried into the report", async () => {
  const { fetchImpl } = stubGitHub({ deliveries: ok(3) });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  const rendered = JSON.stringify(verdict);
  assert.ok(
    !rendered.includes("sentinel-webhook-secret-71bd"),
    "GET /app/hook/config returns the secret beside the URL; only the URL may be read",
  );
});

test("the App's own JWT authenticates both calls, and no installation token is involved", async () => {
  const { fetchImpl, requested } = stubGitHub({ deliveries: ok(2) });
  await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(requested.length, 2);
  assert.ok(requested.some((r) => r.url.endsWith("/app/hook/config")));
  assert.ok(requested.some((r) => r.url.includes(`/app/hook/deliveries?per_page=${DELIVERY_SAMPLE}`)));
  for (const { headers } of requested) {
    // `Bearer <jwt>` — three base64url segments. An installation token would be `token ghs_…`.
    assert.match(headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  }
});

test("an endpoint that will not answer is unknown, never a pass and never a failure", async () => {
  const forbidden = await checkWebhookDeliveries(
    CONFIG,
    stubGitHub({ deliveries: [], deliveriesStatus: 403 }).fetchImpl,
  );
  assert.equal(forbidden.status, "skip");
  assert.match(forbidden.summary, /answered 403/);

  const unreachable = await checkWebhookDeliveries(CONFIG, async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  });
  assert.equal(unreachable.status, "skip");
  assert.match(unreachable.summary, /could not be reached/);
});

test("an unreadable hook config does not fail the check — the deliveries are the evidence", async () => {
  const { fetchImpl } = stubGitHub({ deliveries: ok(5), configStatus: 404 });
  const verdict = await checkWebhookDeliveries(CONFIG, fetchImpl);

  assert.equal(verdict.status, "pass");
  assert.ok(verdict.details.some((d) => /could not be read/.test(d)));
});
