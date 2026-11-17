import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ForkRefusedError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitedError,
  RefusedOperationError,
} from "../dist/github/client.js";

/**
 * One behaviour suite, two backings — the precedent `test/workflow-conformance.js` set in M4.2
 * and for the same reason: `FakeGitHubClient` and the real REST client (M6.2) run these same
 * cases, so a semantic one has and the other lacks fails a test here rather than being
 * discovered by M6.9 against the live API.
 *
 * A harness is `{ client, repository, forkRepository, injectFailure, cleanup }`:
 *
 * - `client` — the `GitHubClient` under test.
 * - `repository` — a `RepositoryRef` seeded with issue #7 (labelled `windkeel`), one existing open
 *   PR on branch `windkeel/issue-9-existing`, and the full ADR-0009 §1 permission set.
 * - `forkRepository` — a `RepositoryRef` seeded identically but flagged as a fork.
 * - `injectFailure(method, failure)` — makes the *next* call to `method` fail that way. The
 *   fake queues it in memory; the real client's harness makes its stubbed HTTP layer return the
 *   corresponding status. That is the seam where the two backings honestly differ, so it is a
 *   harness responsibility rather than a client method.
 *
 * Deliberately *not* here: anything only one backing can honestly claim. Token *contents* are
 * asserted (permissions echoed, expiry present, two roles distinguishable) but not their format
 * — the fake's are strings it made up and GitHub's are real credentials, and pretending those
 * are the same shape would weaken both.
 */

const WINDKEEL_LABEL = "windkeel";
const STICKY_MARKER = "<!-- windkeel:evidence -->";

