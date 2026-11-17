import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret, parseCommand } from "../apps/ingress/dist/src/interpret.js";

/**
 * `interpret` has no I/O, so it gets the exhaustive truth table — every case ADR-0009 §2/§3 and
 * ADR-0012 name, plus the ones that must *not* produce work.
 */

const REPOSITORY = {
  owner: { login: "jyothepro" },
  name: "windkeel-fixture",
  full_name: "jyothepro/windkeel-fixture",
  default_branch: "trunk",
  clone_url: "https://github.com/jyothepro/windkeel-fixture.git",
  fork: false,
};

const ISSUE = {
  number: 7,
  title: "Uploader retries are missing",
  body: "It gives up on the first 500.",
  labels: [{ name: "bug" }, { name: "windkeel" }],
  html_url: "https://github.com/jyothepro/windkeel-fixture/issues/7",
  user: { login: "someone" },
};

const base = (extra) => ({
  repository: REPOSITORY,
  installation: { id: 42 },
  sender: { login: "operator" },
  ...extra,
});

test("issues.labeled with the windkeel label creates a task, carrying the issue's facts", () => {
  const intent = interpret("issues", base({ action: "labeled", issue: ISSUE, label: { name: "windkeel" } }));
  assert.equal(intent.kind, "create_task");
  assert.equal(intent.issue.number, 7);
  assert.equal(intent.issue.title, ISSUE.title);
  assert.deepEqual(intent.issue.labels, ["bug", "windkeel"]);
  assert.deepEqual(intent.repository, {
    owner: "jyothepro",
    name: "windkeel-fixture",
    defaultBranch: "trunk",
    cloneUrl: REPOSITORY.clone_url,
    installationId: 42,
  });
});

test("issues.labeled with any other label is ignored, with the label named", () => {
  const intent = interpret("issues", base({ action: "labeled", issue: ISSUE, label: { name: "bug" } }));
  assert.equal(intent.kind, "ignore");
  assert.match(intent.reason, /bug is not the trigger/);
});

test("issues.unlabeled of windkeel cancels; of anything else is ignored", () => {
  const cancel = interpret(
    "issues",
    base({ action: "unlabeled", issue: ISSUE, label: { name: "windkeel" } }),
  );
  assert.equal(cancel.kind, "cancel_run");
  assert.equal(cancel.issueNumber, 7);
  assert.equal(cancel.actor, "operator");

  const other = interpret(
    "issues",
    base({ action: "unlabeled", issue: ISSUE, label: { name: "wontfix" } }),
  );
  assert.equal(other.kind, "ignore");
});

test("issues actions other than labeled/unlabeled are ignored", () => {
  for (const action of ["opened", "closed", "edited", "assigned"]) {
    const intent = interpret("issues", base({ action, issue: ISSUE }));
    assert.equal(intent.kind, "ignore", `issues.${action} should not act`);
    assert.match(intent.reason, new RegExp(`issues\\.${action}`));
  }
});

test("/windkeel approve and /windkeel cancel are commands; anything else is not", () => {
  const comment = (body) =>
    interpret("issue_comment", base({ action: "created", issue: ISSUE, comment: { body, user: { login: "operator" } } }));

  assert.equal(comment("/windkeel approve").command, "approve");
  assert.equal(comment("/windkeel cancel").command, "cancel");
  assert.equal(comment("  /windkeel   approve  ").command, "approve", "leading space and padding");
  assert.equal(comment("/WINDKEEL APPROVE").command, "approve", "case-insensitive");

  const unknown = comment("/windkeel foo");
  assert.equal(unknown.kind, "ignore");
  assert.match(unknown.reason, /unknown command \/windkeel foo/);

  // A comment that merely mentions the command must not execute it — otherwise a sentence in a
  // code review can kill a run.
  const mention = comment("I think we should /windkeel cancel this if it fails again");
  assert.equal(mention.kind, "ignore");
  assert.match(mention.reason, /not a \/windkeel command/);

  const multiline = comment("/windkeel approve\nlooks good to me");
  assert.equal(multiline.command, "approve", "the command is the first line; prose may follow");
});

test("a comment on a pull request is not a command surface", () => {
  const intent = interpret(
    "issue_comment",
    base({
      action: "created",
      issue: { ...ISSUE, pull_request: { url: "https://api.github.com/…/pulls/9" } },
      comment: { body: "/windkeel cancel", user: { login: "operator" } },
    }),
  );
  assert.equal(intent.kind, "ignore");
  assert.match(intent.reason, /not the pull request/);
});

test("issue_comment actions other than created are ignored", () => {
  for (const action of ["edited", "deleted"]) {
    const intent = interpret(
      "issue_comment",
      base({ action, issue: ISSUE, comment: { body: "/windkeel cancel" } }),
    );
    assert.equal(intent.kind, "ignore");
  }
});

test("pull_request.closed reports whether it merged", () => {
  const pull = (extra) =>
    interpret(
      "pull_request",
      base({
        action: "closed",
        pull_request: {
          number: 9,
          head: { ref: "windkeel/issue-7-retry", repo: { full_name: REPOSITORY.full_name, fork: false } },
          base: { repo: { full_name: REPOSITORY.full_name } },
          ...extra,
        },
      }),
    );

  const merged = pull({ merged: true, merged_at: "2026-09-06T12:00:00Z" });
  assert.equal(merged.kind, "pr_closed");
  assert.equal(merged.merged, true);
  assert.equal(merged.pullNumber, 9);
  assert.equal(merged.headRef, "windkeel/issue-7-retry");

  const closed = pull({ merged: false, merged_at: null });
  assert.equal(closed.kind, "pr_closed");
  assert.equal(closed.merged, false);
});

test("a pull request from a fork never produces work (ADR-0009 §6)", () => {
  const intent = interpret(
    "pull_request",
    base({
      action: "closed",
      pull_request: {
        number: 9,
        merged: true,
        head: { ref: "patch-1", repo: { full_name: "outsider/windkeel-fixture", fork: true } },
        base: { repo: { full_name: REPOSITORY.full_name } },
      },
    }),
  );
  assert.equal(intent.kind, "ignore");
  assert.match(intent.reason, /fork/);
});

test("any event on a fork repository is ignored before its action is even considered", () => {
  const intent = interpret(
    "issues",
    base({ action: "labeled", issue: ISSUE, label: { name: "windkeel" }, repository: { ...REPOSITORY, fork: true } }),
  );
  assert.equal(intent.kind, "ignore");
  assert.match(intent.reason, /is a fork/);
});

test("unsubscribed event types are ignored, naming the ADR clause", () => {
  for (const event of ["push", "check_run", "installation", "star"]) {
    const intent = interpret(event, base({ action: "created" }));
    assert.equal(intent.kind, "ignore");
    assert.match(intent.reason, /not subscribed/);
  }
});

test("a payload with no repository is ignored rather than throwing", () => {
  assert.equal(interpret("issues", { action: "labeled" }).kind, "ignore");
  assert.equal(interpret("issues", null).kind, "ignore");
});

test("parseCommand is anchored to the first line", () => {
  assert.deepEqual(parseCommand("/windkeel approve"), { command: "approve" });
  assert.deepEqual(parseCommand("/windkeel nope"), { unknown: "nope" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("please /windkeel approve"), null);
  assert.equal(parseCommand(""), null);
});
