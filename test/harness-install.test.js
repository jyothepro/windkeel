/**
 * ADR-0027 §7.2: `WINDKEEL_HARNESS_INSTALL=pinned` installs the run's pinned harness when the image's
 * differs — the 2026-10-25 outage, when the image moved Codex to 0.163.0 under a 0.154.0 pin. The
 * sandbox is a scripted handle: what `--version` says before and after, and whether npm succeeds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePinnedHarness, versionIn } from "../dist/sandbox/harness-install.js";
import { harnessInstallFromEnv } from "../dist/factory/worker-config.js";

const SPEC = { harness: "codex", binary: "codex", version: "0.163.0", installSpec: "@openai/codex" };

/** `versions`: what successive `codex --version` calls report. `npm`/`sudo`: exit statuses. */
function scripted({ versions, npm = 0, sudo = 0 }) {
  const calls = [];
  let probe = 0;
  return {
    calls,
    async exec(command, { args = [] } = {}) {
      calls.push([command, ...args].join(" "));
      if (command === "codex") {
        const v = versions[Math.min(probe++, versions.length - 1)];
        return v ? { status: 0, stdout: `codex-cli ${v}\n`, stderr: "" } : { status: 127, stdout: "", stderr: "not found" };
      }
      if (command === "npm") return { status: npm, stdout: "", stderr: npm ? "EACCES: permission denied" : "" };
      if (command === "sudo") return { status: sudo, stdout: "", stderr: sudo ? "sudo: a password is required" : "" };
      throw new Error(`unexpected ${command}`);
    },
  };
}

test("the pinned version already there: nothing is installed", async () => {
  const handle = scripted({ versions: ["0.163.0"] });
  const result = await ensurePinnedHarness(handle, SPEC);
  assert.equal(result.status, "present");
  assert.deepEqual(handle.calls, ["codex --version"]);
});

test("the image drifted: the pinned version is installed and confirmed", async () => {
  const handle = scripted({ versions: ["0.154.0", "0.163.0"] });
  const result = await ensurePinnedHarness(handle, { ...SPEC });
  assert.equal(result.status, "installed");
  assert.equal(result.found, "0.154.0");
  assert.ok(handle.calls.includes("npm install -g --no-fund --no-audit --loglevel=error @openai/codex@0.163.0"));
  assert.match(result.detail, /was 0\.154\.0; npm install -g @openai\/codex@0\.163\.0 replaced it/);
});

test("a root-owned global prefix falls back to passwordless sudo", async () => {
  const handle = scripted({ versions: ["0.154.0", "0.163.0"], npm: 243 });
  const result = await ensurePinnedHarness(handle, SPEC);
  assert.equal(result.status, "installed");
  assert.ok(handle.calls.some((c) => c.startsWith("sudo -n npm install -g")));
});

test("an install that fails is recorded, never thrown", async () => {
  const result = await ensurePinnedHarness(scripted({ versions: ["0.154.0"], npm: 1, sudo: 1 }), SPEC);
  assert.equal(result.status, "failed");
  assert.match(result.detail, /sudo npm install -g @openai\/codex@0\.163\.0 exited 1: sudo: a password is required/);
});

test("an install that succeeds but is shadowed on PATH is a failure, not a pass", async () => {
  const result = await ensurePinnedHarness(scripted({ versions: ["0.154.0", "0.154.0"] }), SPEC);
  assert.equal(result.status, "failed");
  assert.match(result.detail, /reports 0\.154\.0; another install shadows it on PATH/);
});

test("a package or version that could carry a flag is refused before npm runs", async () => {
  for (const bad of [{ installSpec: "--global-style" }, { version: "0.163.0 --foo" }, { installSpec: "@openai/codex;rm" }]) {
    const handle = scripted({ versions: ["0.154.0"] });
    const result = await ensurePinnedHarness(handle, { ...SPEC, ...bad });
    assert.equal(result.status, "failed");
    assert.ok(!handle.calls.some((c) => c.startsWith("npm") || c.startsWith("sudo")), JSON.stringify(bad));
  }
});

test("versionIn reads the version out of each harness's --version output", () => {
  assert.equal(versionIn("codex-cli 0.163.0\n"), "0.163.0");
  assert.equal(versionIn("2.1.304 (Claude Code)"), "2.1.304");
  assert.equal(versionIn("no version here"), null);
});

test("WINDKEEL_HARNESS_INSTALL: verify by default, pinned on request, anything else refused", () => {
  assert.equal(harnessInstallFromEnv({}), "verify");
  assert.equal(harnessInstallFromEnv({ WINDKEEL_HARNESS_INSTALL: "pinned" }), "pinned");
  assert.equal(harnessInstallFromEnv({ WINDKEEL_HARNESS_INSTALL: " Verify " }), "verify");
  assert.throws(() => harnessInstallFromEnv({ WINDKEEL_HARNESS_INSTALL: "latest" }), /WINDKEEL_HARNESS_INSTALL/);
});