const CASES = [
  {
    name: "getCollaboratorPermission returns the legacy permission and the precise role",
    async run(h) {
      assert.deepEqual(await h.client.getCollaboratorPermission(h.repository, "write-user"), {
        permission: "write",
        roleName: "write",
      });
      // Triage reads as `read` in the legacy field; only the role name tells them apart.
      assert.deepEqual(await h.client.getCollaboratorPermission(h.repository, "Triage-User"), {
        permission: "read",
        roleName: "triage",
      });
      const stranger = await h.client.getCollaboratorPermission(h.repository, "stranger");
      assert.equal(stranger.permission, "none");
      assert.equal(stranger.roleName, null);
    },
  },
  {
    name: "mintInstallationToken returns the permissions asked for, plus an expiry",
    async run(h) {
      const maker = await h.client.mintInstallationToken({
        repository: h.repository,
        permissions: { contents: "write" },
      });
      const verifier = await h.client.mintInstallationToken({
        repository: h.repository,
        permissions: { contents: "read" },
      });

      // ADR-0014 §2: the token *is* the enforcement, so the scope must survive the round trip.
      assert.deepEqual(maker.permissions, { contents: "write" });
      assert.deepEqual(verifier.permissions, { contents: "read" });
      assert.notEqual(maker.token, verifier.token, "one token per workspace, not one per run");
      assert.deepEqual(maker.repository, {
        owner: h.repository.owner,
        name: h.repository.name,
      });
      assert.ok(
        Date.parse(maker.expiresAt) > 0,
        `expiresAt should be an ISO timestamp, got ${maker.expiresAt}`,
      );
      assert.ok(
        Date.parse(maker.expiresAt) > Date.now() - 60_000,
        "a freshly minted token should not already be expired",
      );
    },
  },

  {
    name: "a maker-scoped token is distinguishable from a verifier-scoped one",
    async run(h) {
      const maker = await h.client.mintInstallationToken({
        repository: h.repository,
        permissions: { contents: "write" },
      });
      const verifier = await h.client.mintInstallationToken({
        repository: h.repository,
        permissions: { contents: "read" },
      });
      // "The verifier could not have pushed" has to be checkable from data (ADR-0014 §2's
      // closing consequence), which means the two tokens cannot be interchangeable objects.
      assert.equal(maker.permissions.contents, "write");
      assert.equal(verifier.permissions.contents, "read");
    },
  },

  {
    name: "getRepository reports the default branch, clone URL, and granted permissions",
    async run(h) {
      const repository = await h.client.getRepository(h.repository);
      assert.equal(repository.owner, h.repository.owner);
      assert.equal(repository.name, h.repository.name);
      assert.equal(repository.defaultBranch, "main");
      assert.equal(repository.fork, false);
      assert.match(repository.cloneUrl, /\.git$/);
      assert.equal(repository.permissions.contents, "write");
      assert.equal(repository.permissions.checks, "write");
    },
  },

  {
    name: "getIssue returns the seeded issue with its labels, and 404s for an unknown number",
    async run(h) {
      const issue = await h.client.getIssue(h.repository, 7);
      assert.equal(issue.number, 7);
      assert.equal(issue.state, "open");
      assert.ok(issue.labels.includes(WINDKEEL_LABEL), "the trigger label is visible to the caller");
      await assert.rejects(() => h.client.getIssue(h.repository, 4242), NotFoundError);
    },
  },

  {
    name: "sticky comment: create then update by id leaves exactly one comment, found by marker",
    async run(h) {
      const before = await h.client.listIssueComments(h.repository, 7);
      const created = await h.client.createIssueComment(
        h.repository,
        7,
        `${STICKY_MARKER}\nattempt 1: 3 criteria, 1 repair`,
      );

      const updated = await h.client.updateIssueComment(
        h.repository,
        created.id,
        `${STICKY_MARKER}\nattempt 2: 3 criteria, 2 repairs`,
      );
      assert.equal(updated.id, created.id, "editing in place keeps the id");
      assert.match(updated.body, /attempt 2/);

      const after = await h.client.listIssueComments(h.repository, 7);
      assert.equal(
        after.length,
        before.length + 1,
        "ADR-0009 §4: edited in place, never a new comment per attempt",
      );
      const sticky = after.filter((c) => c.body.includes(STICKY_MARKER));
      assert.equal(sticky.length, 1);
      assert.match(sticky[0].body, /attempt 2/);
      assert.equal(sticky[0].id, created.id);
    },
  },

  {
    name: "updateIssueComment on an unknown comment id is a NotFoundError",
    async run(h) {
      await assert.rejects(
        () => h.client.updateIssueComment(h.repository, 999_999, "x"),
        NotFoundError,
      );
    },
  },

  {
    name: "createPullRequest opens a draft and returns a number and URL",
    async run(h) {
      const pull = await h.client.createPullRequest({
        repository: h.repository,
        headRef: "windkeel/issue-7-add-retry",
        baseRef: "main",
        title: "Add retry to the uploader",
        body: "Evidence summary\n\nResolves #7",
      });
      assert.equal(pull.draft, true, "ADR-0009 §5: always draft");
      assert.ok(Number.isInteger(pull.number) && pull.number > 0);
      assert.match(pull.htmlUrl, /\/pull\/\d+$/);
      assert.equal(pull.headRef, "windkeel/issue-7-add-retry");
      assert.equal(pull.baseRef, "main");
      assert.equal(pull.state, "open");
      assert.equal(pull.merged, false);
    },
  },

  {
    name: "an existing PR for a branch is discoverable, so a caller need not open a second",
    async run(h) {
      const existing = await h.client.listPullRequests({
        repository: h.repository,
        headRef: "windkeel/issue-9-existing",
      });
      assert.equal(existing.length, 1, "the seeded PR is findable by head ref");

      const fresh = await h.client.listPullRequests({
        repository: h.repository,
        headRef: "windkeel/issue-7-add-retry",
      });
      assert.equal(fresh.length, 0, "and a branch with no PR reports none");

      const opened = await h.client.createPullRequest({
        repository: h.repository,
        headRef: "windkeel/issue-7-add-retry",
        baseRef: "main",
        title: "Add retry to the uploader",
        body: "Resolves #7",
      });
      const now = await h.client.listPullRequests({
        repository: h.repository,
        headRef: "windkeel/issue-7-add-retry",
      });
      assert.deepEqual(
        now.map((p) => p.number),
        [opened.number],
      );

      const fetched = await h.client.getPullRequest(h.repository, opened.number);
      assert.equal(fetched.number, opened.number);
      assert.equal(fetched.draft, true);
    },
  },

  {
    name: "check runs: create then update on one head SHA updates rather than duplicates",
    async run(h) {
      const headSha = "a".repeat(40);
      const created = await h.client.createCheckRun({
        repository: h.repository,
        headSha,
        name: "windkeel/verification",
        status: "in_progress",
        output: { title: "Verifying", summary: "Running the verification engine" },
      });
      assert.equal(created.conclusion, null, "an in-progress check has no conclusion yet");

      const completed = await h.client.updateCheckRun({
        repository: h.repository,
        checkRunId: created.id,
        status: "completed",
        conclusion: "success",
        output: { title: "Passed", summary: "3/3 criteria satisfied" },
      });
      assert.equal(completed.id, created.id, "same check run, updated in place");
      assert.equal(completed.status, "completed");
      assert.equal(completed.conclusion, "success");
      assert.equal(completed.headSha, headSha);
      assert.equal(completed.output.title, "Passed");
    },
  },

  {
    name: "check-run conclusions are exactly the values ADR-0009 §4 maps onto",
    async run(h) {
      // pass -> success, warn -> neutral, fail -> failure. The mapping itself is M6.8's; what
      // this asserts is that the client accepts all three and nothing here rejects `neutral`.
      for (const [index, conclusion] of ["success", "neutral", "failure"].entries()) {
        const headSha = String(index).repeat(40);
        const check = await h.client.createCheckRun({
          repository: h.repository,
          headSha,
          name: "windkeel/verification",
          status: "completed",
          conclusion,
          output: { title: conclusion, summary: "verdict" },
        });
        assert.equal(check.conclusion, conclusion);
      }
    },
  },

  {
    name: "refuse() throws RefusedOperationError for every operation ADR-0009 §5 forbids",
    async run(h) {
      for (const operation of [
        "pull_request.ready_for_review",
        "pull_request.approve",
        "pull_request.merge",
        "fork.write",
      ]) {
        assert.throws(() => h.client.refuse(operation), RefusedOperationError);
      }
      // And the capabilities themselves are unrepresentable, not merely refused at runtime.
      for (const method of ["mergePullRequest", "approvePullRequest", "markReadyForReview"]) {
        assert.equal(
          typeof h.client[method],
          "undefined",
          `${method} must not exist on a GitHubClient (ADR-0009 §5)`,
        );
      }
    },
  },

  {
    name: "a cross-repository head ref is refused: v1 never opens a PR from a fork",
    async run(h) {
      await assert.rejects(
        () =>
          h.client.createPullRequest({
            repository: h.repository,
            headRef: "someone-else:patch-1",
            baseRef: "main",
            title: "from a fork",
            body: "",
          }),
        ForkRefusedError,
      );
    },
  },

  {
    name: "writes to a repository that is a fork are refused",
    async run(h) {
      const fork = await h.client.getRepository(h.forkRepository);
      assert.equal(fork.fork, true, "the harness seeds this one as a fork");
      await assert.rejects(
        () => h.client.createIssueComment(h.forkRepository, 7, "hello"),
        ForkRefusedError,
      );
      await assert.rejects(
        () =>
          h.client.createCheckRun({
            repository: h.forkRepository,
            headSha: "b".repeat(40),
            name: "windkeel/verification",
            status: "in_progress",
          }),
        ForkRefusedError,
      );
    },
  },

  {
    name: "an injected 404 surfaces as NotFoundError from every method that can produce one",
    async run(h) {
      const attempts = [
        () => h.client.getRepository(h.repository),
        () => h.client.getIssue(h.repository, 7),
        () => h.client.listIssueComments(h.repository, 7),
        () => h.client.createIssueComment(h.repository, 7, "x"),
        () => h.client.getPullRequest(h.repository, 9),
        () =>
          h.client.createCheckRun({
            repository: h.repository,
            headSha: "c".repeat(40),
            name: "windkeel/verification",
            status: "queued",
          }),
      ];
      const methods = [
        "getRepository",
        "getIssue",
        "listIssueComments",
        "createIssueComment",
        "getPullRequest",
        "createCheckRun",
      ];
      for (const [index, attempt] of attempts.entries()) {
        h.injectFailure(methods[index], { kind: "notFound" });
        await assert.rejects(attempt, NotFoundError, `${methods[index]} should 404 cleanly`);
      }
    },
  },

  {
    name: "an injected permission denial surfaces as PermissionDeniedError, naming the permission",
    async run(h) {
      h.injectFailure("createCheckRun", { kind: "permissionDenied", permission: "checks" });
      await assert.rejects(
        () =>
          h.client.createCheckRun({
            repository: h.repository,
            headSha: "d".repeat(40),
            name: "windkeel/verification",
            status: "queued",
          }),
        (error) => {
          // ADR-0009 §6: this has to become a FAILED run with a *recorded reason*, which needs
          // more than a generic Error.
          assert.ok(error instanceof PermissionDeniedError);
          assert.equal(error.permission, "checks");
          return true;
        },
      );

      h.injectFailure("mintInstallationToken", { kind: "permissionDenied" });
      await assert.rejects(
        () =>
          h.client.mintInstallationToken({
            repository: h.repository,
            permissions: { contents: "write" },
          }),
        PermissionDeniedError,
      );
    },
  },

  {
    name: "an injected rate limit surfaces as RateLimitedError carrying a retry delay",
    async run(h) {
      h.injectFailure("listIssueComments", { kind: "rateLimited", retryAfterMs: 30_000 });
      await assert.rejects(
        () => h.client.listIssueComments(h.repository, 7),
        (error) => {
          assert.ok(error instanceof RateLimitedError);
          assert.equal(typeof error.retryAfterMs, "number");
          assert.ok(error.retryAfterMs > 0, "the delay is carried, not slept on");
          return true;
        },
      );

      // Queued, not sticky: the retry after a rate limit is expected to succeed, which is what
      // makes a stage handler's retry (ADR-0007) the right place for the policy.
      const comments = await h.client.listIssueComments(h.repository, 7);
      assert.ok(Array.isArray(comments));
    },
  },
  {
    name: "listPullRequestCommits carries the author, the login, and the parent count",
    async run(h) {
      const commits = await h.client.listPullRequestCommits(h.repository, 9);

      assert.equal(commits.length, 3);
      assert.deepEqual(
        commits.map((c) => c.sha),
        ["1".repeat(40), "2".repeat(40), "3".repeat(40)],
        "in the order GitHub returns them, oldest first",
      );

      // The *author*, not the committer: a rebase rewrites the committer and preserves the
      // author, so a client that surfaced the committer would attribute every one of Windkeel's
      // commits to whoever last rebased. The committer is absent from the type on purpose.
      assert.equal(commits[0].authorEmail, "factory@windkeel.invalid");
      assert.equal(commits[1].authorEmail, "someone@example.com");
      assert.equal(commits[0].authorLogin, "windkeel-app[bot]");

      // A merge commit authors no change, and GitHub's "Update branch" button makes one under
      // the clicking user's name. The count is what lets the caller exclude it.
      assert.deepEqual(
        commits.map((c) => c.parentCount),
        [1, 1, 2],
      );
    },
  },
  {
    name: "getBranchHead reads a branch's commit, and a branch nobody pushed is null",
    async run(h) {
      // A slash in the branch name is the run-branch convention (ADR-0019), so it is what this
      // asserts: the ref path keeps it rather than encoding it into one segment.
      assert.equal(await h.client.getBranchHead(h.repository, "windkeel/issue-9-existing"), "a".repeat(40));
      assert.equal(await h.client.getBranchHead(h.repository, "windkeel/never-pushed"), null);
    },
  },
  {
    name: "listPullRequestCommits on a pull request that does not exist is a NotFoundError",
    async run(h) {
      await assert.rejects(
        () => h.client.listPullRequestCommits(h.repository, 4242),
        (error) => error instanceof NotFoundError,
      );
    },
  },
];

