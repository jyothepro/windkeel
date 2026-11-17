import assert from "node:assert/strict";
import { after, before, describe, it, test } from "node:test";
import { runInExecutionPhase } from "../dist/sandbox/lifecycle.js";
import { VercelSandboxProvider } from "../dist/sandbox/vercel.js";
import { installDeclaredTools, installScanners } from "../dist/sandbox/system-tools.js";
import { toolInstalled } from "@windkeel/verification/exec/environment.js";
import { runSecurity } from "@windkeel/verification/stages/security.js";
import {
  scannerAssets,
} from "@windkeel/verification/stages/scanner-assets.js";

const credentials = {
  token: process.env.WINDKEEL_SANDBOX_TOKEN ?? process.env.VERCEL_TOKEN,
  teamId: process.env.WINDKEEL_SANDBOX_TEAM_ID ?? process.env.VERCEL_TEAM_ID,
  projectId: process.env.WINDKEEL_SANDBOX_PROJECT_ID ?? process.env.VERCEL_PROJECT_ID,
};
const hasVercel = credentials.token && credentials.teamId && credentials.projectId;

/**
 * A small, always-available public git repo — used only as clone fodder for the real-sandbox
 * tests below; its contents don't matter, only that clone-at-create succeeds.
 */
const PUBLIC_REPO_URL = "https://github.com/octocat/Hello-World.git";

test("VercelSandboxProvider.capabilities names every obligation", () => {
  const provider = new VercelSandboxProvider({
    token: "fake-token",
    teamId: "fake-team",
    projectId: "fake-project",
  });
  assert.deepEqual(provider.capabilities, {
    credentialBrokering: true,
    phasedEgress: true,
    // Spike A verified reattachment across genuinely separate node processes, passing only the
    // sandbox name; `create()` now supplies an explicit name and `persistent: true` so that
    // name is a reference a caller can persist.
    reattachable: true,
    // A microVM with its own root filesystem, created per workspace and destroyed with it —
    // which is what makes installing binaries into it safe to do at all.
    isolatedFilesystem: true,
    // #387: off unless the provider is constructed with `environmentSnapshots` (the feature flag),
    // because restore-then-fetch has not yet been exercised live.
    snapshots: false,
  });
  assert.equal(provider.name, "vercel");
  const flagged = new VercelSandboxProvider({
    token: "fake-token",
    teamId: "fake-team",
    projectId: "fake-project",
    environmentSnapshots: true,
  });
  assert.equal(flagged.capabilities.snapshots, true);
});

test(
  "create() clones a real repo and exec() runs a command in it",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  async () => {
    const provider = new VercelSandboxProvider({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });
    const handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });
    try {
      const result = await handle.exec("echo", { args: ["hello"] });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /hello/);
    } finally {
      await assert.doesNotReject(() => handle.destroy());
    }
  },
);

test(
  "destroy() really deletes the sandbox — a later exec() fails",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  async () => {
    const provider = new VercelSandboxProvider({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });
    const handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });
    await handle.destroy();

    let threwOrFailed = false;
    try {
      const result = await handle.exec("echo", { args: ["should-not-run"] });
      threwOrFailed = result.status !== 0;
    } catch {
      threwOrFailed = true;
    }
    assert.equal(threwOrFailed, true);
  },
);

test(
  "maker sandbox gets the CODEX_API_KEY placeholder, never the real broker secret (ADR-0014 §1)",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  async () => {
    const fakeOpenAiKeyEnvVar = "WINDKEEL_TEST_FAKE_OPENAI_API_KEY";
    process.env[fakeOpenAiKeyEnvVar] = "Bearer sk-fake-test-value-should-never-reach-sandbox";

    const provider = new VercelSandboxProvider({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      makerModelApiDomain: "api.openai.com",
      makerModelKeyEnvVar: fakeOpenAiKeyEnvVar,
    });

    let handle;
    try {
      handle = await provider.create({ role: "maker", repoUrl: PUBLIC_REPO_URL });

      const result = await handle.exec("printenv", { args: ["CODEX_API_KEY"] });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), "brokered-do-not-use-directly");
      assert.doesNotMatch(result.stdout, /sk-fake-test-value-should-never-reach-sandbox/);
    } finally {
      delete process.env[fakeOpenAiKeyEnvVar];
      if (handle) await assert.doesNotReject(() => handle.destroy());
    }
  },
);

