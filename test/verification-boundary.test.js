import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

/**
 * ADR-0005 §3/§4 made mechanical. The engine's zero-runtime-dependency property is supposed
 * to hold "by construction after the split (its own manifest), instead of by vigilance in a
 * shared one" — but a manifest alone only stops the *declared* dependency, not an undeclared
 * import that happens to resolve through the root's hoisted `node_modules`. Both halves are
 * checked here so neither can regress silently.
 *
 * The split is remedial rather than preventive: the root package already declared `pg`,
 * `@vercel/sandbox`, and `@aws-sdk/client-s3` before this test existed (M1/M2 added them
 * while the repo was one package). This test is what recovers the property.
 */

const packageDir = join(repoRoot, "packages", "verification");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

/** Every module specifier in an `import`/`export ... from` position, type-only included. */
function importedSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

test("packages/verification declares zero runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  assert.deepEqual(
    manifest.dependencies ?? {},
    {},
    "packages/verification must declare no runtime dependencies (ADR-0005 §3). A moved file " +
      "that needs one is an architectural defect to report, not a dependency to hoist here.",
  );
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
});

test("nothing under packages/verification imports outward", () => {
  const offenders = [];
  for (const file of sourceFiles(join(packageDir, "src"))) {
    for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
      const relativeImport = specifier.startsWith(".");
      const nodeBuiltin = specifier.startsWith("node:");
      if (relativeImport || nodeBuiltin) continue;
      offenders.push(`${relative(repoRoot, file).split(sep).join("/")}: ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Dependency direction is one-way (ADR-0005 §3): root/apps -> packages/verification, never " +
      "the reverse, and never out to a third-party package. Offending imports:\n" +
      offenders.join("\n"),
  );
});

test("no relative import escapes the packages/verification source root", () => {
  const escapes = [];
  for (const file of sourceFiles(join(packageDir, "src"))) {
    for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const resolved = join(file, "..", specifier);
      if (!resolved.startsWith(join(packageDir, "src") + sep)) {
        escapes.push(`${relative(repoRoot, file).split(sep).join("/")}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(escapes, [], escapes.join("\n"));
});

test("the published CLI is built, and the Action runs the path it is actually built to", () => {
  /*
   * ADR-0005 §4 said the CLI stays in the root package and `npm run build` keeps producing
   * `dist/cli.js`, because the end-to-end tests and the Action's distribution expect it there —
   * "a split that breaks it is wrong by definition". That premise held while the root package
   * *was* the CLI. It stopped holding when the root became the factory: see the amendment on
   * ADR-0005, and the 264 MB install it cost.
   *
   * What §4 was protecting is the part that survives — the Action must not reference a path the
   * build does not produce. So this asserts both halves together, which the old test could not:
   * it checked the file existed and trusted `action.yml` to agree.
   */
  const built = join(repoRoot, "packages", "cli", "dist", "cli.js");
  assert.ok(statSync(built).isFile(), "npm run build must produce packages/cli/dist/cli.js");

  /*
   * Every built path named by CI or by the Action, checked against what the build produced.
   *
   * `action.yml` was updated with the split and `.github/workflows/ci.yml` was not — it ran
   * `node dist/cli.js bench`, which no longer exists, and the failure surfaced only after a full
   * CI cycle. Grepping both files here costs nothing and closes that gap.
   */
  const sources = {
    "action.yml": /(?:github\.action_path \}\}|\$GITHUB_ACTION_PATH)\/(\S+?\.js)/g,
    ".github/workflows/ci.yml": /node\s+((?:dist|packages)\/\S+?\.js)/g,
    ".github/workflows/windkeel-gate.yml": /node\s+((?:dist|packages)\/\S+?\.js)/g,
  };
  let checked = 0;
  for (const [file, pattern] of Object.entries(sources)) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    for (const [, path] of text.matchAll(pattern)) {
      assert.ok(
        statSync(join(repoRoot, path)).isFile(),
        `${file} runs ${path}, which the build does not produce`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, "at least action.yml should invoke the CLI by path");
});

/**
 * #387, ADR-0031: environment snapshots must never carry a maker's disk. Checked structurally here,
 * beside the package boundary, and behaviourally in `environment-snapshot-build.test.js` and
 * `workspace-service.test.js`.
 */
test("only the setup-sandbox build snapshots a sandbox, and it refuses a maker-role handle", () => {
  const srcDir = join(repoRoot, "src");
  const callers = sourceFiles(srcDir)
    .filter((file) => /\bhandle\.snapshot\s*\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(repoRoot, file).split(sep).join("/"));
  assert.deepEqual(callers, ["src/factory/environment-snapshots.ts"]);
  const build = readFileSync(join(srcDir, "factory", "environment-snapshots.ts"), "utf8");
  const guard = build.indexOf('if (handle.role !== "verifier")');
  assert.ok(guard > 0 && guard < build.indexOf("handle.snapshot("), "the role guard precedes the snapshot call");
  // The setup sandbox is never a workspace: nothing in the build writes a `workspace` row.
  assert.ok(!/insertWorkspace|insert into workspace/.test(build));
});

test("a restore is used only under a checkout that descends from the snapshot's commit", () => {
  const provisioning = readFileSync(join(repoRoot, "src", "factory", "workspace-service.ts"), "utf8");
  const ancestry = provisioning.indexOf('["merge-base", "--is-ancestor", restored.baseSha, "HEAD"]');
  assert.ok(ancestry > 0, "provisionWorkspace checks ancestry");
  assert.ok(ancestry < provisioning.indexOf("installInputChanges(handle, restored.baseSha"), "before anything trusts the snapshot");
});

/**
 * #388 (ADR-0032): repository knowledge shapes the maker, never the verifier. Nothing on the
 * verifier's side of the line — the engine package, the VERIFYING and REPAIRING stages, the
 * criteria gate — may import a knowledge module or read a knowledge table. Learning from the
 * verifier's findings is one-way: the learner reads `repair_attempt`, and the verifier never
 * reads what the learner wrote.
 */
test("no verifier-side module imports repository knowledge or reads its tables", () => {
  const verifierSide = [
    ...sourceFiles(join(packageDir, "src")),
    join(repoRoot, "src", "factory", "workflow", "handlers", "verifying.ts"),
    join(repoRoot, "src", "factory", "workflow", "handlers", "repairing.ts"),
    join(repoRoot, "src", "factory", "criteria-gate.ts"),
    join(repoRoot, "src", "factory", "rails-gate.ts"),
  ];
  const offenders = [];
  for (const file of verifierSide) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (/knowledge|repo-digest/.test(specifier)) offenders.push(`${relative(repoRoot, file)}: imports ${specifier}`);
    }
    if (/\b(knowledge_note|run_knowledge|repository_digest|knowledge_lesson_tombstone)\b/.test(source)) {
      offenders.push(`${relative(repoRoot, file)}: names a knowledge table`);
    }
  }
  assert.deepEqual(offenders, [], "knowledge must never reach the verifier (ADR-0032, ADR-0004)");
});

test("the knowledge modules import nothing from the verifier's stages", () => {
  const modules = ["knowledge.ts", "knowledge-select.ts", "knowledge-render.ts", "knowledge-risk.ts", "knowledge-learn.ts", "knowledge-review.ts", "repo-digest.ts"].map(
    (name) => join(repoRoot, "src", "factory", name),
  );
  modules.push(join(repoRoot, "src", "factory", "workflow", "knowledge-flow.ts"));
  for (const file of modules) {
    for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
      // Types and the exec interface only: the repair packet's shape, and how a command is run.
      if (specifier.startsWith("@windkeel/verification/")) {
        assert.match(specifier, /^@windkeel\/verification\/(engine\/repair|exec\/environment)\.js$/, `${file} imports ${specifier}`);
      }
      assert.doesNotMatch(specifier, /handlers\/(verifying|repairing)/, `${file} imports ${specifier}`);
    }
  }
});
