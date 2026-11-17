/**
 * #433: the snapshot secret-leak scan over the whole disk a snapshot keeps — `leakScanRoots` and
 * `scanForSecrets`, run for real (`sh` + `grep` on this machine) against a temp directory standing
 * in for `/`, plus stubbed shells for the failure modes a test machine cannot produce (a root the
 * scan may not enter when the test runs as root, a file grep could not read, a timeout, a `sudo`
 * that drops the environment).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leakScanRoots, scanForSecrets, SYSTEM_SCAN_ROOTS } from "../dist/factory/environment-snapshots.js";
import { secretForms } from "../dist/sandbox/redact.js";

const SECRET = "npm_Zq8vB3/mN7xK2+pL9wR4tY=&x";

/** A handle that runs on this machine, as `FakeSandboxProvider`'s does, and records every exec. */
function localHandle(checkoutPath, intercept) {
  const calls = [];
  return {
    checkoutPath,
    calls,
    async exec(command, options = {}) {
      calls.push({ command, args: options.args ?? [], env: options.env ?? {} });
      const stubbed = intercept?.(command, options.args ?? [], options.env ?? {});
      if (stubbed) return { signal: null, stdout: "", stderr: "", ...stubbed };
      const r = spawnSync(command, options.args ?? [], { encoding: "utf8", env: { ...process.env, ...(options.env ?? {}) } });
      return { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error.message } : {}) };
    },
  };
}

/** A temp directory laid out like a sandbox's disk: `<sys>/etc`, `<sys>/tmp`, …, a home, a checkout. */
function fakeDisk() {
  const sys = mkdtempSync(join(tmpdir(), "windkeel-leak-scan-"));
  for (const dir of ["etc", "tmp", "var/tmp", "usr/local/etc", "var/lib", "home/setup/work"]) mkdirSync(join(sys, dir), { recursive: true });
  writeFileSync(join(sys, "etc", "hosts"), "127.0.0.1 localhost\n");
  writeFileSync(join(sys, "home/setup/work", "README.md"), "nothing here\n");
  const checkout = join(sys, "home/setup/work");
  const roots = leakScanRoots({ checkoutPath: checkout, home: join(sys, "home/setup"), isolatedFilesystem: true, systemRoot: sys });
  return { sys, checkout, roots, cleanup: () => rmSync(sys, { recursive: true, force: true }) };
}

const scanCalls = (handle) => handle.calls.filter((c) => c.args.includes("windkeel-leak-scan"));

test("the roots: the checkout alone without an own filesystem; else $HOME and every system root, nested ones once", () => {
  assert.deepEqual(leakScanRoots({ checkoutPath: "/w/repo", home: "/home/dev", isolatedFilesystem: false }), ["/w/repo"]);

  const vercel = leakScanRoots({ checkoutPath: "/vercel/sandbox", home: "/home/vercel-sandbox", isolatedFilesystem: true });
  for (const root of ["/vercel/sandbox", "/home/vercel-sandbox", "/etc", "/tmp", "/var/tmp", "/usr/local/etc", "/opt", "/var/lib", "/root"]) {
    assert.ok(vercel.includes(root), `${root} is scanned`);
  }
  for (const pseudo of ["/", "/proc", "/sys", "/dev", "/run"]) assert.ok(!vercel.includes(pseudo), `${pseudo} is never a root`);

  // The checkout under $HOME is searched once, as part of $HOME; a checkout under /tmp, as part of /tmp.
  assert.ok(!leakScanRoots({ checkoutPath: "/home/u/repo", home: "/home/u/", isolatedFilesystem: true }).includes("/home/u/repo"));
  assert.ok(!leakScanRoots({ checkoutPath: "/tmp/repo", home: "/home/u", isolatedFilesystem: true }).includes("/tmp/repo"));
  // A $HOME of `/` (or none) never widens the scan to the pseudo filesystems.
  for (const home of ["/", "", "relative"]) {
    const roots = leakScanRoots({ checkoutPath: "/w", home, isolatedFilesystem: true });
    assert.deepEqual(roots, ["/w", ...SYSTEM_SCAN_ROOTS]);
  }
  assert.deepEqual(
    leakScanRoots({ checkoutPath: "/x/w", isolatedFilesystem: true, systemRoot: "/x" }).slice(1, 3),
    ["/x/etc", "/x/tmp"],
  );
});