test(
  "applyCredentialBrokerRules registers a network policy update (best-effort — no live model-domain call)",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  async () => {
    const fakeSecretEnvVar = "WINDKEEL_TEST_FAKE_BROKER_SECRET";
    process.env[fakeSecretEnvVar] = "Bearer sk-fake-network-policy-test";

    const provider = new VercelSandboxProvider({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });

    let handle;
    try {
      handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });
      await assert.doesNotReject(() =>
        handle.applyCredentialBrokerRules([
          { domain: "example-broker-test.invalid", header: "Authorization", secretEnvVar: fakeSecretEnvVar },
        ]),
      );
    } finally {
      delete process.env[fakeSecretEnvVar];
      if (handle) await assert.doesNotReject(() => handle.destroy());
    }
  },
);

describe(
  "VercelSandboxHandle file I/O (issue #99)",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  () => {
    /** @type {import("../dist/sandbox/provider.js").SandboxHandle} */
    let handle;

    before(async () => {
      const provider = new VercelSandboxProvider({
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      });
      handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });
    });

    after(async () => {
      if (handle) await handle.destroy();
    });

    it("writeFile then readFile round-trips a UTF-8 string byte-for-byte", async () => {
      const path = "/tmp/windkeel-test-utf8.txt";
      const content = "hello, windkeel — issue #99 🎉";
      await handle.writeFile(path, content);
      const readBack = await handle.readFile(path);
      assert.equal(readBack.toString("utf8"), content);
    });

    it("writeFile then readFile round-trips a raw binary Buffer byte-for-byte", async () => {
      const path = "/tmp/windkeel-test-binary.bin";
      const content = Buffer.from([0, 1, 2, 3, 255, 254, 253, 10, 13, 0]);
      await handle.writeFile(path, content);
      const readBack = await handle.readFile(path);
      assert.deepEqual(readBack, content);
    });

    it("exists() is true for a file just written, false for one never created", async () => {
      const path = "/tmp/windkeel-test-exists.txt";
      await handle.writeFile(path, "present");
      assert.equal(await handle.exists(path), true);
      assert.equal(await handle.exists("/tmp/windkeel-test-never-created.txt"), false);
    });

    it("listFiles returns nested files with correct relative paths and byte sizes", async () => {
      const root = "/tmp/windkeel-test-listing";
      await handle.exec("mkdir", { args: ["-p", `${root}/sub`] });
      await handle.writeFile(`${root}/top.txt`, "1234567890");
      await handle.writeFile(`${root}/sub/nested.txt`, "abc");

      const files = await handle.listFiles(root);
      const byPath = new Map(files.map((f) => [f.path, f.bytes]));
      assert.equal(byPath.size, 2);
      assert.equal(byPath.get("top.txt"), 10);
      assert.equal(byPath.get("sub/nested.txt"), 3);
    });

    it("listFiles on a directory that does not exist returns [], not a thrown error", async () => {
      const result = await handle.listFiles("/tmp/windkeel-test-does-not-exist");
      assert.deepEqual(result, []);
    });

    it("mkdtemp returns a fresh, existing path outside the git checkout root", async () => {
      const dirA = await handle.mkdtemp("windkeel-mkdtemp-");
      const dirB = await handle.mkdtemp("windkeel-mkdtemp-");

      assert.notEqual(dirA, dirB);
      assert.equal(dirA.startsWith("/tmp/"), true);
      assert.equal(dirB.startsWith("/tmp/"), true);
      assert.equal(dirA.startsWith("/vercel/sandbox"), false);
      assert.equal(dirB.startsWith("/vercel/sandbox"), false);

      const existsResult = await handle.exec("test", { args: ["-d", dirA] });
      assert.equal(existsResult.status, 0);
    });

    it("a filename containing shell metacharacters is written literally, not executed", async () => {
      const dir = "/tmp/windkeel-test-shell-meta";
      await handle.exec("mkdir", { args: ["-p", dir] });
      const dangerousName = "a;rm -rf /";
      const siblingPath = `${dir}/sibling.txt`;
      await handle.writeFile(siblingPath, "untouched");

      await handle.writeFile(`${dir}/${dangerousName}`, "literal-content");

      // The sibling file must still exist untouched — proof the semicolon in the filename
      // never reached a shell.
      assert.equal(await handle.exists(siblingPath), true);
      const sibling = await handle.readFile(siblingPath);
      assert.equal(sibling.toString("utf8"), "untouched");

      const files = await handle.listFiles(dir);
      const names = files.map((f) => f.path);
      assert.ok(names.includes(dangerousName));
    });

    it("a directory argument to listFiles containing a single quote does not execute as a command", async () => {
      const dir = "/tmp/windkeel-test-quote-dir/it's-a-dir";
      await handle.exec("mkdir", { args: ["-p", dir] });
      await handle.writeFile(`${dir}/file.txt`, "safe");

      const files = await handle.listFiles(dir);
      assert.deepEqual(
        files.map((f) => f.path),
        ["file.txt"],
      );

      // Prove no injection happened: a canary file that a naive `"$dir"` interpolation bug
      // (e.g. closing the quote early) could have let `rm -rf` reach was never created.
      const canary = await handle.exists("/tmp/windkeel-injection-canary");
      assert.equal(canary, false);
    });
  },
);

