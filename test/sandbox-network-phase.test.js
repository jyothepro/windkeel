import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { isGitPush, runInExecutionPhase } from "../dist/sandbox/lifecycle.js";
import { executionPhasePolicy, installPhasePolicy } from "../dist/sandbox/network-phase.js";
import { installDeclaredTools } from "../dist/sandbox/system-tools.js";
import { hostsFromSecretValues } from "../dist/factory/repository-secrets.js";
import { fixtureRepo } from "./helpers.js";

test("installPhasePolicy() includes github.com and the npm registry, not an unrelated domain", () => {
  const policy = installPhasePolicy();
  assert.equal(policy.mode, "allowlist");
  assert.ok(policy.allowedDomains.includes("github.com"));
  assert.ok(policy.allowedDomains.includes("registry.npmjs.org"));
  assert.ok(!policy.allowedDomains.includes("evil.example.com"));
});

test('executionPhasePolicy("api.openai.com") allowlist is exactly ["api.openai.com"]', () => {
  const policy = executionPhasePolicy("api.openai.com");
  assert.deepEqual(policy, { mode: "allowlist", allowedDomains: ["api.openai.com"] });
});

test("isGitPush recognizes push under argv-style and flag-prefixed spellings", () => {
  assert.equal(isGitPush("git", { args: ["push"] }), true);
  assert.equal(isGitPush("git", { args: ["-c", "foo=bar", "push"] }), true);
  assert.equal(isGitPush("git", { args: ["--namespace", "x", "push", "origin", "main"] }), true);
  assert.equal(isGitPush("git push"), true);
  assert.equal(isGitPush("git -c foo=bar push"), true);
});

test("isGitPush does not flag non-push git commands or non-git commands", () => {
  assert.equal(isGitPush("git", { args: ["status"] }), false);
  assert.equal(isGitPush("git", { args: ["log", "--oneline"] }), false);
  assert.equal(isGitPush("echo", { args: ["push"] }), false);
  assert.equal(isGitPush("npm", { args: ["run", "push"] }), false);
});

test("runInExecutionPhase calls updateNetworkPolicy (execution-phase policy) before exec appears in the call log", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: repoDir });
  try {
    const result = await runInExecutionPhase(handle, "api.openai.com", [], "git", { args: ["status"] });
    assert.equal(result.status, 0);

    const policyIndex = handle.calls.findIndex(
      (c) => c.type === "policy" && JSON.stringify(c.policy) === JSON.stringify(executionPhasePolicy("api.openai.com")),
    );
    const execIndex = handle.calls.findIndex((c) => c.type === "exec");
    assert.ok(policyIndex !== -1, "execution-phase policy update was not recorded");
    assert.ok(execIndex !== -1, "no exec call was recorded");
    assert.ok(policyIndex < execIndex, "policy update must be recorded before the first exec call");
  } finally {
    await handle.destroy();
  }
});

test("runInExecutionPhase re-applies credential broker rules alongside the phase policy", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: repoDir });
  try {
    const rules = [{ domain: "api.openai.com", header: "Authorization", secretEnvVar: "CODEX_API_KEY" }];
    await runInExecutionPhase(handle, "api.openai.com", rules, "git", { args: ["status"] });

    const brokerCall = handle.calls.find((c) => c.type === "credentialBroker");
    assert.ok(brokerCall, "credential broker rules were not re-applied");
    assert.deepEqual(brokerCall.rules, rules);
  } finally {
    await handle.destroy();
  }
});

test("a verifier-role fake handle rejects a git push exec attempt via runInExecutionPhase — no push side effect", async () => {
  const remoteDir = fixtureRepo({});
  const remoteHeadBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: remoteDir, encoding: "utf8" }).stdout.trim();

  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "verifier", repoUrl: remoteDir });
  try {
    // A local commit the push would try to land on the remote if it ever reached the fake's
    // git subprocess.
    spawnSync("git", ["commit", "--allow-empty", "-qm", "verifier: should never be pushed"], {
      cwd: handle.root,
      encoding: "utf8",
    });

    const result = await runInExecutionPhase(handle, "api.openai.com", [], "git", {
      args: ["push", "origin", "HEAD"],
    });

    assert.ok(result.error, "expected ExecResult.error to be set for a rejected verifier push");
    assert.ok(!handle.calls.some((c) => c.type === "exec" && c.command === "git" && c.options?.args?.includes("push")));

    const remoteHeadAfter = spawnSync("git", ["rev-parse", "HEAD"], { cwd: remoteDir, encoding: "utf8" }).stdout.trim();
    assert.equal(remoteHeadAfter, remoteHeadBefore, "no commit should have landed on the remote");
  } finally {
    await handle.destroy();
  }
});