test("a secret in /etc, /tmp and /usr/local/etc/npmrc (raw, URL-encoded, base64) is found, by name and file, in one pass", async () => {
  const disk = fakeDisk();
  try {
    writeFileSync(join(disk.sys, "etc", "x"), `token=${SECRET}\n`);
    writeFileSync(join(disk.sys, "tmp", "y"), `https://u:${encodeURIComponent(SECRET)}@registry.example.com/\n`);
    const b64 = spawnSync("sh", ["-c", 'echo "$S" | base64'], { encoding: "utf8", env: { ...process.env, S: SECRET } }).stdout;
    writeFileSync(join(disk.sys, "usr/local/etc", "npmrc"), `//registry.example.com/:_auth=${b64}`);
    writeFileSync(join(disk.checkout, ".token"), `${SECRET}\n`);

    const handle = localHandle(disk.checkout);
    const scan = await scanForSecrets(handle, { NPM_TOKEN: SECRET, OTHER: "an-unrelated-secret-value" }, disk.roots);
    assert.deepEqual(scan.incomplete, []);
    assert.deepEqual(scan.findings, [
      {
        key: "NPM_TOKEN",
        files: [join(disk.sys, "etc", "x"), join(disk.sys, "home/setup/work/.token"), join(disk.sys, "tmp", "y"), join(disk.sys, "usr/local/etc", "npmrc")].sort(),
      },
    ]);
    assert.ok(!JSON.stringify(scan).includes(SECRET), "the result never carries the value");
    assert.ok(scan.durationMs >= 0);
    assert.deepEqual(scan.absent.sort(), [join(disk.sys, "opt"), join(disk.sys, "root")].sort(), "absent roots are skipped, not failed");

    // One grep over every root; attribution only over the hits, one per secret.
    const passes = scanCalls(handle);
    assert.equal(passes.filter((c) => c.args.includes("roots")).length, 1);
    assert.deepEqual(passes.find((c) => c.args.includes("roots")).args.slice(4), disk.roots);
    assert.equal(passes.filter((c) => c.args.includes("files")).length, 2);
    // Patterns travel through the environment only.
    for (const call of handle.calls) {
      for (const form of secretForms(SECRET)) assert.ok(!call.args.some((a) => a.includes(form)), "never on argv");
    }
    assert.ok(passes[0].env.WINDKEEL_LEAK_PATTERNS.split("\n").includes(SECRET));
  } finally {
    disk.cleanup();
  }
});

test("a clean disk passes, and the scan writes nothing", async () => {
  const disk = fakeDisk();
  try {
    const before = spawnSync("find", [disk.sys], { encoding: "utf8" }).stdout;
    const scan = await scanForSecrets(localHandle(disk.checkout), { NPM_TOKEN: SECRET }, disk.roots);
    assert.deepEqual(scan.findings, []);
    assert.deepEqual(scan.incomplete, []);
    assert.equal(scan.searched.length, disk.roots.length - 2);
    assert.equal(spawnSync("find", [disk.sys], { encoding: "utf8" }).stdout, before);
  } finally {
    disk.cleanup();
  }
});

