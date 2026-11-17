import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { HUMAN_WORKSPACE_SERVER_FILES } from "../dist/sandbox/human-workspace-server-files.js";
import { serverManifest } from "../dist/sandbox/vercel-human-workspace.js";
import { repoRoot } from "./helpers.js";

/**
 * The in-VM workspace server ships from `src/sandbox/human-workspace-server/`, embedded into the
 * build as `human-workspace-server-files.ts` (#381). These hold the two halves together: the files
 * a reviewer reads are exactly the files every bundle writes into the VM. That the deployed
 * bundles carry them is `workflow-deploy-build.test.js`'s, which builds the deployment.
 */

const serverDir = join(repoRoot, "src", "sandbox", "human-workspace-server");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function walk(dir, keep) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : walk(path, keep);
    return keep(name) ? [path] : [];
  });
}

test("every embedded server file exists in the shipped directory, and its recorded hash is that file's", () => {
  const paths = HUMAN_WORKSPACE_SERVER_FILES.map((f) => f.path);
  for (const required of ["package.json", "package-lock.json", "server/server.mjs", "server/token-gate.mjs", "server/pty-bridge.py"]) {
    assert.ok(paths.includes(required), `${required} is not embedded`);
  }
  for (const file of HUMAN_WORKSPACE_SERVER_FILES) {
    const onDisk = join(serverDir, file.path);
    assert.ok(existsSync(onDisk), `${file.path} is embedded but missing from ${relative(repoRoot, serverDir)}`);
    const bytes = readFileSync(onDisk);
    assert.equal(sha256(bytes), file.sha256, `${file.path} changed since the module was generated — run \`npm run embed:human-workspace-server\``);
    assert.equal(file.content, bytes.toString("utf8"), `${file.path}: embedded content is the file's`);
  }
  // The manifest the VM checks against, before and after `npm ci`, is built from these same hashes.
  assert.deepEqual(
    serverManifest().trim().split("\n"),
    HUMAN_WORKSPACE_SERVER_FILES.map((f) => `${f.sha256}  ${f.path}`),
  );
});

test("the committed generated module is exactly what embed.mjs renders now", async () => {
  const embed = await import("../src/sandbox/human-workspace-server/embed.mjs");
  const committed = readFileSync(join(repoRoot, "src", "sandbox", "human-workspace-server-files.ts"), "utf8");
  assert.equal(committed, embed.render(), "stale: run `npm run embed:human-workspace-server` and commit the result");
});

test("every file in the shipped directory is embedded (a new public asset cannot be left behind)", () => {
  const onDisk = walk(serverDir, () => true)
    .map((p) => relative(serverDir, p))
    .filter((p) => p !== "embed.mjs");
  assert.deepEqual(onDisk.sort(), HUMAN_WORKSPACE_SERVER_FILES.map((f) => f.path).sort());
});

test("no factory or ingress source builds a path into research/ (#381)", () => {
  const offenders = [join(repoRoot, "src"), join(repoRoot, "apps", "ingress", "api"), join(repoRoot, "apps", "ingress", "src")]
    .filter(existsSync)
    .flatMap((dir) => walk(dir, (name) => /\.(ts|tsx|mjs|js)$/.test(name)))
    .filter((path) => {
      // Comments may cite research/ as provenance; code may not reach into it.
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return /["'`]research["'`/]|research\/spikes/.test(code);
    })
    .map((path) => relative(repoRoot, path));
  assert.deepEqual(offenders, []);
});