/**
 * Runs every conformance case against one backing. `makeHarness()` must construct a client
 * seeded as this file's header describes and return the harness.
 */
export function runGitHubConformanceSuite(label, makeHarness, options = {}) {
  for (const testCase of CASES) {
    test(`${label}: ${testCase.name}`, { skip: options.skip ?? false }, async () => {
      const harness = await makeHarness();
      try {
        await testCase.run(harness);
      } finally {
        await harness.cleanup?.();
      }
    });
  }
}

/** The seed every harness must reproduce, exported so both harnesses stay literally identical. */
export const CONFORMANCE_SEED = {
  owner: "jyothepro",
  name: "windkeel-fixture",
  defaultBranch: "main",
  branches: { "windkeel/issue-9-existing": "a".repeat(40) },
  // For `getCollaboratorPermission`: who may `/windkeel approve` is GitHub's answer for these.
  collaborators: {
    "write-user": { permission: "write", roleName: "write" },
    "triage-user": { permission: "read", roleName: "triage" },
  },
  issues: [
    {
      number: 7,
      title: "Uploader retries are missing",
      body: "The uploader gives up on the first 500.",
      labels: [WINDKEEL_LABEL],
      comments: [{ body: "a pre-existing human comment", authorLogin: "someone" }],
    },
  ],
  pullRequests: [
    {
      number: 9,
      headRef: "windkeel/issue-9-existing",
      baseRef: "main",
      /**
       * Three commits that make ADR-0013's attribution rule testable against both backings:
       * one Windkeel authored, one a human authored, and one merge commit. The metric's whole
       * difficulty is telling them apart, so the fixture has to contain all three.
       */
      commits: [
        {
          sha: "1".repeat(40),
          authorEmail: "factory@windkeel.invalid",
          authorLogin: "windkeel-app[bot]",
          authoredAt: "2026-01-01T00:00:00Z",
        },
        {
          sha: "2".repeat(40),
          authorEmail: "someone@example.com",
          authorLogin: "someone",
          authoredAt: "2026-01-02T00:00:00Z",
        },
        {
          sha: "3".repeat(40),
          authorEmail: "someone@example.com",
          authorLogin: "someone",
          authoredAt: "2026-01-03T00:00:00Z",
          parentCount: 2,
        },
      ],
    },
  ],
};
