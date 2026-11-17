import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot, runAdminCli } from "./helpers.js";

/**
 * `windkeel-admin` after ADR-0023 §10: `doctor` and `secrets keygen`, and a pointer for everything
 * that moved.
 *
 * The pointer is the part worth pinning. The person typing `windkeel-admin task create` is following
 * a runbook or their own shell history, both of which outlive a release, and "unknown command"
 * would send them looking for a typo rather than for the command that replaced it.
 */

for (const [command, replacement] of [
  ["metrics", /windkeel metrics/],
  ["reap", /windkeel reap/],
  ["task", /windkeel submit/],
  ["run", /windkeel capture/],
]) {
  test(`windkeel-admin ${command} names the command that replaced it, and needs no database`, () => {
    const result = runAdminCli([command], { env: { DATABASE_URL: "" } });
    assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, replacement);
    assert.match(result.stderr, /ADR-0023 §10/);
    assert.doesNotMatch(result.stderr, /DATABASE_URL is not set/);
  });
}

test("windkeel-admin task and run point at both halves of what they used to do", () => {
  assert.match(runAdminCli(["task"]).stderr, /windkeel show/);
  assert.match(runAdminCli(["run"]).stderr, /windkeel show/);
});

/**
 * #231: the control plane is Vercel end to end (ADR-0020), and a command surface that promises a
 * worker container describes a component that no longer exists. Cheap to reintroduce by
 * copy-paste, so the guard stays on both binaries.
 */
test("the operator-facing command surface names no worker container", () => {
  for (const file of ["src/admin-cli.ts", "packages/cli/src/cli.ts", "packages/cli/src/commands/remote.ts"]) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    assert.ok(
      !/worker container/i.test(source),
      `${file} refers to a worker container; describe the control plane instead (#231)`,
    );
  }
});