test(
  "runInExecutionPhase actually narrows egress — a request outside the execution allowlist fails/times out fast",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  async () => {
    const provider = new VercelSandboxProvider({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });

    let handle;
    try {
      handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });

      // "example.com" is not the execution-phase model API domain, so once
      // runInExecutionPhase has narrowed egress, a request to it should be refused by the
      // sandbox's egress proxy rather than actually reaching the internet — proving the
      // narrowing is live, not merely accepted by the API.
      const result = await runInExecutionPhase(
        handle,
        "api.openai.com",
        [],
        "curl",
        { args: ["--max-time", "10", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"] },
      );

      // A blocked egress proxy request surfaces as either a non-zero curl exit status
      // (connection refused/reset) or an ExecResult.error — either way, not a clean 200.
      const succeededAnyway = result.status === 0 && result.stdout.trim() === "200";
      assert.equal(succeededAnyway, false, "request to a domain outside the execution allowlist should not succeed");
    } finally {
      if (handle) await assert.doesNotReject(() => handle.destroy());
    }
  },
);

/**
 * #196's pass criterion against the real SDK: a sandbox created by one process, re-acquired by
 * a **second `node` process** that holds nothing but the sandbox name.
 *
 * Credential-gated, so `npm test` stays green without Vercel access — the same property is
 * proven unconditionally against `FakeSandboxProvider` in `test/sandbox-reattach.test.js`,
 * which is reattachable for real rather than by pretending.
 *
 * It crosses a genuine process boundary deliberately. Reattaching inside the process that still
 * holds the live object would pass against a provider that simply returned its own cache, which
 * is exactly the mistake Spike A made and caught. Only strings travel, through a file.
 */