test("a maker-role fake handle is unaffected by the push check — git push is not rejected at this layer", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: repoDir });
  try {
    const result = await runInExecutionPhase(handle, "api.openai.com", [], "git", {
      args: ["push", "--dry-run", "origin", "HEAD"],
    });
    // The fake has no real remote configured for push, so this may still fail at the git
    // layer — the point is only that `runInExecutionPhase` did not short-circuit it with its
    // own rejection error the way it does for a verifier.
    assert.equal(result.error, undefined);
  } finally {
    await handle.destroy();
  }
});

/**
 * #219: installing a binary needs hosts the old allowlist did not carry, and the scanners need
 * their data fetched *here* rather than at scan time. Both are install-phase only — the point of
 * fetching early is that the execution phase never has to reach any of it.
 */

test("installPhasePolicy() reaches the distro archives and the scanners' data hosts", () => {
  const domains = installPhasePolicy().allowedDomains;

  for (const host of [
    // A declared system tool is a named package from the image's own archives, whichever family
    // the image belongs to — which is detected at run time, so both are allowed here.
    "deb.debian.org",
    "cdn.amazonlinux.com",
    // The scanners' data, fetched before egress narrows.
    "semgrep.dev",
    "osv-vulnerabilities.storage.googleapis.com",
  ]) {
    assert.ok(domains.includes(host), `${host} must be reachable during the install phase`);
  }
});

test("the execution phase reaches none of them — which is why they are fetched early", () => {
  const domains = executionPhasePolicy("api.openai.com").allowedDomains;

  for (const host of [
    "deb.debian.org",
    "cdn.amazonlinux.com",
    "semgrep.dev",
    "osv-vulnerabilities.storage.googleapis.com",
    // The one a scanner would reach at scan time, and the reason the OSV database is downloaded
    // in the install phase instead.
    "api.osv.dev",
  ]) {
    assert.ok(!domains.includes(host), `${host} must not be reachable once the execution phase begins`);
  }
  assert.deepEqual(domains, ["api.openai.com"]);
});

test("a tool install followed by the phase change never re-widens egress", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "verifier", repoUrl: repoDir });
  try {
    // A declaration that is refused never execs anything; what matters is the policy timeline.
    await installDeclaredTools(handle, [], [{ value: "http://x", reason: "not a package name" }]);
    await runInExecutionPhase(handle, "api.openai.com", [], "true");

    const policies = handle.calls.filter((c) => c.type === "policy");
    assert.equal(policies.length, 1, "the only policy change in a sandbox's life is the narrowing");
    assert.deepEqual(policies[0].policy, executionPhasePolicy("api.openai.com"));
  } finally {
    await handle.destroy();
  }
});

/**
 * ADR-0014 §5 put a repository's own registry credential into the install phase's environment, which
 * turned a fixed eighteen-host allowlist from "generous" into "generous *while holding a token*".
 * The list is now derived from the repository. Two things are asserted: that it narrows, and — the
 * one that decides whether the feature works at all — that a private registry is reachable.
 */

test("a JavaScript repository's install phase does not reach Python or Go hosts", () => {
  // Without the verifier's scanners: those bring PyPI for semgrep (next test), not the repository.
  const domains = installPhasePolicy({ ecosystems: ["npm"], scanners: false }).allowedDomains;

  assert.ok(domains.includes("registry.npmjs.org"));
  // The four that the `nodejs.org` incident proved are not optional for npm.
  for (const host of [
    "nodejs.org",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ]) {
    assert.ok(domains.includes(host), `npm needs ${host}`);
  }
  for (const host of ["pypi.org", "files.pythonhosted.org", "proxy.golang.org", "sum.golang.org"]) {
    assert.ok(!domains.includes(host), `${host} is on the list for another ecosystem's benefit`);
  }
});

test("the verifier's scanners can be installed whatever the repository's ecosystem (content-machine#98)", () => {
  // semgrep through pip needs PyPI; gitleaks and osv-scanner are GitHub release assets.
  for (const ecosystems of [["npm"], ["go"], ["python"], []]) {
    const domains = installPhasePolicy({ ecosystems, systemTools: false, scanners: true }).allowedDomains;
    for (const host of ["pypi.org", "files.pythonhosted.org", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]) {
      assert.ok(domains.includes(host), `${JSON.stringify(ecosystems)}: the scanner installs need ${host}`);
    }
  }
  const without = installPhasePolicy({ ecosystems: ["go"], systemTools: false, scanners: false }).allowedDomains;
  assert.ok(!without.includes("pypi.org"), "a sandbox that installs no scanners does not get PyPI for them");
});

test("each ecosystem brings only its own hosts, and go keeps its checksum database", () => {
  const python = installPhasePolicy({ ecosystems: ["python"] }).allowedDomains;
  assert.ok(python.includes("pypi.org") && python.includes("files.pythonhosted.org"));
  assert.ok(!python.includes("registry.npmjs.org"));

  const go = installPhasePolicy({ ecosystems: ["go"] }).allowedDomains;
  assert.ok(go.includes("proxy.golang.org"));
  assert.ok(
    go.includes("sum.golang.org"),
    "without the checksum host `go` fails closed rather than trusting an unverified module",
  );
});

