/**
 * The pure halves of the 2026-10-16 amendment to ADR-0014: redacting secret values out of
 * persisted text, the allowlist a capture holds `.git/config` to, scrubbing a clone credential, and
 * the shape of the Vercel process sweep. The behaviour around them — the capture's ordering, the
 * install's two steps, the PR pin — is asserted where it happens, in
 * `workflow-candidate-capture.test.js`, `sandbox-dependencies.test.js` and
 * `workflow-pr-creating.test.js`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { REDACTED, redactDeep, redactSecrets, secretForms, secretRedactor } from "../dist/sandbox/redact.js";
import { assertSafeGitConfig, HARDENED_GIT_ARGS, refusedKeys } from "../dist/sandbox/git-hardening.js";
import {
  CloneCredentialScrubError,
  installGitCredential,
  removeGitCredential,
  scrubCloneCredentials,
  storeFilesOf,
  stripUserinfo,
  usesDefaultStore,
} from "../dist/sandbox/git-credentials.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRAY_PROCESS_SWEEP } from "../dist/sandbox/vercel.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { fixtureRepo } from "./helpers.js";

// --- Redaction ---

test("a secret is redacted raw, URL-encoded, and base64-encoded at every alignment", () => {
  const secret = "s3cr3t/value+with=odd chars";
  const redact = secretRedactor({ TOKEN: secret });
  const texts = [
    `token is ${secret}.`,
    `https://u:${encodeURIComponent(secret)}@host/`,
    Buffer.from(secret).toString("base64"),
    Buffer.from(`${secret}\n`).toString("base64"),
    Buffer.from(`a${secret}`).toString("base64"),
    Buffer.from(`ab${secret}`).toString("base64"),
    Buffer.from(`Basic x:${secret}`).toString("base64url"),
  ];
  for (const text of texts) {
    const out = redact(text);
    assert.ok(out.includes(REDACTED), `nothing redacted in ${text}`);
    for (const form of secretForms(secret)) assert.ok(!out.includes(form), `${form} survived in ${out}`);
  }
});

test("redaction leaves text without the secret alone, and ignores values too short to matter", () => {
  assert.equal(redactSecrets("npm ERR! 404 Not Found", { TOKEN: "abcdef123456" }), "npm ERR! 404 Not Found");
  assert.deepEqual(secretForms("abc"), [], "a three-character value would shred every message");
  assert.equal(redactSecrets("exit 1", { FLAG: "1" }), "exit 1");
});

test("redactDeep reaches every string in a record about to be persisted", () => {
  const record = { detail: "has SECRETVALUE", installs: [{ detail: "x SECRETVALUE y", status: "failed" }], n: 3 };
  const out = redactDeep(record, secretRedactor(["SECRETVALUE"]));
  assert.ok(!JSON.stringify(out).includes("SECRETVALUE"));
  assert.equal(out.n, 3);
  assert.equal(out.installs[0].status, "failed");
});

// --- The capture's .git/config allowlist ---

test("the keys a clone and a commit produce pass; anything that runs a command does not", () => {
  const ordinary = [
    "core.repositoryformatversion\n0",
    "core.filemode\ntrue",
    "core.bare\nfalse",
    "core.logallrefupdates\ntrue",
    "core.ignorecase\ntrue",
    "core.precomposeunicode\ntrue",
    "remote.origin.url\nhttps://github.com/o/r.git",
    "remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*",
    "branch.main.remote\norigin",
    "branch.main.merge\nrefs/heads/main",
    "branch.Feature/X.merge\nrefs/heads/Feature/X",
    "user.name\nWindkeel",
    "user.email\nf@o.invalid",
  ];
  assert.deepEqual(refusedKeys(ordinary.join("\0") + "\0"), []);

  const hostile = [
    "core.hookspath\n/tmp/h",
    "core.fsmonitor\n/tmp/x",
    "core.sshcommand\nsh -c evil",
    "core.pager\nevil",
    "core.worktree\n/elsewhere",
    "credential.helper\n!evil",
    "credential.https://github.com.helper\n!evil",
    "include.path\n/tmp/more",
    "includeif.gitdir:/.path\n/tmp/more",
    "url.https://evil/.insteadof\nhttps://github.com/",
    "filter.lfs.clean\nevil %f",
    "diff.x.textconv\nevil",
    "gpg.program\nevil",
    "remote.origin.pushurl\nhttps://github.com/attacker/x",
    "remote./tmp/bare.receivepack\nevil",
    "extensions.worktreeconfig\ntrue",
    "http.https://github.com/.extraheader\nAUTHORIZATION: x",
    "Core.HooksPath\n/tmp/h",
  ];
  const refused = refusedKeys(hostile.join("\0") + "\0");
  assert.equal(refused.length, hostile.length, `refused only: ${refused.join(", ")}`);
});

test("the hardening resets credential helpers before anything can add one", () => {
  const reset = HARDENED_GIT_ARGS.indexOf("credential.helper=");
  assert.ok(reset > 0 && HARDENED_GIT_ARGS[reset - 1] === "-c");
  assert.ok(HARDENED_GIT_ARGS.includes("core.hooksPath=/dev/null"));
  assert.ok(HARDENED_GIT_ARGS.includes("protocol.allow=never"));
});

// --- The clone credential ---

test("userinfo is stripped from a remote URL; a clean URL is unchanged", () => {
  assert.equal(stripUserinfo("https://x-access-token:ghs_abc@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(stripUserinfo("https://github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(stripUserinfo("/tmp/bare.git"), "/tmp/bare.git");
});

test("a clone credential left in .git/config is scrubbed before anything else runs", async () => {
  const handle = await new FakeSandboxProvider().create({ role: "verifier", repoUrl: fixtureRepo({}) });
  try {
    const git = (...args) => spawnSync("git", args, { cwd: handle.checkoutPath, encoding: "utf8" });
    git("remote", "set-url", "origin", "https://x-access-token:ghs_leaked@github.com/o/r.git");
    git("config", "--local", "http.https://github.com/.extraheader", "AUTHORIZATION: basic Z2hzX2xlYWtlZA==");
    await scrubCloneCredentials(handle);
    assert.equal(git("remote", "get-url", "origin").stdout.trim(), "https://github.com/o/r.git");
    const config = git("config", "--local", "--list").stdout;
    assert.ok(!config.includes("ghs_leaked") && !config.includes("extraheader"), config);
  } finally {
    await handle.destroy();
  }
});

test("a credential helper the platform's clone left is removed, with its store, so the capture accepts the checkout", async () => {
  // content-machine#98, run 637c7e05: the maker's .git/config carried
  // credential.https://github.com/<owner>/<name>.git.helper, and the capture refused to run git.
  const handle = await new FakeSandboxProvider().create({ role: "maker", repoUrl: fixtureRepo({}) });
  const store = join(mkdtempSync(join(tmpdir(), "windkeel-store-")), "credentials");
  try {
    const git = (...args) => spawnSync("git", args, { cwd: handle.checkoutPath, encoding: "utf8" });
    writeFileSync(store, "https://x-access-token:ghs_stored@github.com\n");
    git("config", "--local", "credential.https://github.com/o/r.git.helper", `store --file ${store}`);
    git("config", "--local", "credential.https://github.com/o/r.git.username", "x-access-token");
    await assert.rejects(assertSafeGitConfig((cmd, o) => handle.exec(cmd, o)), /credential\./, "the capture refuses it as left");

    await scrubCloneCredentials(handle, "ghs_stored");

    assert.equal(git("config", "--local", "--get-regexp", "^credential\\.").status, 1, "no credential key remains");
    assert.equal(existsSync(store), false, "the store file holding the token is gone");
    await assertSafeGitConfig((cmd, o) => handle.exec(cmd, o));
  } finally {
    await handle.destroy();
  }
});

test("store helper parsing: --file, --file=, the default store, and helpers that store nothing", () => {
  assert.deepEqual(storeFilesOf("store --file /tmp/c"), ["/tmp/c"]);
  assert.deepEqual(storeFilesOf("store --file=/tmp/c"), ["/tmp/c"]);
  assert.deepEqual(storeFilesOf("git-credential-store --file /a --file=/b"), ["/a", "/b"]);
  assert.deepEqual(storeFilesOf("!f() { echo password=$T; }; f"), []);
  assert.deepEqual(storeFilesOf("cache --timeout 60"), []);
  assert.equal(usesDefaultStore("store"), true);
  assert.equal(usesDefaultStore("store --file /tmp/c"), false);
  assert.equal(usesDefaultStore("cache"), false);
});

// --- The process sweep ---

test("the Vercel process sweep is valid POSIX sh, and the fake honestly cannot sweep", async () => {
  // The script needs Linux's /proc and a sandbox of its own to run for real — running it here
  // would stop this machine's processes. Parsing it is what can be checked off-platform; the
  // behaviour has to be confirmed against a live sandbox (see the PR).
  const parsed = spawnSync("sh", ["-n", "-c", STRAY_PROCESS_SWEEP], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(STRAY_PROCESS_SWEEP, /kill -STOP/);
  assert.match(STRAY_PROCESS_SWEEP, /kill -KILL/);

  const handle = await new FakeSandboxProvider().create({ role: "maker", repoUrl: fixtureRepo({}) });
  try {
    const sweep = await handle.terminateStrayProcesses();
    assert.equal(sweep.ensured, false);
    assert.equal(sweep.noSandbox, true, "distinguishable from a real sandbox that failed to sweep");
    assert.match(sweep.reason, /runs on the host/);
  } finally {
    await handle.destroy();
  }
});

// --- PR #356 review: fail closed on credential cleanup, verify the scrub, URL-named remotes ---

/** A handle whose `rm` can be told to fail, around a real temp directory. */
function cleanupHandle({ rmStatus = 0, leaveFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "windkeel-rm-test-"));
  return {
    dir,
    checkoutPath: dir,
    mkdtemp: async () => dir,
    writeFile: async (path, data) => writeFileSync(path, data),
    exists: async (path) => existsSync(path),
    exec: async (command, options = {}) => {
      if (command === "rm") {
        if (!leaveFile && rmStatus === 0) rmSync(options.args[1], { force: true });
        return { status: rmStatus, signal: null, stdout: "", stderr: rmStatus ? "rm: Permission denied" : "" };
      }
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  };
}

