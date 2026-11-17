import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

/**
 * What `windkeel` loads before it knows which command it was given.
 *
 * `windkeel verify` is the local PR gate: it runs on a contributor's laptop and in CI, against
 * a checkout, with no server and no credentials. It used to load `pg`, `@vercel/sandbox` and the
 * `workflow` runtime anyway — 31 MB of driver for a command that opens no socket — because
 * `cli.ts` imported `capture.ts` and `task.ts` at module scope for two help strings.
 *
 * A comment asking the next person not to re-add that import is worth nothing. This walks the
 * static graph and fails with the chain.
 */

/** Packages that mean a network, a database, or a cloud SDK. None may load before dispatch. */
const DRIVERS = ["pg", "@vercel/sandbox", "workflow", "workflow/api", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"];

const IMPORT = /^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm;

/** Static imports only. `await import()` is exactly the escape hatch that makes this pass. */
function staticGraph(entry) {
  const parents = new Map([[resolve(entry), null]]);
  const drivers = [];
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = match[1];
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        const resolved = resolve(dirname(file), spec);
        if (!parents.has(resolved)) {
          parents.set(resolved, file);
          queue.push(resolved);
        }
        continue;
      }
      if (DRIVERS.includes(spec)) drivers.push({ spec, file });
    }
  }
  return { parents, drivers };
}

function chainTo(parents, file) {
  const chain = [];
  for (let cur = file; cur; cur = parents.get(cur)) chain.push(relative(repoRoot, cur));
  return chain.reverse().join("\n    → ");
}

test("no database, sandbox or workflow driver loads before the CLI knows its command", () => {
  const entry = resolve(repoRoot, "packages/cli/dist/cli.js");
  assert.ok(existsSync(entry), "run npm run build first");

  const { parents, drivers } = staticGraph(entry);
  if (drivers.length > 0) {
    const detail = drivers
      .map(({ spec, file }) => `${spec} is loaded via:\n    ${chainTo(parents, file)}`)
      .join("\n\n");
    assert.fail(
      `windkeel loads ${drivers.length} driver(s) at startup. Move the command behind ` +
        `await import(), and keep any string the usage block needs in a leaf module:\n\n${detail}`,
    );
  }
});

test("the operator commands reach no driver: they are HTTP clients now (ADR-0023 §10)", () => {
  const { parents, drivers } = staticGraph(resolve(repoRoot, "packages/cli/dist/commands/operator.js"));
  assert.deepEqual(
    drivers.map((d) => d.spec),
    [],
    `metrics, reap and capture pull a driver:\n${drivers.map((d) => chainTo(parents, d.file)).join("\n")}`,
  );
});

test("the API client and the MCP server depend on nothing but the platform", () => {
  // These are what a person installs to talk to a deployment, and what an agent runs as an MCP
  // server. A driver here would be 31 MB to make an HTTP request.
  for (const entry of ["packages/cli/dist/client/api.js", "packages/cli/dist/mcp/server.js", "packages/cli/dist/mcp/tools.js"]) {
    const { parents, drivers } = staticGraph(resolve(repoRoot, entry));
    assert.deepEqual(
      drivers.map((d) => d.spec),
      [],
      `${entry} pulls a driver:\n${drivers.map((d) => chainTo(parents, d.file)).join("\n")}`,
    );
  }
});

test("the startup graph stays small enough to read", () => {
  const { parents } = staticGraph(resolve(repoRoot, "packages/cli/dist/cli.js"));
  // Not a performance budget — a tripwire. It was 31 files when three drivers were loading; if
  // this climbs back toward that, something eager has been added and is worth looking at.
  assert.ok(
    parents.size <= 20,
    `${parents.size} modules load before dispatch; it was 13 when this was written`,
  );
});

/**
 * The manifest, not the imports.
 *
 * Everything above walks the *import graph*, which decides what loads at startup. This checks the
 * *declaration*, which decides what npm downloads — and they are independent. `await import()`
 * makes a driver load lazily and does nothing at all to the install: the CLI loaded three drivers
 * lazily for a day and `npm i -g windkeel` still fetched 264 MB of them.
 *
 * ADR-0005 §4 held for two months after it stopped being true because nothing checked it. This is
 * the check. ADR-0008 §2 already names Cloudflare R2 as a future client, so the next SDK is not
 * hypothetical.
 */
test("the published CLI declares no driver, transitively", () => {
  const manifest = (dir) => JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));

  const cli = manifest("packages/cli");
  assert.equal(cli.name, "windkeel", "the published package is the one users type");
  assert.ok(cli.bin?.windkeel, "and it owns the binary");
  assert.ok(cli.bin?.windkeel, "and keeps the old name working");

  // Walk the workspace dependency closure. A workspace dep resolves to a sibling directory; a
  // registry dep is a leaf we can only judge by name.
  const WORKSPACE = { "@windkeel/verification": "packages/verification", windkeel: "packages/cli" };
  const seen = new Set();
  const declared = [];
  const queue = [["packages/cli", cli]];

  while (queue.length > 0) {
    const [dir, pkg] = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (WORKSPACE[name]) queue.push([WORKSPACE[name], manifest(WORKSPACE[name])]);
      else declared.push(`${name} (declared by ${pkg.name})`);
    }
  }

  assert.deepEqual(
    declared,
    [],
    "the published CLI's dependency closure must be workspace packages only — a registry " +
      "dependency here is downloaded by everyone running `windkeel verify` in CI:\n  " +
      declared.join("\n  "),
  );
});

test("the factory keeps the drivers, and is never published", () => {
  const factory = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(factory.private, true, "the factory declares every driver; publishing it is the bug");
  assert.notEqual(factory.name, "windkeel", "two packages cannot share the name users install");
  // Sanity: this is genuinely where the weight lives, so the split is doing something.
  for (const driver of ["pg", "@vercel/sandbox", "workflow"]) {
    assert.ok(factory.dependencies[driver], `${driver} should be declared by the factory`);
  }
});
