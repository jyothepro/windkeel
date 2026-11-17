import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectRepositoryContext,
  renderRepositoryContext,
} from "../packages/verification/dist/stages/repo-context.js";
import { LocalExecutionEnvironment } from "../packages/verification/dist/exec/local.js";
import { fixtureRepo } from "./helpers.js";

/**
 * #241: the reviewer is given the repository, not only the diff.
 *
 * Run `f28748b2` rejected a correct change four times because every finding reduced to "the diff
 * gives no evidence that…". Three specific questions were asked and none could be answered from a
 * diff: does this path exist, what surrounds this hunk, and what does the build actually do.
 *
 * Those three are the cases below, phrased as the reviewer would meet them.
 */

const SCRIPTS = { test: "node -e \"console.log('ok')\"" };

/** A repo with a second commit touching one file, plus a file the diff never mentions. */
function repoWithChange() {
  const repo = fixtureRepo(SCRIPTS);
  mkdirSync(join(repo, "src", "queue"), { recursive: true });
  writeFileSync(join(repo, "src", "queue", "slots.test.ts"), "// a test file\n");
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }, null, 2));
  writeFileSync(join(repo, "README.md"), "# Title\n\n## Development\n\nrun the tests.\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "seed"], { cwd: repo });
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  writeFileSync(
    join(repo, "README.md"),
    "# Title\n\n## Development\n\nrun the tests.\n\nrun one: `node --test dist/queue/slots.test.js`\n",
  );
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "docs: one test file"], { cwd: repo });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  return { repo, base, head };
}

const gather = async () => {
  const { repo, base, head } = repoWithChange();
  const context = await collectRepositoryContext(new LocalExecutionEnvironment(), repo, base, head);
  return { context, rendered: renderRepositoryContext(context) };
};

test("'does this path exist' is answerable — the file listing is included", async () => {
  const { rendered } = await gather();
  // The exact question run f28748b2's F1 could not answer, about a file the diff never names.
  assert.match(rendered, /src\/queue\/slots\.test\.ts/);
});

test("'what surrounds this hunk' is answerable — changed files arrive whole", async () => {
  const { context, rendered } = await gather();
  const readme = context.files.find((f) => f.path === "README.md");
  assert.ok(readme, "README.md is in the context; it is what the diff touched");
  // The heading is four lines above the change, so a diff's context window can miss it.
  assert.match(readme.text, /^## Development$/m);
  assert.match(rendered, /Full current text of README\.md/);
});

test("'what does the build do' is answerable — manifests are included unasked", async () => {
  const { context } = await gather();
  const tsconfig = context.files.find((f) => f.path === "tsconfig.json");
  assert.ok(tsconfig, "tsconfig.json is included though the diff does not touch it");
  assert.match(tsconfig.text, /src\/\*\*\/\*\.ts/);
});

/**
 * The failure mode this fix could introduce: a fact sheet that quietly stops short would put the
 * reviewer back where it started — reasoning about an absence it cannot recognise as one.
 */
test("truncation is announced, so absence never reads as proof of absence", () => {
  const rendered = renderRepositoryContext({
    tree: "a.ts",
    treeTruncated: true,
    files: [{ path: "big.ts", text: "x", truncated: true }],
    unreadable: ["secret.ts"],
  });
  assert.match(rendered, /listing truncated/);
  assert.match(rendered, /big\.ts truncated/);
  assert.match(rendered, /Absence here means they were not gathered, NOT that they do not exist/);
});

test("a repository it cannot read yields empty context rather than throwing", async () => {
  const context = await collectRepositoryContext(
    new LocalExecutionEnvironment(),
    "/nonexistent-repo-path-for-windkeel-test",
    "aaaa",
    "bbbb",
  );
  // A reviewer with less context is worse than one with more; a verification that died because
  // `git ls-files` did is worse than both.
  assert.equal(context.tree, "");
  assert.deepEqual(context.files, []);
});