test(
  "a real Vercel sandbox is re-acquired, read and destroyed by a separate process",
  { skip: hasVercel ? false : "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID not set" },
  async () => {
    const { spawnSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { repoRoot, tempDir } = await import("./helpers.js");

    const provider = new VercelSandboxProvider({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });
    const handle = await provider.create({ role: "maker", repoUrl: PUBLIC_REPO_URL });

    // An explicit name is the whole point: a random one is not a reference anyone can persist.
    assert.match(handle.id, /^windkeel-maker-/, "create() supplies a name the caller can write down");

    // Something only the creating process could have written, so a reattach cannot fake it.
    const marker = `reattach-${Date.now()}`;
    await handle.writeFile(`/tmp/${marker}.txt`, `${marker}\n`);

    const handoff = join(tempDir("vercel-reattach"), "ref.json");
    writeFileSync(handoff, JSON.stringify({ handleId: handle.id, role: "maker", marker }));

    const child = join(tempDir("vercel-reattach-child"), "child.mjs");
    writeFileSync(
      child,
      `
      import { readFileSync } from "node:fs";
      import { VercelSandboxProvider } from "${join(repoRoot, "dist/sandbox/vercel.js")}";
      const ref = JSON.parse(readFileSync(${JSON.stringify(handoff)}, "utf8"));
      const provider = new VercelSandboxProvider({
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      });
      const attached = await provider.attach({ role: ref.role, handleId: ref.handleId });
      const body = await attached.readFile("/tmp/" + ref.marker + ".txt");
      console.log(JSON.stringify({ id: attached.id, body: body.toString("utf8").trim() }));
      // And stop it — the half that makes ADR-0011's caps honest and #198's reaper possible.
      await attached.destroy();
      `,
    );

    const result = spawnSync(process.execPath, [child], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(result.status, 0, `child process failed: ${result.stderr}`);

    const seen = JSON.parse(result.stdout.trim());
    assert.equal(seen.id, handle.id, "the same sandbox, by name");
    assert.equal(seen.body, marker, "a fresh process read what the first one wrote");

    // Destroying an already-destroyed sandbox must not throw here: the child ended it, and a
    // teardown that failed because someone else already tidied up would be a false alarm.
    await handle.destroy().catch(() => {});
  },
);


/**
 * The three places this handle silently disagreed with `FakeSandboxProvider`, each of which
 * ended a real deployed run and none of which the suite could see — because the fake is right
 * by construction on all three and these tests are the only ones that talk to the platform,
 * and they are gated on credentials CI does not have.
 *
 * They are still written down. A gap nobody can reproduce is worse than one that needs a
 * credential, and every one of these was diagnosed from a failure three layers away from it.
 */
describe("parity with the execution-environment contract", { skip: hasVercel ? false : "no sandbox credentials" }, () => {
  let provider;
  let handle;

  before(async () => {
    provider = new VercelSandboxProvider(credentials);
    handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });
  });
  after(async () => {
    if (handle) await handle.destroy();
  });

  it("puts checkoutPath where the clone actually is", async () => {
    // It was the constant "/vercel/sandbox"; the platform clones into $HOME/<repo-name>.
    const result = await handle.exec("git", { args: ["rev-parse", "--is-inside-work-tree"] });
    assert.equal(result.status, 0, `checkoutPath ${handle.checkoutPath} is not a git checkout`);
    assert.match(result.stdout, /true/);
  });

  it("defaults exec's cwd to the checkout", async () => {
    const result = await handle.exec("pwd", { args: [] });
    assert.equal(result.stdout.trim(), handle.checkoutPath);
  });

  it("reports a command that cannot start as a result, not an exception", async () => {
    // `ExecResult.error`: "set when the command could not be started at all". `toolInstalled`
    // asks every optional scanner this question and expects a falsy answer for an absent one.
    const result = await handle.exec("definitely-not-installed-anywhere", { args: ["--version"] });
    assert.equal(result.status, null);
    assert.ok(result.error, "a command that could not start must report an error, not throw");
  });

  it("runs a bare command string through a shell", async () => {
    // `ExecOptions.args`: "when absent the command string runs through a shell". The
    // verification engine's discovered checks are exactly this shape, e.g. `npm run --silent test`.
    const result = await handle.exec("echo one two | tr ' ' '-'");
    assert.equal(result.status, 0, result.error ?? result.stderr);
    assert.match(result.stdout, /one-two/);
  });
});

/**
 * #219 in the only place it can actually be proven: a real sandbox on the real image.
 *
 * Everything else about this feature is asserted against doubles, which is exactly how four
 * platform-parity bugs survived #218 — the gate that makes these tests invisible in CI is the
 * gate that made those bugs invisible. So this suite is written even though CI cannot run it, and
 * it asserts the things only the platform can answer: that the image has a package manager at
 * all, that a binary installed into it is on `PATH` for a later `exec`, and what the whole thing
 * costs per verification, since ADR-0004 pays it on every run.
 *
 * Run it with sandbox credentials set:
 *   WINDKEEL_SANDBOX_TOKEN=… WINDKEEL_SANDBOX_TEAM_ID=… WINDKEEL_SANDBOX_PROJECT_ID=… \
 *     node --test test/sandbox-vercel.test.js
 */
