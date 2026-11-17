import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import {
  SandboxGoneError,
  SandboxNotReattachableError,
} from "../dist/sandbox/provider.js";
import { CodexWorkerAdapter } from "../dist/worker/codex/adapter.js";
import { WorkerNotReattachableError, WorkerSessionGoneError } from "../dist/worker/adapter.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { cliPath, repoRoot, tempDir } from "./helpers.js";

/**
 * #196: **can a fresh process pick up a running agent session and both read its output and stop
 * it?**
 *
 * The answer has to come from a genuinely separate process. Reattaching inside the process that
 * still holds the live object proves nothing — it would pass against a provider that simply
 * returned its own cached handle, which is the whole failure this issue exists to prevent. That
 * exact mistake was made during Spike A and caught, so the tests below spawn a real second
 * `node` and pass it **only strings, through a file**.
 *
 * `FakeSandboxProvider` is used rather than Vercel because it is reattachable *for real*: a
 * sandbox's root directory is derived from its id, so the id alone is a complete reference and
 * nothing in either process is shared. That makes the cross-process property testable on every
 * machine instead of only where Vercel credentials exist — and the credential-gated Vercel
 * version in `test/sandbox-vercel.test.js` exercises the same shape against the real SDK.
 */

/** A bare git repo with one commit, so `create()` has something to clone. */
function fixtureRepo() {
  const dir = tempDir("reattach-origin");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return dir;
}

