import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResponse, validatingResponses } from "../apps/ingress/dist/src/api/validate.js";

test("the suite runs with response validation on", () => {
  assert.equal(validatingResponses(), true);
});

test("a 2xx body that matches its route's schema is sent unchanged", async () => {
  const result = { status: 200, body: { ok: true, database: "reachable", schema: "current" } };
  assert.equal(await validateResponse("health", result), result);
});

test("a 2xx body that drifts from the contract becomes 500 contract_violation naming the path", async () => {
  const answer = await validateResponse("setMerging", { status: 200, body: { allowMerge: "yes" } });
  assert.equal(answer.status, 500);
  assert.equal(answer.body.code, "contract_violation");
  assert.deepEqual(answer.body.issues.map((i) => i.path), ["allowMerge"]);
});

test("dates are checked as they go on the wire, as strings", async () => {
  const body = { items: [], endCursor: null, hasNextPage: false, organizationId: "o", at: new Date() };
  assert.equal((await validateResponse("runChanges", { status: 200, body })).status, 200);
});

test("refusals, files and redirects are not parsed", async () => {
  const refusal = { status: 404, body: { error: "no such run", code: "not_found" } };
  assert.equal(await validateResponse("run", refusal), refusal);
  const csv = { status: 200, body: null, raw: "a,b\n" };
  assert.equal(await validateResponse("auditExport", csv), csv);
  const png = { status: 200, body: Buffer.from([1, 2, 3]) };
  assert.equal(await validateResponse("runScreenshotFile", png), png);
  const redirect = { status: 302, body: { url: "https://x" } };
  assert.equal(await validateResponse("runEvidenceFile", redirect), redirect);
});
