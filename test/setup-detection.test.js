/**
 * #387: `proposeSetup` drafts a `setup` block from a checkout's files — and only drafts it. Each
 * fixture is a real directory read through an `ExecutionEnvironment`, and nothing it proposes runs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { proposeSetup, proposesAnything } from "../dist/factory/setup-detection.js";
import { tempDir } from "./helpers.js";

function checkout(files) {
  const dir = tempDir("detect");
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const env = new LocalExecutionEnvironment();

test("a Makefile bootstrap target becomes a suggested setup command, and nothing runs it", async () => {
  const dir = checkout({ Makefile: "deps:\n\ttouch ran-deps\nbootstrap: deps\n\ttouch ran-bootstrap\nVAR := 1\n", "package-lock.json": "{}" });
  const { setup, reasons } = await proposeSetup(env, dir);
  assert.deepEqual(setup.commands.map((c) => [c.name, c.run]), [["bootstrap", "make bootstrap"], ["deps", "make deps"]]);
  assert.deepEqual(setup.cacheKeyFiles, ["Makefile"]);
  assert.ok(reasons.some((r) => /package-lock.json: the dependency install already covers it/.test(r)));
  assert.equal(existsSync(join(dir, "ran-bootstrap")), false, "a proposal never executes what it proposes");
});

test("a docker-compose postgres becomes a suggested service with a readiness check", async () => {
  const dir = checkout({
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  cache:\n    image: 'redis:7-alpine'\n  web:\n    image: node:22\n",
  });
  const { setup, reasons } = await proposeSetup(env, dir);
  assert.deepEqual(setup.services.map((s) => [s.name, s.ready]), [["postgres", "pg_isready"], ["redis", "redis-cli ping"]]);
  assert.ok(reasons.some((r) => /docker-compose.yml runs a postgres image/.test(r)));
  assert.deepEqual(setup.commands, []);
});

test("a devcontainer postCreateCommand (JSON with comments) and scripts/setup become commands", async () => {
  const dir = checkout({
    ".devcontainer/devcontainer.json": '{\n  // the image\n  "image": "mcr.microsoft.com/devcontainers/base",\n  /* after create */\n  "postCreateCommand": "npm run codegen",\n}\n',
    "scripts/setup.sh": "#!/bin/sh\necho setup\n",
    ".nvmrc": "22\n",
  });
  const { setup, reasons } = await proposeSetup(env, dir);
  assert.deepEqual(setup.commands.map((c) => [c.name, c.run]), [
    ["scripts-setup", "sh scripts/setup.sh"],
    ["devcontainer-post-create", "npm run codegen"],
  ]);
  assert.deepEqual(setup.cacheKeyFiles.sort(), [".devcontainer/devcontainer.json", "scripts/setup.sh"]);
  assert.ok(reasons.some((r) => /\.nvmrc pins a toolchain version/.test(r)));
});

test("an empty repository gets no suggestions", async () => {
  const proposal = await proposeSetup(env, checkout({ "README.md": "# nothing\n" }));
  assert.deepEqual(proposal.setup, { commands: [], services: [], secrets: [], egress: [], cacheKeyFiles: [] });
  assert.deepEqual(proposal.reasons, []);
  assert.equal(proposesAnything(proposal), false);
});