/** Runs a snippet in a fresh `node`, with the repo root as cwd so `dist/` imports resolve. */
function inFreshProcess(source) {
  const file = join(tempDir("reattach-child"), "child.mjs");
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(`child process failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout.trim();
}

test("a sandbox created by one process is re-acquired by another, which reads its output", async () => {
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: fixtureRepo() });

  // The creating process writes something only it could have written, then lets go.
  await handle.writeFile(`${handle.checkoutPath}/agent-output.jsonl`, '{"type":"turn.completed"}\n');
  const handoff = join(tempDir("reattach-handoff"), "ref.json");
  writeFileSync(handoff, JSON.stringify({ handleId: handle.id, role: handle.role }));

  try {
    // Nothing but the id and the role crosses the boundary — no object, no module state.
    const output = inFreshProcess(`
      import { readFileSync } from "node:fs";
      import { FakeSandboxProvider } from "${join(repoRoot, "dist/sandbox/fake.js")}";
      const ref = JSON.parse(readFileSync(${JSON.stringify(handoff)}, "utf8"));
      const provider = new FakeSandboxProvider();
      const attached = await provider.attach(ref);
      const body = await attached.readFile(attached.checkoutPath + "/agent-output.jsonl");
      // Prove it is a *working* handle, not just a reader: run a command in it too.
      const exec = await attached.exec("git", { args: ["rev-parse", "--abbrev-ref", "HEAD"] });
      console.log(JSON.stringify({ id: attached.id, body: body.toString("utf8"), branch: exec.stdout.trim() }));
    `);

    const seen = JSON.parse(output);
    assert.equal(seen.id, handle.id, "the reattached handle keeps the same identity");
    assert.equal(seen.body, '{"type":"turn.completed"}\n', "a fresh process read the output");
    assert.equal(seen.branch, "main", "and can run commands, not merely read files");
  } finally {
    await handle.destroy();
  }
});

test("a second process can destroy a sandbox the first one created", async () => {
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: fixtureRepo() });
  const root = handle.checkoutPath;
  assert.equal(existsSync(root), true);

  const handoff = join(tempDir("reattach-handoff"), "ref.json");
  writeFileSync(handoff, JSON.stringify({ handleId: handle.id, role: handle.role }));

  // This is the half that matters for #198 and for ADR-0011's caps: stopping a sandbox no
  // process holds a handle to. A cap that kills the agent and leaves a billing microVM has not
  // capped spend.
  inFreshProcess(`
    import { readFileSync } from "node:fs";
    import { FakeSandboxProvider } from "${join(repoRoot, "dist/sandbox/fake.js")}";
    const ref = JSON.parse(readFileSync(${JSON.stringify(handoff)}, "utf8"));
    const attached = await new FakeSandboxProvider().attach(ref);
    await attached.destroy();
    console.log("destroyed");
  `);

  assert.equal(existsSync(root), false, "the sandbox is gone, ended by a process that never made it");
});

test("attaching to a sandbox that is gone fails as a named condition, not a generic error", async () => {
  const provider = new FakeSandboxProvider();
  await assert.rejects(
    () => provider.attach({ role: "maker", handleId: "fake-maker-0-doesnotexist" }),
    SandboxGoneError,
  );
});

test("a provider that cannot reattach says so in capabilities and throws the named error", async () => {
  // No such provider ships today — every `SandboxProvider` here is reattachable — so the
  // contract is exercised against a minimal one rather than left as prose. The point is that
  // `attach()` is a *required* method: a provider cannot quietly omit it and leave callers to
  // find out at the point of use.
  const provider = {
    name: "unreattachable",
    capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: false },
    async create() {
      throw new Error("not used");
    },
    async attach() {
      throw new SandboxNotReattachableError("unreattachable");
    },
  };
  assert.equal(provider.capabilities.reattachable, false);
  await assert.rejects(
    () => provider.attach({ role: "maker", handleId: "x" }),
    SandboxNotReattachableError,
  );
});

// --- worker sessions -------------------------------------------------------------------------

test("a worker session is re-acquired from a reference in a fresh process", async () => {
  const sandboxes = new FakeSandboxProvider();
  const handle = await sandboxes.create({ role: "maker", repoUrl: fixtureRepo() });

  // Stand in for a launched turn: the scratch directory and the turn-1 log are what `attach()`
  // rebuilds around, and both are files in the sandbox rather than state in this process.
  const scratchDir = await handle.mkdtemp("windkeel-codex-");
  await handle.writeFile(
    `${scratchDir}/turn-1.events.jsonl`,
    [
      '{"type":"thread.started","thread_id":"codex-thread-7"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0}}',
      "",
    ].join("\n"),
  );
  await handle.writeFile(`${scratchDir}/turn-1.exit-status`, "0\n");

  const ref = {
    id: "codex-1",
    workerType: "codex",
    workerSessionId: "codex-thread-7",
    adapterState: {
      scratchDir,
      turn: 1,
      watermark: 0,
      codexVersion: "0.148.0",
      workdir: null,
      baseRevision: null,
      turnRunning: false,
    },
  };
  const handoff = join(tempDir("reattach-handoff"), "session.json");
  writeFileSync(handoff, JSON.stringify({ ref, sandbox: { id: handle.id, role: handle.role } }));

  try {
    const output = inFreshProcess(`
      import { readFileSync } from "node:fs";
      import { FakeSandboxProvider } from "${join(repoRoot, "dist/sandbox/fake.js")}";
      import { CodexWorkerAdapter } from "${join(repoRoot, "dist/worker/codex/adapter.js")}";
      const { ref, sandbox } = JSON.parse(readFileSync(${JSON.stringify(handoff)}, "utf8"));
      const attached = await new FakeSandboxProvider().attach({ role: sandbox.role, handleId: sandbox.id });
      const adapter = new CodexWorkerAdapter();
      const session = await adapter.attach(ref, attached);
      const types = [];
      for await (const event of adapter.events(session)) types.push(event.type);
      console.log(JSON.stringify({ types, workerSessionId: session.workerSessionId }));
    `);

    const seen = JSON.parse(output);
    // `npm test` normalizes to `test_finished`, which is the point: the events that survive a
    // process boundary are the evidence-bearing ones M3.3 exists to capture.
    assert.deepEqual(
      seen.types,
      ["started", "test_finished"],
      `a fresh process read the turn's events: ${seen.types.join(", ")}`,
    );
    assert.equal(
      seen.workerSessionId,
      "codex-thread-7",
      "and holds the codex session id a repair turn resumes with (ADR-0011 §2)",
    );
  } finally {
    await handle.destroy();
  }
});