describe(
  "installing tools into a real sandbox (#219)",
  { skip: hasVercel ? false : "no sandbox credentials" },
  () => {
    let provider;
    let handle;
    /** Set by the install test and read by the one that checks the scan can still work. */
    let scannerAssetDir;

    before(async () => {
      provider = new VercelSandboxProvider(credentials);
      handle = await provider.create({ role: "verifier", repoUrl: PUBLIC_REPO_URL });
    });
    after(async () => {
      if (handle) await handle.destroy();
    });

    it("has one of the package managers the installer knows how to drive", async () => {
      const found = [];
      for (const manager of ["dnf", "microdnf", "apt-get", "apk", "yum"]) {
        if ((await handle.exec(manager, { args: ["--version"] })).status === 0) found.push(manager);
      }
      // If this fails, a repo's `tools` declaration can never be honoured on this image, and the
      // installer's "no package manager" outcome is the only honest thing it can report.
      assert.ok(found.length, "no known package manager on the sandbox image");
    });

    it("installs the engine's scanners, and they answer on PATH afterwards", async () => {
      const started = Date.now();
      const { installs: outcomes, assetDir } = await installScanners(handle);
      const elapsed = Date.now() - started;
      scannerAssetDir = assetDir;

      for (const outcome of outcomes) {
        assert.equal(outcome.status, "installed", `${outcome.tool}: ${outcome.detail}`);
      }
      // The point of installing them is that the *stage* finds them, and the stage asks exactly
      // this question through `toolInstalled`.
      for (const tool of ["gitleaks", "osv-scanner", "semgrep"]) {
        assert.equal(await toolInstalled(handle, tool), true, `${tool} is not on PATH`);
      }
      // ADR-0004 pays this on every verification; the figure belongs in the record, not a comment.
      console.log(
        `[#219] scanner install on a real sandbox: ${(elapsed / 1000).toFixed(1)}s — ` +
          outcomes.map((o) => `${o.tool} ${(o.durationMs / 1000).toFixed(1)}s`).join(", "),
      );
    });

    it("leaves the scanners able to work after egress narrows", async () => {
      // The whole reason the databases and the ruleset are fetched in the install phase. Once
      // `runInExecutionPhase` has narrowed egress, `api.osv.dev` and the semgrep registry are
      // gone, and a scanner that still needed them would report an empty section that reads
      // exactly like a clean result.
      // A real manifest, because osv-scanner downloads databases for the ecosystems it actually
      // finds — against a checkout with none it exits 128 ("No package sources found") and
      // fetches nothing, which is correct behaviour and proves nothing about the download.
      await handle.writeFile(
        `${handle.checkoutPath}/package-lock.json`,
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "fixture", version: "1.0.0", dependencies: { lodash: "4.17.20" } },
            "node_modules/lodash": {
              version: "4.17.20",
              resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
            },
          },
        }),
      );
      const warmed = await installScanners(handle);
      scannerAssetDir = warmed.assetDir;

      const assets = scannerAssets(scannerAssetDir);
      assert.equal(await handle.exists(assets.osvMarker), true, "offline OSV database missing");
      assert.equal(await handle.exists(assets.semgrepRules), true, "semgrep ruleset was not pre-fetched");

      const security = await runSecurity(handle, "ev-01", handle.checkoutPath, undefined, assets);
      assert.notEqual(security.evidence.status, "skipped");
      for (const scanner of security.evidence.scanners) {
        assert.equal(scanner.ran, true, `${scanner.tool} did not run: ${scanner.note}`);
      }
    });

    it("installs a package a repository declared", async () => {
      /**
       * `restic`, and the absence check above it, because the version of this test that asked for
       * `jq` passed against a completely broken installer: `jq` is **preinstalled** on the image,
       * so `apt-get install -y jq` exited 0 without the package manager reaching an archive at
       * all. Meanwhile no archive was reachable — the image ships `http://` sources and the
       * egress proxy does not pass port 80 — so every package that was *not* already present
       * came back `E: Unable to locate package`, and #219's tools feature was inert in production
       * behind a green test.
       *
       * So the test now names a package the image does not carry, and proves it was absent first.
       * `restic` is also the package that started #219: content-machine's suite shells out to it.
       */
      assert.notEqual(
        (await handle.exec("restic", { args: ["version"] })).status,
        0,
        "restic is already present, so this test cannot prove an install happened",
      );

      const outcomes = await installDeclaredTools(handle, [
        { package: "restic", reason: "a repository's checks shell out to it" },
      ]);

      assert.equal(outcomes[0].status, "installed", outcomes[0].detail);
      assert.equal((await handle.exec("restic", { args: ["version"] })).status, 0);
    });

    it("refuses a declaration that is not a package name, before any install runs", async () => {
      const outcomes = await installDeclaredTools(handle, [], [
        { value: "https://evil.example.com/tool.sh", reason: "not a package name" },
      ]);

      assert.equal(outcomes[0].status, "rejected");
    });
  },
);
