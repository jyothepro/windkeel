import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_API_KEY_PLACEHOLDER } from "../dist/sandbox/credential-broker.js";
import { adapterFor, codexFixture, installStubCodex, makerSandbox, STUB_VERSION } from "./helpers.js";

const TWO_TURNS = () => [codexFixture("successful-session"), codexFixture("resumed-turn")];

async function drain(adapter, session) {
  const events = [];
  for await (const event of adapter.events(session)) events.push(event);
  return events;
}

const REPAIR_PACKET = {
  failed_acceptance_criteria: [{ id: "AC-1", text: "handles the empty page", reason: "unsatisfied" }],
  failed_checks: [{ check: "tests", command: "npm test", exit_code: 1 }],
  security_findings: [],
  review_findings: [],
  browser_findings: [],
  evidence_links: ["verdict.json"],
  recommended_focus: ["make `tests` exit 0 (`npm test`)"],
  repair_constraints: ["do not delete, skip, or hollow out failing tests"],
};

test("the codex session id from thread.started is captured onto the session", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });
    await drain(adapter, session);
    assert.equal(session.workerSessionId, "01JQ8Z9Y2K3M4N5P6Q7R8S9T0V");
    assert.equal(adapter.capabilities.resumableSessions, true);
  } finally {
    await handle.destroy();
  }
});

test("send() resumes by explicit session id, never --last", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });
    await drain(adapter, session);

    await adapter.send(session, { repairPacket: REPAIR_PACKET });
    await drain(adapter, session);

    // The prompt is multi-line (a rendered repair packet), so count invocations by their
    // leading `exec`, not by lines.
    const invoked = await stub.invocations();
    assert.equal(invoked.split(/^exec /m).length - 1, 2);
    /**
     * The flags come *before* `resume`. `codex exec resume` is its own clap subcommand and does
     * not accept `--sandbox`, so the other order — which this assertion used to require — made
     * every repair turn die on argument parsing against a real binary. The stub accepted it,
     * because a stub accepts any argv.
     */
    assert.match(
      invoked,
      /^exec --json --sandbox danger-full-access --ignore-user-config resume 01JQ8Z9Y2K3M4N5P6Q7R8S9T0V /m,
    );
    assert.ok(!invoked.includes("--last"));
    // The packet reaches the worker structurally, with no translation layer M5 must invent.
    assert.match(invoked, /repair_constraints/);
    assert.match(invoked, /npm test/);
  } finally {
    await handle.destroy();
  }
});

test("the resume invocation carries the same placeholder key, sandbox mode and version", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
    const adapter = adapterFor(stub.binPath, { makerModelKeyEnvVar: "WINDKEEL_TEST_MODEL_KEY" });
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });
    await drain(adapter, session);

    handle.calls.length = 0;
    await adapter.send(session, { text: "try again" });

    const launch = handle.calls.find(
      (c) => c.type === "exec" && c.options?.env?.WINDKEEL_RUNNER !== undefined,
    );
    const launchIndex = handle.calls.indexOf(launch);
    assert.equal(launch.options.env.CODEX_API_KEY, CODEX_API_KEY_PLACEHOLDER);
    // Same door as start(): the narrowed policy and the credential rules precede the agent.
    const before = handle.calls.slice(0, launchIndex);
    assert.ok(before.some((c) => c.type === "credentialBroker"));
    assert.deepEqual(
      [...before].reverse().find((c) => c.type === "policy").policy,
      { mode: "allowlist", allowedDomains: ["api.openai.com"] },
    );

    // The stub records its argv once it actually runs, so read that after the turn completes.
    await drain(adapter, session);
    const resumeInvocation = (await stub.invocations())
      .split("\n")
      .find((line) => line.includes(" resume "));
    assert.match(resumeInvocation, /--json/);
    assert.match(resumeInvocation, /--sandbox danger-full-access/);
    assert.equal(adapter.describe(session).codexVersion, STUB_VERSION);
  } finally {
    await handle.destroy();
  }
});

