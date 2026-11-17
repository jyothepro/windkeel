import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { buildMakerPrompt } from "../dist/factory/workflow/handlers/implementing.js";
import {
  MAKER_BROWSER_PLAYWRIGHT_VERSION,
  excludeMakerBrowserOutput,
  installMakerBrowser,
} from "../dist/sandbox/maker-browser/install.js";
import { WINDKEEL_BROWSE_SHA256, WINDKEEL_BROWSE_SOURCE } from "../dist/sandbox/maker-browser/windkeel-browse-source.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { insertEngineeringRun, insertEngineeringTask, listWorkspaces } from "../dist/factory/repositories.js";
import { provisionWorkspace } from "../dist/factory/workspace-service.js";
import { browserSkip } from "./console-browser.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL, FIXTURE_REPOSITORY_ID } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The maker's browser (#392): the `windkeel-browse` helper, its install, and the prompt that tells the
 * maker about it. The helper is exercised as the agent would run it — a subprocess — and the install
 * against a recording stand-in for a sandbox, because the real one downloads Chromium.
 */

const HELPER = join(repoRoot, "src", "sandbox", "maker-browser", "windkeel-browse.mjs");
const browse = (args, out) =>
  spawnSync(process.execPath, [HELPER, ...args], { encoding: "utf8", env: { ...process.env, WINDKEEL_BROWSER_OUT: out }, timeout: 120_000 });