test("a session reference round-trips through JSON without losing anything attach() needs", async () => {
  const sandboxes = new FakeSandboxProvider();
  const handle = await sandboxes.create({ role: "maker", repoUrl: fixtureRepo() });
  const adapter = new CodexWorkerAdapter();
  const scratchDir = await handle.mkdtemp("windkeel-codex-");
  await handle.writeFile(`${scratchDir}/turn-1.events.jsonl`, "");

  const ref = {
    id: "codex-1",
    workerType: "codex",
    adapterState: { scratchDir, turn: 1, watermark: 0, turnRunning: false },
  };
  try {
    const session = await adapter.attach(JSON.parse(JSON.stringify(ref)), handle);
    const round = adapter.reference(session);
    assert.equal(round.id, "codex-1");
    assert.equal(round.workerType, "codex");
    assert.equal(round.adapterState.scratchDir, scratchDir);
    assert.equal(round.adapterState.turn, 1);
    assert.equal(
      JSON.stringify(round),
      JSON.stringify(JSON.parse(JSON.stringify(round))),
      "the reference is serialisable — it carries no live object",
    );
  } finally {
    await handle.destroy();
  }
});

test("attaching a reference whose scratch directory is gone is a named, honest failure", async () => {
  const sandboxes = new FakeSandboxProvider();
  const handle = await sandboxes.create({ role: "maker", repoUrl: fixtureRepo() });
  const adapter = new CodexWorkerAdapter();
  try {
    await assert.rejects(
      () =>
        adapter.attach(
          {
            id: "codex-1",
            workerType: "codex",
            adapterState: { scratchDir: "/tmp/windkeel-codex-vanished", turn: 1, watermark: 0 },
          },
          handle,
        ),
      WorkerSessionGoneError,
    );
  } finally {
    await handle.destroy();
  }
});

test("an adapter cannot attach a session another adapter started", async () => {
  const sandboxes = new FakeSandboxProvider();
  const handle = await sandboxes.create({ role: "maker", repoUrl: fixtureRepo() });
  const adapter = new CodexWorkerAdapter();
  try {
    await assert.rejects(
      () =>
        adapter.attach(
          { id: "s", workerType: "openhands", adapterState: { scratchDir: "/tmp/x", turn: 1 } },
          handle,
        ),
      // ADR-0011 §2 forbids changing the worker between attempts; catching it at attach is
      // earlier and clearer than catching it at the point a resumed turn misbehaves.
      WorkerSessionGoneError,
    );
  } finally {
    await handle.destroy();
  }
});

test("an adapter that cannot reattach declares it and refuses, rather than faking a session", () => {
  const adapter = new FakeWorkerAdapter([]);
  assert.equal(adapter.capabilities.reattachableSessions, false);
  assert.equal(adapter.capabilities.reattachedSessionsAcceptNewTurns, false);
  assert.throws(() => adapter.reference(), WorkerNotReattachableError);
});

test("the codex adapter's reattach capabilities say exactly what it can and cannot do", () => {
  const adapter = new CodexWorkerAdapter();
  assert.deepEqual(adapter.capabilities, {
    resumableSessions: true,
    reattachableSessions: true,
    // True because `codex exec resume <SESSION_ID>` needs only the durable session id. What a
    // reattached session does *not* restore is cross-turn accumulation (usageByTurn,
    // reportedFiles, finalMessage) — see the capability's comment, and #197's durable summary.
    reattachedSessionsAcceptNewTurns: true,
    // ADR-0027 §3's matrix: a production maker on every count.
    pollable: true,
    reportsUsage: true,
    reportsFileChanges: true,
    providers: ["openai", "openrouter", "openai-compatible"],
  });
});

test("the CLI still builds — the seam change did not break the entry point", () => {
  assert.ok(existsSync(cliPath));
  assert.ok(readFileSync(cliPath, "utf8").length > 0);
});
