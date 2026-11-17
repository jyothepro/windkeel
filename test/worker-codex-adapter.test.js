import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_API_KEY_PLACEHOLDER } from "../dist/sandbox/credential-broker.js";
import { adapterFor, codexFixture, installStubCodex, makerSandbox, STUB_VERSION } from "./helpers.js";
import { PINNED_CODEX_VERSION } from "../dist/worker/codex/adapter.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("start() routes through runInExecutionPhase: policy and credentials precede the agent", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixture: codexFixture("successful-session") });
    const adapter = adapterFor(stub.binPath, { makerModelKeyEnvVar: "WINDKEEL_TEST_MODEL_KEY" });
    handle.calls.length = 0;

    await adapter.start({ prompt: "fix the pager", sandbox: handle });

    // Find the launcher exec — the one that actually starts the agent.
    const launchIndex = handle.calls.findIndex(
      (c) => c.type === "exec" && c.options?.env?.WINDKEEL_RUNNER !== undefined,
    );
    assert.ok(launchIndex > 0, "the agent was launched through an exec");
    const before = handle.calls.slice(0, launchIndex);
    const lastPolicy = before.findLast?.((c) => c.type === "policy") ??
      [...before].reverse().find((c) => c.type === "policy");
    const lastRules = [...before].reverse().find((c) => c.type === "credentialBroker");
    assert.deepEqual(lastPolicy.policy, {
      mode: "allowlist",
      allowedDomains: ["api.openai.com"],
    });
    assert.deepEqual(lastRules.rules, [
      {
        domain: "api.openai.com",
        header: "Authorization",
        secretEnvVar: "WINDKEEL_TEST_MODEL_KEY",
      },
    ]);
  } finally {
    await handle.destroy();
  }
});

test("the invocation carries --json, the pinned version and the intended sandbox mode", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixture: codexFixture("successful-session") });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix the pager", sandbox: handle });
    await collect(adapter.events(session));

    const invoked = await stub.invocations();
    assert.match(invoked, /exec/);
    assert.match(invoked, /--json/);
    assert.match(invoked, /--sandbox danger-full-access/);
    assert.match(invoked, /--ignore-user-config/);
    assert.match(invoked, /fix the pager/);
    // The version actually driven is recorded against the session, per ADR-0006's pinning.
    assert.equal(adapter.describe(session).codexVersion, STUB_VERSION);
    assert.equal(adapter.describe(session).pinnedVersion, STUB_VERSION);
  } finally {
    await handle.destroy();
  }
});

test("a version other than the pinned one is refused, and drift can be opted into", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, {
      fixture: codexFixture("successful-session"),
      version: "0.999.0",
    });
    await assert.rejects(
      () => adapterFor(stub.binPath).start({ prompt: "x", sandbox: handle }),
      // From the constant, not written out — the literal had to be edited by hand when #116's
      // pin was corrected, which is the drift this assertion exists to catch.
      new RegExp(`pinned to ${PINNED_CODEX_VERSION.replace(/\./g, "\\.")}`),
    );

    const diagnostics = [];
    const tolerant = adapterFor(stub.binPath, {
      allowVersionDrift: true,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    const session = await tolerant.start({ prompt: "x", sandbox: handle });
    assert.equal(tolerant.describe(session).codexVersion, "0.999.0");
    assert.ok(diagnostics.some((d) => d.detail.includes("0.999.0")));
  } finally {
    await handle.destroy();
  }
});

test("a missing codex binary fails with a clear error rather than installing one", async () => {
  const handle = await makerSandbox();
  try {
    const adapter = adapterFor("/nonexistent/codex");
    await assert.rejects(
      () => adapter.start({ prompt: "x", sandbox: handle }),
      /not available in this sandbox/,
    );
  } finally {
    await handle.destroy();
  }
});

test("CODEX_API_KEY is the placeholder and no real-looking key reaches the sandbox", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixture: codexFixture("successful-session") });
    const adapter = adapterFor(stub.binPath, { makerModelKeyEnvVar: "WINDKEEL_TEST_MODEL_KEY" });
    handle.calls.length = 0;
    await adapter.start({ prompt: "fix the pager", sandbox: handle });

    const launch = handle.calls.find(
      (c) => c.type === "exec" && c.options?.env?.WINDKEEL_RUNNER !== undefined,
    );
    assert.equal(launch.options.env.CODEX_API_KEY, CODEX_API_KEY_PLACEHOLDER);
    const envValues = Object.values(launch.options.env).join(" ");
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(envValues), "no OpenAI-shaped key in the sandbox env");
    assert.ok(!envValues.includes("Bearer "), "no authorization header value in the sandbox env");
  } finally {
    await handle.destroy();
  }
});

test("events() streams the recorded JSONL in order, incrementally", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixture: codexFixture("successful-session") });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix the pager", sandbox: handle });

    const events = [];
    let sawEventBeforeExit = false;
    for await (const event of adapter.events(session)) {
      // The done-marker only appears once the stub exits; seeing an event while it is absent
      // proves delivery is incremental rather than a single read after exit.
      if (!(await handle.exists(adapter.describe(session).donePath))) sawEventBeforeExit = true;
      events.push(event);
    }

    assert.deepEqual(
      events.map((e) => e.type),
      [
        "started",
        "thinking",
        "command_started",
        "command_finished",
        "file_changed",
        "file_changed",
        "test_started",
        "test_finished",
        "message",
        "completed",
      ],
    );
    assert.ok(sawEventBeforeExit, "at least one event arrived before the process exited");
    assert.equal(session.workerSessionId, "01JQ8Z9Y2K3M4N5P6Q7R8S9T0V");
  } finally {
    await handle.destroy();
  }
});

test("cancel() stops event delivery, kills the process group, and is observable", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, {
      fixture: codexFixture("successful-session"),
      mode: "hang",
    });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix the pager", sandbox: handle });

    const events = [];
    for await (const event of adapter.events(session)) {
      events.push(event);
      if (events.length === 2) await adapter.cancel(session);
    }
    assert.equal(events.length, 2, "no events are delivered after cancel");

    const cancelExec = handle.calls.find(
      (c) => c.type === "exec" && c.options?.env?.WINDKEEL_PGID_FILE !== undefined,
    );
    assert.ok(cancelExec, "the cancellation is visible in the sandbox call timeline");
    assert.equal(adapter.describe(session).cancelled, true);

    // The hung stub must actually be gone: nothing should still be holding the sandbox.
    const pgid = (await handle.readFile(adapter.describe(session).pidPath)).toString("utf8").trim();
    const alive = await handle.exec("sh", { args: ["-c", `kill -0 -${pgid} 2>/dev/null`] });
    assert.notEqual(alive.status, 0, `process group ${pgid} is still alive after cancel`);
  } finally {
    await handle.destroy();
  }
});

test("a turn.failed stream surfaces as a `failed` event, not a thrown error", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, { fixture: codexFixture("failed-turn") });
    const adapter = adapterFor(stub.binPath);
    const session = await adapter.start({ prompt: "fix the pager", sandbox: handle });
    const events = await collect(adapter.events(session));
    assert.equal(events.at(-1).type, "failed");
    assert.match(events.at(-1).error, /429/);
  } finally {
    await handle.destroy();
  }
});