test("a repository declaring nothing still gets github.com, and nothing else but the opt-outs", () => {
  const domains = installPhasePolicy({
    ecosystems: [],
    systemTools: false,
    scanners: false,
  }).allowedDomains;
  /*
   * `github.com` is unconditional and the policy's doc comment says why: submodules and git-URL
   * dependencies. It is also the residual exfiltration path that this narrowing does *not* close,
   * which is recorded rather than quietly left as an implication.
   */
  assert.deepEqual(domains, ["github.com"]);
});

test("the tool and scanner hosts appear only when those installs will run", () => {
  const neither = installPhasePolicy({ systemTools: false, scanners: false }).allowedDomains;
  for (const host of ["deb.debian.org", "cdn.amazonlinux.com", "semgrep.dev"]) {
    assert.ok(!neither.includes(host), `${host} must not be open when nothing will fetch from it`);
  }

  const both = installPhasePolicy({ systemTools: true, scanners: true }).allowedDomains;
  assert.ok(both.includes("deb.debian.org"));
  assert.ok(both.includes("semgrep.dev"));
});

test("omitting the options keeps the every-ecosystem list, for a caller with no checkout yet", () => {
  /*
   * `provider.create()` applies the policy before anything has inspected the tree, so its default
   * must not be *narrower* than what the install needs — a create-time policy that guessed wrong
   * would break the install before `provisionWorkspace` got the chance to correct it.
   */
  const domains = installPhasePolicy().allowedDomains;
  for (const host of ["registry.npmjs.org", "pypi.org", "proxy.golang.org", "deb.debian.org"]) {
    assert.ok(domains.includes(host), `${host} must be in the no-information default`);
  }
});

test("a private registry named by a secret is reachable — without this, secrets do not work", () => {
  /*
   * The defect this is the regression test for: repository secrets shipped, `npm_config_registry`
   * was injected correctly, and the fetch was then refused by this allowlist. The failure presented
   * as a connection error inside a package manager, three layers from anything about egress.
   */
  const hosts = hostsFromSecretValues({
    npm_config_registry: "https://registry.internal.example/",
    NPM_TOKEN: "npm_a_bare_token_names_no_host",
  });
  assert.deepEqual(hosts, ["registry.internal.example"]);

  const domains = installPhasePolicy({ ecosystems: ["npm"], extraHosts: hosts }).allowedDomains;
  assert.ok(domains.includes("registry.internal.example"));
});

test("a URL with credentials in it contributes only its host", () => {
  assert.deepEqual(
    hostsFromSecretValues({ PIP_INDEX_URL: "https://user:pass@pypi.internal/simple" }),
    ["pypi.internal"],
  );
});

test("a secret value that is not an http URL names no host", () => {
  assert.deepEqual(
    hostsFromSecretValues({
      NPM_TOKEN: "npm_abc123",
      GOPRIVATE: "example.com/private",
      SSH_URL: "ssh://git@host/repo.git",
      FILE_URL: "file:///etc/passwd",
      EMPTYISH: "https://",
    }),
    [],
    "guessing a host from a bare value would open egress nobody asked for",
  );
});

test("the allowlist is a flat, sorted list of exact hostnames — no wildcards, no subnets", () => {
  /*
   * ADR-0014 §3 warns that subnet and domain rule composition has documented bypass sharp edges and
   * that this layer must compose only in the safe way. The narrowing changed which names are in the
   * list; it must not have changed its shape.
   */
  const domains = installPhasePolicy({
    ecosystems: ["npm", "python", "go"],
    extraHosts: ["registry.internal.example"],
  }).allowedDomains;
  assert.deepEqual(domains, [...domains].sort(), "same inputs must produce the same value");
  for (const host of domains) {
    assert.doesNotMatch(host, /[*/:]/, `${host} is not a plain hostname`);
    assert.doesNotMatch(host, /^\d+\.\d+\.\d+\.\d+/, `${host} looks like an address, not a name`);
  }
});

test("#392: the maker's browser hosts open in the install phase only when it is on; execution is unchanged", () => {
  const off = installPhasePolicy({ ecosystems: ["go"], systemTools: false, scanners: false }).allowedDomains;
  for (const host of ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"]) {
    assert.ok(!off.includes(host), `${host} must not be open without the browser`);
  }
  const on = installPhasePolicy({ ecosystems: ["go"], systemTools: false, scanners: false, makerBrowser: true }).allowedDomains;
  for (const host of ["cdn.playwright.dev", "playwright.download.prss.microsoft.com", "registry.npmjs.org", "deb.debian.org"]) {
    assert.ok(on.includes(host), `${host} is needed to install the browser`);
  }
  assert.deepEqual(executionPhasePolicy("api.openai.com"), { mode: "allowlist", allowedDomains: ["api.openai.com"] });
});