const CREDENTIAL = {
  username: "x-access-token",
  token: "ghs_cleanup_test_token",
  permission: "write",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

test("removing the git credential throws when rm fails, instead of leaving the token for the next turn", async () => {
  const handle = cleanupHandle({ rmStatus: 1, leaveFile: true });
  const path = await installGitCredential(handle, "github.com", CREDENTIAL);
  await assert.rejects(() => removeGitCredential(handle), /could not confirm the git credential file was removed/);
  assert.ok(existsSync(path), "the scenario: the token really is still there");
});

test("removing the git credential throws when the file survives a zero-exit rm", async () => {
  const handle = cleanupHandle({ leaveFile: true });
  await installGitCredential(handle, "github.com", CREDENTIAL);
  await assert.rejects(() => removeGitCredential(handle), /must not be reused with a live token/);
});

test("removing the git credential succeeds only when the file is gone", async () => {
  const handle = cleanupHandle();
  const path = await installGitCredential(handle, "github.com", CREDENTIAL);
  await removeGitCredential(handle);
  assert.ok(!existsSync(path));
});

test("a clone scrub that cannot rewrite the remote fails provisioning", async () => {
  const handle = await new FakeSandboxProvider().create({ role: "verifier", repoUrl: fixtureRepo({}) });
  try {
    spawnSync("git", ["remote", "set-url", "origin", "https://x-access-token:ghs_leaked@github.com/o/r.git"], {
      cwd: handle.checkoutPath,
    });
    const exec = handle.exec.bind(handle);
    handle.exec = (command, options) =>
      options?.args?.[1] === "set-url"
        ? Promise.resolve({ status: 1, signal: null, stdout: "", stderr: "error: could not lock config file" })
        : exec(command, options);
    await assert.rejects(() => scrubCloneCredentials(handle, "ghs_leaked"), (error) => {
      assert.ok(error instanceof CloneCredentialScrubError);
      assert.match(error.message, /could not strip the credential from remote origin/);
      return true;
    });
  } finally {
    await handle.destroy();
  }
});

test("a clone token anywhere in .git — in a shape the scrub does not know — fails provisioning", async () => {
  const handle = await new FakeSandboxProvider().create({ role: "verifier", repoUrl: fixtureRepo({}) });
  try {
    writeFileSync(join(handle.checkoutPath, ".git", "description"), "cloned with ghs_hidden_token\n");
    await assert.rejects(() => scrubCloneCredentials(handle, "ghs_hidden_token"), /still present in .git\/description/);
    // And a clean checkout passes the same search.
    writeFileSync(join(handle.checkoutPath, ".git", "description"), "clean\n");
    await scrubCloneCredentials(handle, "ghs_hidden_token");
  } finally {
    await handle.destroy();
  }
});

test("a remote named like a URL or a path is refused: git resolves a push target as a remote name first", () => {
  const refused = refusedKeys(
    [
      "remote.https://github.com/o/r.git.url\n/tmp/attacker.git",
      "remote./var/tmp/bare.url\n/tmp/attacker.git",
      "remote.git@github.com:o/r.url\n/tmp/attacker.git",
      "remote.origin.url\nhttps://github.com/o/r.git",
    ].join("\0") + "\0",
  );
  assert.deepEqual(refused, [
    "remote./var/tmp/bare.url",
    "remote.git@github.com:o/r.url",
    "remote.https://github.com/o/r.git.url",
  ]);
});
