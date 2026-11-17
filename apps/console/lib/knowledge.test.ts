import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeClient, parseGlobs, riskLine, sourceLabel, sourceRunId } from "./knowledge.ts";

test("the client speaks the API's routes, organization-scoped", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const client = knowledgeClient(async (method, path, body) => {
    calls.push([method, path, body]);
    return {} as never;
  });
  await client.listNotes("org1", { repositoryId: "repo1", status: "suggested" });
  await client.listNotes("org1", { repositoryId: null });
  await client.createNote("org1", { title: "t", body: "b" });
  await client.updateNote("org1", "n1", { version: 2, body: "b2" });
  await client.setStatus("org1", "n1", "accept");
  await client.deleteNote("org1", "n1");
  await client.digest("org1", "repo1");
  await client.runKnowledge("org1", "run1");
  assert.deepEqual(
    calls.map(([m, p]) => `${m} ${p}`),
    [
      "GET /orgs/org1/knowledge?repositoryId=repo1&status=suggested",
      "GET /orgs/org1/knowledge?scope=organization",
      "POST /orgs/org1/knowledge",
      "POST /orgs/org1/knowledge/n1",
      "POST /orgs/org1/knowledge/n1/status",
      "POST /orgs/org1/knowledge/n1/delete",
      "GET /orgs/org1/repositories/repo1/digest",
      "GET /orgs/org1/runs/run1/knowledge",
    ],
  );
  assert.deepEqual(calls[4]?.[2], { action: "accept" });
});

test("a note's source and risk, in a reader's words", () => {
  const learned = { sourceKind: "verifier_finding" as const, sourceRef: { runId: "9f3c2a1b-0000-4000-8000-000000000000" }, risk: "high" as const, riskReasons: ["names a command to run"], status: "suggested" as const, createdBy: "orqon", updatedBy: "orqon", scope: "repository" as const };
  assert.equal(sourceLabel(learned), "Learned from run 9f3c2a1b");
  assert.equal(sourceRunId(learned), "9f3c2a1b-0000-4000-8000-000000000000");
  assert.equal(riskLine(learned), "Held for a person: names a command to run.");
  assert.equal(riskLine({ ...learned, risk: "low", riskReasons: [], status: "active" }), "Low risk: applied automatically. Delete it if it's wrong.");
  assert.equal(riskLine({ ...learned, risk: null }), null);
  assert.equal(sourceLabel({ ...learned, sourceKind: "human", createdBy: "alice", scope: "organization" }), "Organization note by alice");
  assert.deepEqual(parseGlobs("src/**, docs/*.md\n\n legacy/"), ["src/**", "docs/*.md", "legacy/"]);
});