test("events() after send() delivers turn 2 — one stream per turn, as documented", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });

    const turnOne = await drain(adapter, session);
    assert.equal(turnOne.at(-1).type, "completed");

    await adapter.send(session, { text: "the boundary case still fails" });
    const turnTwo = await drain(adapter, session);

    assert.deepEqual(
      turnTwo.map((e) => e.type),
      ["started", "thinking", "test_started", "test_finished", "message", "completed"],
    );
    assert.equal(turnTwo.at(-1).usage.inputTokens, 3000);
    assert.equal(adapter.describe(session).turn, 2);
  } finally {
    await handle.destroy();
  }
});

test("result() after a resumed turn is cumulative for the diff, per-turn for usage", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
    // Each turn edits a different file, so a cumulative diff is distinguishable from a
    // per-turn one.
    const original = (await handle.readFile(stub.binPath)).toString("utf8");
    await handle.writeFile(
      stub.binPath,
      original.replace(
        "#!/bin/sh",
        [
          "#!/bin/sh",
          'if [ "$1" != "--version" ]; then',
          '  if [ -f turn-one-done ]; then printf \'turn two\\n\' >> second.txt; else printf \'turn one\\n\' >> first.txt; touch turn-one-done; fi',
          "fi",
        ].join("\n"),
      ),
    );

    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });
    await drain(adapter, session);
    const first = await adapter.result(session);
    assert.deepEqual(first.diff.filesChanged.sort(), ["first.txt", "turn-one-done"]);
    assert.equal(first.usage.inputTokens, 12400);
    assert.equal(first.cumulativeUsage, undefined);

    await adapter.send(session, { text: "again" });
    await drain(adapter, session);
    const second = await adapter.result(session);

    // Cumulative: turn one's edit is still in the diff.
    assert.ok(second.diff.filesChanged.includes("first.txt"));
    assert.ok(second.diff.filesChanged.includes("second.txt"));
    assert.match(second.diff.patch, /turn one/);
    assert.match(second.diff.patch, /turn two/);
    // Per-turn: usage is turn two's, with the session total alongside it.
    assert.equal(second.usage.inputTokens, 3000);
    assert.equal(second.cumulativeUsage.inputTokens, 15400);
    assert.equal(second.finalMessage, "Widened the guard; the boundary case passes now.");
  } finally {
    await handle.destroy();
  }
});

test("send() on a session with no captured id fails clearly", async () => {
  const handle = await makerSandbox();
  try {
    // A recording with no `thread.started` — the resumed-turn fixture — leaves no session id.
    const stub = await installStubCodex(handle, { fixtures: [codexFixture("resumed-turn")] });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });
    await drain(adapter, session);

    await assert.rejects(
      () => adapter.send(session, { text: "again" }),
      /no codex session id.*--last/s,
    );
  } finally {
    await handle.destroy();
  }
});

test("a concurrent send() during a running turn is rejected", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS(), mode: "hang" });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });

    await assert.rejects(
      () => adapter.send(session, { text: "meanwhile" }),
      /is still running/,
    );
    await adapter.cancel(session);
  } finally {
    await handle.destroy();
  }
});

test("send() with neither text nor a repair packet is rejected", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix it", sandbox: handle });
    await drain(adapter, session);
    await assert.rejects(() => adapter.send(session, {}), /neither `text` nor `repairPacket`/);
  } finally {
    await handle.destroy();
  }
});

test("resuming into a destroyed sandbox fails rather than hanging", async () => {
  const handle = await makerSandbox();
  const stub = await installStubCodex(handle, { fixtures: TWO_TURNS() });
  const adapter = adapterFor(stub.binPath);
  const session = await adapter.start({ prompt: "fix it", sandbox: handle });
  await drain(adapter, session);

  await handle.destroy();
  await assert.rejects(() => adapter.send(session, { text: "again" }), /could not start/);
});
