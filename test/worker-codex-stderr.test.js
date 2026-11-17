/**
 * What a maker failure tells you when Codex dies before saying anything.
 *
 * The adapter treats the event stream as authoritative for the outcome, so a process that dies
 * before emitting `turn.completed` is a failure — correctly. But the *reason* it died is only
 * ever written to a file inside the sandbox, and the orchestrator destroys the sandbox the
 * moment the stage fails. The first live maker session on ADR-0020's deployment ended exactly
 * there: a FAILED run whose whole account of itself was "the process died or its output was cut
 * off", with the one file that could have explained it already deleted.
 *
 * So the failure carries the tail of that file. These tests pin the three things that makes
 * worth having: the reason is included, it is bounded, and looking for it can never turn a
 * reportable failure into a thrown one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterFor, makerSandbox, STUB_VERSION } from "./helpers.js";

/** A `codex` that answers `--version` and then dies the way a broken one does. */
async function installDyingCodex(handle, { stderr, exitCode = 1 }) {
  const dir = await handle.mkdtemp("windkeel-dying-codex-");
  const binPath = `${dir}/codex`;
  await handle.writeFile(
    binPath,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "codex-cli ${STUB_VERSION}"; exit 0; fi`,
      ...(stderr ? [`printf '%s' "${stderr}" >&2`] : []),
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  await handle.exec("chmod", { args: ["+x", binPath] });
  return binPath;
}

async function failedSession(handle, binPath) {
  const adapter = adapterFor(binPath);
  const session = await adapter.start({ prompt: "do the work", sandbox: handle });
  for await (const _event of adapter.events(session)) {
    // consume; there is nothing to consume, which is the point
  }
  return await adapter.result(session);
}

test("a session that dies silently reports what codex printed to stderr", async () => {
  const handle = await makerSandbox();
  try {
    const binPath = await installDyingCodex(handle, {
      stderr: "error: unauthorized — no API key was accepted",
    });
    const result = await failedSession(handle, binPath);

    assert.equal(result.outcome, "failed");
    assert.match(result.error, /stream ended without a .turn.completed./);
    assert.match(
      result.error,
      /unauthorized — no API key was accepted/,
      "the reason the process died has to survive the sandbox that held it",
    );
  } finally {
    await handle.destroy();
  }
});

test("the stderr it carries is bounded", async () => {
  const handle = await makerSandbox();
  try {
    // Well past the 2000-byte tail, the way a crash loop writes.
    const binPath = await installDyingCodex(handle, { stderr: "x".repeat(9000) });
    const result = await failedSession(handle, binPath);

    assert.equal(result.outcome, "failed");
    assert.ok(
      result.error.length < 3000,
      `a failure reason is read by a person, not a parser; got ${result.error.length} bytes`,
    );
    assert.match(result.error, /…x+$/, "the tail is kept, and says it is a tail");
  } finally {
    await handle.destroy();
  }
});

test("a session that printed nothing reports the plain reason", async () => {
  const handle = await makerSandbox();
  try {
    const binPath = await installDyingCodex(handle, { stderr: "" });
    const result = await failedSession(handle, binPath);

    assert.equal(result.outcome, "failed");
    assert.match(result.error, /stream ended without a .turn.completed./);
    assert.doesNotMatch(result.error, /stderr ended with/);
  } finally {
    await handle.destroy();
  }
});

test("an unreadable stderr does not turn a reportable failure into a thrown one", async () => {
  const handle = await makerSandbox();
  try {
    const binPath = await installDyingCodex(handle, { stderr: "something" });
    const adapter = adapterFor(binPath);
    const session = await adapter.start({ prompt: "do the work", sandbox: handle });
    for await (const _event of adapter.events(session)) {
      // consume
    }
    // The sandbox is gone by the time the reason is wanted — which is the ordinary case, since
    // the orchestrator destroys it on failure. Only that read fails; the rest still works.
    const readFile = handle.readFile.bind(handle);
    handle.readFile = async (path) => {
      if (path.endsWith(".stderr.log")) throw new Error("sandbox is gone");
      return await readFile(path);
    };
    const result = await adapter.result(session);

    assert.equal(result.outcome, "failed");
    assert.match(result.error, /stream ended without a .turn.completed./);
  } finally {
    await handle.destroy();
  }
});
