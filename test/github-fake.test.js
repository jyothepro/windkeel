import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ForkRefusedError,
  GitHubApiError,
  NotFoundError,
  PermissionDeniedError,
  RefusedOperationError,
} from "../dist/github/client.js";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { CONFORMANCE_SEED, runGitHubConformanceSuite } from "./github-conformance.js";

const REPOSITORY = { owner: CONFORMANCE_SEED.owner, name: CONFORMANCE_SEED.name };
const FORK = { owner: CONFORMANCE_SEED.owner, name: "windkeel-fixture-fork" };

function makeClient(options = {}) {
  return new FakeGitHubClient(
    {
      repositories: [CONFORMANCE_SEED, { ...CONFORMANCE_SEED, name: FORK.name, fork: true }],
    },
    options,
  );
}

runGitHubConformanceSuite("FakeGitHubClient", async () => {
  const client = makeClient();
  return {
    client,
    repository: REPOSITORY,
    forkRepository: FORK,
    injectFailure: (method, failure) => client.injectFailure(method, failure),
  };
});

// --- Fake-specific behaviour: recording, injection, refusals, and the mid-run permission loss ---

test("every call is recorded in order, so sequencing can be asserted above the seam", async () => {
  const client = makeClient();
  await client.getIssue(REPOSITORY, 7);
  const check = await client.createCheckRun({
    repository: REPOSITORY,
    headSha: "e".repeat(40),
    name: "windkeel/verification",
    status: "in_progress",
  });
  await client.createIssueComment(REPOSITORY, 7, "run started");
  await client.updateCheckRun({
    repository: REPOSITORY,
    checkRunId: check.id,
    status: "completed",
    conclusion: "success",
  });

  assert.deepEqual(
    client.calls.map((c) => c.type),
    ["getIssue", "createCheckRun", "createIssueComment", "updateCheckRun"],
  );
  assert.equal(client.calls[2].body, "run started");
});

test("a check run updated twice on one head SHA stays a single check run", async () => {
  const client = makeClient();
  const headSha = "f".repeat(40);
  const created = await client.createCheckRun({
    repository: REPOSITORY,
    headSha,
    name: "windkeel/verification",
    status: "queued",
  });
  await client.updateCheckRun({
    repository: REPOSITORY,
    checkRunId: created.id,
    status: "in_progress",
  });
  await client.updateCheckRun({
    repository: REPOSITORY,
    checkRunId: created.id,
    status: "completed",
    conclusion: "failure",
  });

  const runs = client.checkRunsFor(REPOSITORY, headSha);
  assert.equal(runs.length, 1, "re-verification updates the check, it does not add one");
  assert.equal(runs[0].conclusion, "failure");
});

test("a completed check run without a conclusion is refused, as GitHub refuses it", async () => {
  const client = makeClient();
  await assert.rejects(
    () =>
      client.createCheckRun({
        repository: REPOSITORY,
        headSha: "1".repeat(40),
        name: "windkeel/verification",
        status: "completed",
      }),
    GitHubApiError,
  );
  await assert.rejects(
    () =>
      client.createCheckRun({
        repository: REPOSITORY,
        headSha: "2".repeat(40),
        name: "windkeel/verification",
        status: "queued",
        conclusion: "success",
      }),
    GitHubApiError,
  );
});

test("injectFailure with a count fails exactly that many calls, then behaves", async () => {
  const client = makeClient();
  client.injectFailure("getIssue", { kind: "rateLimited" }, { count: 2 });
  await assert.rejects(() => client.getIssue(REPOSITORY, 7));
  await assert.rejects(() => client.getIssue(REPOSITORY, 7));
  const issue = await client.getIssue(REPOSITORY, 7);
  assert.equal(issue.number, 7);
});