test("a multi-line secret is searched for by its longest line, not by a boilerplate header", async () => {
  const disk = fakeDisk();
  try {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
    writeFileSync(join(disk.sys, "etc", "some-cert.pem"), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
    let scan = await scanForSecrets(localHandle(disk.checkout), { KEY: pem }, disk.roots);
    assert.deepEqual(scan.findings, [], "a header alone is not the secret");
    writeFileSync(join(disk.sys, "tmp", "key.pem"), `${pem}\n`);
    scan = await scanForSecrets(localHandle(disk.checkout), { KEY: pem }, disk.roots);
    assert.deepEqual(scan.findings, [{ key: "KEY", files: [join(disk.sys, "tmp", "key.pem")] }]);
  } finally {
    disk.cleanup();
  }
});

test("a root the scan cannot enter makes it incomplete (real permissions)", { skip: process.getuid?.() === 0 ? "running as root: permissions do not bind" : false }, async () => {
  const disk = fakeDisk();
  try {
    chmodSync(join(disk.sys, "var/lib"), 0o000);
    writeFileSync(join(disk.sys, "etc", "locked"), SECRET);
    chmodSync(join(disk.sys, "etc", "locked"), 0o000);
    const scan = await scanForSecrets(localHandle(disk.checkout), { NPM_TOKEN: SECRET }, disk.roots);
    assert.ok(scan.incomplete.includes(`${join(disk.sys, "var/lib")}: root could not be searched`));
    assert.ok(scan.incomplete.some((i) => i.startsWith(`${join(disk.sys, "etc", "locked")} (Permission denied): could not be read`)), scan.incomplete.join("\n"));
  } finally {
    chmodSync(join(disk.sys, "var/lib"), 0o755);
    disk.cleanup();
  }
});

/** A shell that answers the scan's pass with canned output, as a real sandbox could. */
function cannedScan(answer) {
  return localHandle("/w", (command, args) => (args.includes("windkeel-leak-scan") ? answer(command, args) : null));
}

test("an unsearchable root, an unreadable file, a timeout and an unexplained error each make the scan incomplete, named", async () => {
  const cases = [
    [{ status: 1, stderr: "windkeel-leak-scan: unsearchable /var/lib\nwindkeel-leak-scan: exit 1\n" }, "/var/lib: root could not be searched"],
    [{ status: 2, stderr: "grep: /var/lib/pgsql/data/pg_hba.conf: Permission denied\nwindkeel-leak-scan: exit 2\n" }, "/var/lib/pgsql/data/pg_hba.conf (Permission denied): could not be read"],
    [{ status: 124, stderr: "windkeel-leak-scan: exit 124\n" }, "the scan: timed out after 900s"],
    [{ status: 2, stderr: "grep: memory exhausted\nwindkeel-leak-scan: exit 2\n" }, "the scan: grep reported an error (grep: memory exhausted)"],
  ];
  for (const [answer, expected] of cases) {
    const scan = await scanForSecrets(cannedScan(() => answer), { NPM_TOKEN: SECRET }, ["/w", "/etc", "/var/lib"]);
    assert.deepEqual(scan.findings, []);
    assert.deepEqual(scan.incomplete, [expected]);
  }
  // A file that vanished mid-scan is not on the disk, and is not a failure; a grep warning is noise.
  const scan = await scanForSecrets(
    cannedScan(() => ({ status: 2, stderr: "grep: warning: GREP_COLOR is deprecated\ngrep: /tmp/x.lock: No such file or directory\nwindkeel-leak-scan: exit 2\n" })),
    { NPM_TOKEN: SECRET },
    ["/w", "/tmp"],
  );
  assert.deepEqual(scan.incomplete, []);
});

test("a scan that did not run to the end is never read as clean", async () => {
  // No marker: the shell never ran the script (or `sudo` would not keep the environment).
  await assert.rejects(
    scanForSecrets(cannedScan(() => ({ status: 1, stderr: "" })), { NPM_TOKEN: SECRET }, ["/w"]),
    /the secret scan did not run to completion/,
  );
});

test("with escalate, the scan runs through passwordless sudo, and falls back unprivileged when sudo drops the patterns", async () => {
  const disk = fakeDisk();
  try {
    writeFileSync(join(disk.sys, "etc", "x"), SECRET);
    // sudo that runs the script with the environment kept: stands in by running it directly.
    const kept = localHandle(disk.checkout, (command, args, env) => {
      if (command === "id") return { status: 0, stdout: "1000\n" };
      if (command === "sudo" && args[1] === "true") return { status: 0 };
      if (command === "sudo") {
        assert.match(args[1], /^--preserve-env=WINDKEEL_LEAK_PATTERNS,/);
        const r = spawnSync(args[2], args.slice(3), { encoding: "utf8", env: { ...process.env, ...env } });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      return null;
    });
    let scan = await scanForSecrets(kept, { NPM_TOKEN: SECRET }, disk.roots, { escalate: true });
    assert.equal(scan.asRoot, true);
    assert.deepEqual(scan.findings, [{ key: "NPM_TOKEN", files: [join(disk.sys, "etc", "x")] }]);
    assert.ok(!kept.calls.some((c) => c.command === "sh" && c.args.includes("windkeel-leak-scan")), "every pass went through sudo");

    // sudo that refuses to preserve the environment: exit 1 and no marker — never "no match".
    const refused = localHandle(disk.checkout, (command, args) => {
      if (command === "id") return { status: 0, stdout: "1000\n" };
      if (command === "sudo" && args[1] === "true") return { status: 0 };
      if (command === "sudo") return { status: 1, stderr: "sudo: sorry, you are not allowed to preserve the environment\n" };
      return null;
    });
    scan = await scanForSecrets(refused, { NPM_TOKEN: SECRET }, disk.roots, { escalate: true });
    assert.equal(scan.asRoot, false);
    assert.deepEqual(scan.findings, [{ key: "NPM_TOKEN", files: [join(disk.sys, "etc", "x")] }]);

    // Without escalate (FakeSandboxProvider: the developer's machine), sudo is never tried.
    const plain = localHandle(disk.checkout);
    await scanForSecrets(plain, { NPM_TOKEN: SECRET }, disk.roots);
    assert.ok(!plain.calls.some((c) => c.command === "sudo" || c.command === "id"));
  } finally {
    disk.cleanup();
  }
});

test("no secret long enough to search for: nothing runs", async () => {
  const handle = localHandle("/w");
  const scan = await scanForSecrets(handle, { PIN: "1234" }, ["/w"]);
  assert.deepEqual(scan, { findings: [], incomplete: [], absent: [], searched: [], asRoot: false, durationMs: scan.durationMs });
  assert.equal(handle.calls.length, 0);
});
