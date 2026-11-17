// The shared /v1 contract (@windkeel/api-contract): its schemas accept the shapes the API really sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BatchDetailSchema,
  ErrorBodySchema,
  EventPageSchema,
  RepositorySummarySchema,
  RunSummarySchema,
  TaskSchema,
  pageSchema,
} from "../packages/api-contract/dist/index.js";

const run = {
  id: "run_1",
  createdAt: "2026-10-01T00:00:00.000Z",
  taskId: "task_1",
  taskTitle: "Fix the flaky login test",
  repositoryId: "repo_1",
  status: "PR_READY",
  terminal: false,
  finalVerdict: "pass",
  stopReason: null,
  cost: 1.25,
  spendCapUsd: 10,
  startedAt: "2026-10-01T00:00:01.000Z",
  completedAt: null,
  prNumber: 42,
  prMergedAt: null,
};

test("a refusal body parses, keeping its extra fields", () => {
  const body = ErrorBodySchema.parse({ error: "this token lacks runs:write", code: "forbidden", missing: "runs:write" });
  assert.equal(body.code, "forbidden");
  assert.equal(body.missing, "runs:write");
  assert.equal(ErrorBodySchema.safeParse({ message: "no code" }).success, false);
});

test("a runs page parses; a wrong run state is refused", () => {
  const page = pageSchema(RunSummarySchema).parse({ items: [run], endCursor: "c1", hasNextPage: true });
  assert.equal(page.items[0].status, "PR_READY");
  assert.equal(pageSchema(RunSummarySchema).safeParse({ items: [{ ...run, status: "DANCING" }], endCursor: null, hasNextPage: false }).success, false);
});

test("repositories, tasks, events and batches parse", () => {
  RepositorySummarySchema.parse({ id: "repo_1", createdAt: run.createdAt, fullName: "acme/app", defaultBranch: "main", openRuns: 2 });
  const criteria = [{ id: "c1", text: "The test passes ten times in a row" }];
  TaskSchema.parse({
    id: "task_1",
    repositoryId: "repo_1",
    sourceType: "github_issue",
    sourceReference: "acme/app#7",
    title: "Fix the flaky login test",
    description: "",
    acceptanceCriteria: criteria,
    criteriaProvenance: "extracted",
    criteriaGeneratedBy: null,
    criteriaApprovedBy: null,
    criteriaApprovedAt: null,
    riskLevel: "low",
    priority: null,
    status: "OPEN",
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    criteria: { provenance: "extracted", generatedBy: null, approvedBy: null, approvedAt: null, items: criteria },
  });
  EventPageSchema.parse({
    items: [
      { kind: "transition", cursor: "1", at: run.createdAt, from: null, to: "CREATED", reason: null },
      { kind: "cost", cursor: "2", at: run.createdAt, usd: null, costKind: "model", stageType: "maker" },
      { kind: "agent", cursor: "3", at: run.createdAt, agentRunId: "ar_1", role: "maker", event: { type: "command_finished", command: "npm test", exitCode: 0, output: "ok" } },
    ],
    endCursor: "3",
    hasNextPage: false,
    runStatus: "IMPLEMENTING",
    terminal: false,
  });
  BatchDetailSchema.parse({
    batch: {
      id: "batch_1",
      kind: "fanout",
      title: "Bump lodash",
      description: "",
      maxConcurrency: 2,
      batchSpendCapUsd: null,
      stopOnFailureRatio: null,
      status: "RUNNING",
      stopReason: null,
      createdAt: run.createdAt,
      completedAt: null,
      progress: {
        items: 1, pending: 0, dispatched: 1, skipped: 0, active: 1, settled: 0, succeeded: 0, failed: 0,
        byStatus: { IMPLEMENTING: 1 }, verdicts: { pass: 0, warn: 0, fail: 0, none: 1 },
        totalCostUsd: 0, reservedUsd: 5, remainingBudgetUsd: null,
      },
    },
    items: [{
      id: "bi_1", ordinal: 0, repositoryId: "repo_1", repositoryFullName: "acme/app", state: "dispatched", skipReason: null,
      title: null, runId: "run_1", runStatus: "IMPLEMENTING", finalVerdict: null, costUsd: 0, pullRequestNumber: null, pullRequestUrl: null,
    }],
  });
});