test("windkeel-browse refuses anything that is not a local http page, before starting a browser", () => {
  for (const url of [
    "https://example.com/",
    "http://example.com/",
    "file:///etc/passwd",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost.evil.example/",
    "http://user:pass@localhost:3000/",
    "https://localhost:3000/",
    "javascript:alert(1)",
    "not a url",
  ]) {
    const out = tempDir("browse-refused");
    const result = browse(["screenshot", url], out);
    assert.equal(result.status, 2, `${url} → exit ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /url_not_local/);
    assert.deepEqual(readdirSync(out), [], "nothing written");
  }
});

test("windkeel-browse answers a malformed command with its usage", () => {
  const result = browse(["fly"], tempDir("browse-usage"));
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage: windkeel-browse screenshot/);
});

test("windkeel-browse screenshots a local page: a PNG, an index entry, and the console errors in its output", async (t) => {
  const reason = await browserSkip();
  if (reason) return t.skip(reason);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Fixture home</title><h1>hi</h1><script>console.error("kaboom from the page")</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const out = tempDir("browse-shot");
    const result = await new Promise((resolve) => {
      // Async, not spawnSync: the page is served by this same process.
      const child = spawn(process.execPath, [HELPER, "screenshot", `http://127.0.0.1:${server.address().port}/`, "--name", "home"], {
        env: { ...process.env, WINDKEEL_BROWSER_OUT: out },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /screenshot: .*001-home\.png/);
    assert.match(result.stdout, /title: Fixture home/);
    assert.match(result.stdout, /kaboom from the page/);
    assert.match(result.stdout, /not verification evidence/);
    const bytes = readFileSync(join(out, "001-home.png"));
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const entry = JSON.parse(readFileSync(join(out, "index.jsonl"), "utf8").trim());
    assert.equal(entry.file, "001-home.png");
    assert.equal(entry.status, 200);
    assert.equal(entry.title, "Fixture home");
    assert.ok(entry.consoleErrors.some((e) => e.includes("kaboom from the page")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("the embedded helper is exactly what embed.mjs renders now", async () => {
  const embed = await import("../src/sandbox/maker-browser/embed.mjs");
  const committed = readFileSync(join(repoRoot, "src", "sandbox", "maker-browser", "windkeel-browse-source.ts"), "utf8");
  assert.equal(committed, embed.render(), "stale: run `npm run embed:maker-browser` and commit the result");
  assert.equal(WINDKEEL_BROWSE_SOURCE, readFileSync(HELPER, "utf8"));
  assert.match(WINDKEEL_BROWSE_SHA256, /^[0-9a-f]{64}$/);
});

const TASK = { title: "Add a cart page", description: "A cart.", acceptanceCriteria: [{ id: "AC1", text: "the cart shows items" }] };

test("the maker prompt has a Browser section only when the maker has a browser", () => {
  const without = buildMakerPrompt(TASK);
  assert.doesNotMatch(without, /## Browser/);
  assert.doesNotMatch(without, /windkeel-browse/);

  const withIt = buildMakerPrompt(TASK, undefined, { helper: "/tmp/b/bin/windkeel-browse", startCommand: "npm run dev", port: 5173 });
  assert.match(withIt, /## Browser/);
  assert.match(withIt, /\/tmp\/b\/bin\/windkeel-browse serve --port 5173 -- npm run dev/);
  assert.match(withIt, /screenshot http:\/\/localhost:5173\//);
  assert.match(withIt, /not verification evidence/);
  assert.match(withIt, /Never commit `\.windkeel\/browser\/`/);
  assert.ok(withIt.startsWith(without), "the task itself is unchanged");
});

/** A sandbox stand-in that records every command and answers each from `answer`. */
function recordingSandbox({ role = "maker", answer = () => ({ status: 0, stdout: "", stderr: "" }) } = {}) {
  const calls = [];
  const files = new Map();
  return {
    calls,
    files,
    handle: {
      id: "recording",
      role,
      checkoutPath: "/work/repo",
      async exec(command, options = {}) {
        calls.push({ command, args: options.args ?? [], env: options.env ?? {} });
        return { signal: null, ...answer(command, options.args ?? []) };
      },
      async writeFile(path, data) {
        files.set(path, String(data));
      },
      async mkdtemp(prefix) {
        return `/scratch/${prefix}x`;
      },
    },
  };
}

test("the install refuses a sandbox that is not one, and a verifier, without running anything", async () => {
  const fake = recordingSandbox();
  const notIsolated = await installMakerBrowser(fake.handle, { isolated: false });
  assert.equal(notIsolated.status, "unavailable");
  assert.match(notIsolated.reason, /isolatedFilesystem is false/);
  assert.equal(fake.calls.length, 0);

  const verifier = recordingSandbox({ role: "verifier" });
  const refused = await installMakerBrowser(verifier.handle, { isolated: true });
  assert.equal(refused.status, "unavailable");
  assert.equal(verifier.calls.length, 0);
});

test("the install pins playwright-core, downloads the headless shell into its own dir, and proves it starts", async () => {
  const box = recordingSandbox({ answer: (command, args) => (command === "sh" && args[1] === "command -v node" ? { status: 0, stdout: "/usr/bin/node\n", stderr: "" } : { status: 0, stdout: "", stderr: "" }) });
  const state = await installMakerBrowser(box.handle, { isolated: true, startCommand: "npm run dev", port: 3000 });
  assert.equal(state.status, "installed");
  assert.equal(state.helper, "/scratch/windkeel-maker-browser-x/bin/windkeel-browse");
  assert.equal(state.startCommand, "npm run dev");
  assert.equal(state.port, 3000);

  const npm = box.calls.find((c) => c.command === "npm");
  assert.ok(npm.args.includes(`playwright-core@${MAKER_BROWSER_PLAYWRIGHT_VERSION}`));
  assert.ok(npm.args.includes("--ignore-scripts"));
  const download = box.calls.find((c) => c.args.includes("install") && c.args.includes("chromium-headless-shell"));
  assert.equal(download.env.PLAYWRIGHT_BROWSERS_PATH, "/scratch/windkeel-maker-browser-x/browsers");
  assert.ok(box.calls.some((c) => c.command === state.helper && c.args[0] === "check"), "the browser is launched once");

  const shim = box.files.get(state.helper);
  assert.match(shim, /WINDKEEL_BROWSER_OUT='\/work\/repo\/\.windkeel\/browser'/);
  assert.match(shim, /PLAYWRIGHT_BROWSERS_PATH=/);
  assert.doesNotMatch(shim, /KEY|TOKEN|SECRET/i, "no credential in the browser's environment");
  assert.equal(box.files.get("/scratch/windkeel-maker-browser-x/windkeel-browse.mjs"), WINDKEEL_BROWSE_SOURCE);
});

test("a failed download, a browser that will not start, or a throw is `unavailable` with the reason — never a throw", async () => {
  const download = recordingSandbox({
    answer: (command, args) => (args.includes("chromium-headless-shell") && args.includes("install") ? { status: 1, stdout: "", stderr: "Download failure, code=1" } : { status: 0, stdout: "", stderr: "" }),
  });
  const failed = await installMakerBrowser(download.handle, { isolated: true });
  assert.equal(failed.status, "unavailable");
  assert.match(failed.reason, /Download failure/);

  const noStart = recordingSandbox({ answer: (_c, args) => (args[0] === "check" ? { status: 3, stdout: "", stderr: "browser_unavailable: libnss3.so missing" } : { status: 0, stdout: "", stderr: "" }) });
  const dead = await installMakerBrowser(noStart.handle, { isolated: true });
  assert.equal(dead.status, "unavailable");
  assert.match(dead.reason, /libnss3/);

  const throwing = recordingSandbox();
  throwing.handle.mkdtemp = async () => {
    throw new Error("disk full");
  };
  const thrown = await installMakerBrowser(throwing.handle, { isolated: true });
  assert.equal(thrown.status, "unavailable");
  assert.match(thrown.reason, /disk full/);
});

test(".windkeel/browser/ is excluded in the maker's checkout, once", async () => {
  const remote = bareFixtureRepo({ test: "node --test" });
  const handle = await new FakeSandboxProvider().create({ role: "maker", repoUrl: remote.bare });
  try {
    await excludeMakerBrowserOutput(handle);
    await excludeMakerBrowserOutput(handle);
    const exclude = readFileSync(join(handle.checkoutPath, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((l) => l === "/.windkeel/browser/").length, 1);
    await handle.exec("mkdir", { args: ["-p", ".windkeel/browser"] });
    await handle.writeFile(".windkeel/browser/001-x.png", "png");
    const status = await handle.exec("git", { args: ["status", "--porcelain", "--untracked-files=all"] });
    assert.equal(status.stdout.trim(), "", "a screenshot is not even untracked");
  } finally {
    await handle.destroy();
  }
});

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

test("provisioning a maker for a repo with flows widens the install phase for the browser and records why it has none", { skip }, async () => {
  const schema = `windkeel_mbrowser_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const handles = [];
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "local",
      sourceReference: "392",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const remote = bareFixtureRepo(
      { test: "node --test" },
      { "windkeel.config.json": JSON.stringify({ flows: [{ name: "home", command: "npx playwright test" }] }) },
    );
    const provision = (input) =>
      provisionWorkspace(pool, new FakeSandboxProvider(), {
        engineeringRunId: run.id,
        repository: remote.bare,
        baseSha: "HEAD",
        installDependencies: false,
        installDeclaredTools: false,
        ...input,
      });

    const maker = await provision({ role: "maker", makerBrowser: true });
    handles.push(maker.handle);
    assert.equal(maker.makerBrowser.status, "unavailable", "the fake provider is the host, so no Chromium is installed");
    assert.match(maker.makerBrowser.reason, /isolatedFilesystem is false/);
    const policy = maker.handle.calls.filter((c) => c.type === "policy").at(-1).policy;
    assert.ok(policy.allowedDomains.includes("cdn.playwright.dev"));
    const row = (await listWorkspaces(pool, run.id)).find((w) => w.id === maker.workspace.id);
    assert.equal(row.makerBrowser.status, "unavailable", "recorded on the workspace row for IMPLEMENTING");

    // The kill switch, and the verifier: neither gets the hosts nor a browser state.
    const off = await provision({ role: "maker", makerBrowser: false });
    handles.push(off.handle);
    assert.equal(off.makerBrowser, undefined);
    assert.ok(!off.handle.calls.filter((c) => c.type === "policy").at(-1).policy.allowedDomains.includes("cdn.playwright.dev"));
    const verifier = await provision({ role: "verifier", makerBrowser: true });
    handles.push(verifier.handle);
    assert.equal(verifier.makerBrowser, undefined);
    assert.ok(!verifier.handle.calls.filter((c) => c.type === "policy").at(-1).policy.allowedDomains.includes("cdn.playwright.dev"));
    assert.equal(existsSync(join(verifier.handle.checkoutPath, ".git", "info", "exclude")) && readFileSync(join(verifier.handle.checkoutPath, ".git", "info", "exclude"), "utf8").includes("/.windkeel/browser/"), false);
  } finally {
    for (const h of handles) await h.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