test("injectFailure('*') fails the next call whatever it is", async () => {
  const client = makeClient();
  client.injectFailure("*", { kind: "notFound" });
  await assert.rejects(() => client.getRepository(REPOSITORY), NotFoundError);
  const repository = await client.getRepository(REPOSITORY);
  assert.equal(repository.name, CONFORMANCE_SEED.name);
});

test("revokePermission models a permission lost mid-run: one method fails, the rest work", async () => {
  const client = makeClient();
  const before = await client.getRepository(REPOSITORY);
  assert.equal(before.permissions.checks, "write");

  client.revokePermission(REPOSITORY, "checks");

  // ADR-0009 §6: the run has to be able to see this and fail with a recorded reason.
  const after = await client.getRepository(REPOSITORY);
  assert.equal(after.permissions.checks, undefined);
  await assert.rejects(
    () =>
      client.createCheckRun({
        repository: REPOSITORY,
        headSha: "3".repeat(40),
        name: "windkeel/verification",
        status: "queued",
      }),
    (error) => {
      assert.ok(error instanceof PermissionDeniedError);
      assert.equal(error.permission, "checks");
      return true;
    },
  );
  const issue = await client.getIssue(REPOSITORY, 7);
  assert.equal(issue.number, 7, "everything else still works");
});

test("a token cannot ask for more than the installation was granted", async () => {
  const client = makeClient();
  client.revokePermission(REPOSITORY, "contents");
  client.seedRepository({
    ...CONFORMANCE_SEED,
    name: "read-only",
    permissions: { metadata: "read", contents: "read" },
  });
  const readOnly = { owner: CONFORMANCE_SEED.owner, name: "read-only" };

  const verifierToken = await client.mintInstallationToken({
    repository: readOnly,
    permissions: { contents: "read" },
  });
  assert.equal(verifierToken.permissions.contents, "read");

  await assert.rejects(
    () =>
      client.mintInstallationToken({
        repository: readOnly,
        permissions: { contents: "write" },
      }),
    PermissionDeniedError,
    "a maker token on a read-only installation is a mistake worth catching here, not at push time",
  );
});

test("token expiry follows the injected clock, so re-minting is testable", async () => {
  let now = Date.parse("2026-09-06T12:00:00.000Z");
  const client = makeClient({ now: () => now, tokenLifetimeMs: 60 * 60 * 1000 });

  const first = await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  assert.equal(first.expiresAt, "2026-09-06T13:00:00.000Z");

  now += 90 * 60 * 1000;
  const second = await client.mintInstallationToken({
    repository: REPOSITORY,
    permissions: { contents: "write" },
  });
  assert.equal(second.expiresAt, "2026-09-06T14:30:00.000Z");
  assert.notEqual(first.token, second.token, "a run that outlives a token gets a new one");
});

test("refuse() records the attempt before throwing, so a run can report what was tried", () => {
  const client = makeClient();
  assert.throws(() => client.refuse("pull_request.merge"), RefusedOperationError);
  assert.deepEqual(client.calls, [{ type: "refuse", operation: "pull_request.merge" }]);
});

test("an unknown repository is a NotFoundError, not an empty result", async () => {
  const client = makeClient();
  await assert.rejects(
    () => client.getRepository({ owner: "nobody", name: "nothing" }),
    NotFoundError,
  );
});

test("every write to a fork is refused, not just PR creation", async () => {
  const client = makeClient();
  await assert.rejects(() => client.createIssueComment(FORK, 7, "x"), ForkRefusedError);
  await assert.rejects(() => client.updateIssueComment(FORK, 1, "x"), ForkRefusedError);
  await assert.rejects(
    () =>
      client.createPullRequest({
        repository: FORK,
        headRef: "windkeel/issue-7-x",
        baseRef: "main",
        title: "t",
        body: "b",
      }),
    ForkRefusedError,
  );
  // Reads are fine: ingress needs to look at a fork's event to decide to ignore it.
  const issue = await client.getIssue(FORK, 7);
  assert.equal(issue.number, 7);
});
