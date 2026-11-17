/**
 * #220: discovery is what decides whether a verdict means anything. A Go or Python repository
 * whose checks were never found reaches `pass` having run nothing, and from the outside that
 * looks exactly like a repository whose checks all passed.
 *
 * These tests assert the *commands* discovery produces per ecosystem, that `windkeel.config.json`
 * still wins everywhere, and that `CHECK_DISCOVERY_FILES` — quoted into the evidence package as
 * `CHECK_DISCOVERY_SOURCES` when discovery finds nothing — is exactly the set of files discovery
 * actually looks at. A stale string there is a lie in an audit trail.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  CHECK_DISCOVERY_FILES,
  CHECK_DISCOVERY_SOURCES,
  loadConfig,
} from "@windkeel/verification/config.js";
import { tempDir } from "./helpers.js";

/**
 * An `ExecutionEnvironment` over a real directory that records every path it is asked about,
 * and refuses to `exec`: discovery reads the checkout, it never runs the repository's code.
 */
function recordingEnv() {
  const touched = [];
  const env = {
    async exists(path) {
      touched.push(path);
      return existsSync(path);
    },
    async readFile(path) {
      touched.push(path);
      return readFileSync(path);
    },
    async writeFile(path, data) {
      writeFileSync(path, data);
    },
    async exec() {
      throw new Error("discovery must not execute anything in the checkout");
    },
    async listFiles() {
      return [];
    },
    async mkdtemp(prefix) {
      return tempDir(prefix);
    },
  };
  return { env, touched };
}

/** A repository made only of the files handed in — no git, because discovery never shells out. */
function repoWith(files) {
  const dir = tempDir("eco");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

async function discover(files) {
  const { env, touched } = recordingEnv();
  const config = await loadConfig(env, repoWith(files));
  return { config, touched: touched.map((p) => basename(p)) };
}

const commands = (config) => config.checks.map((c) => `${c.name}: ${c.command}`);

test("a go.mod repo discovers go build, vet and test", async () => {
  const { config } = await discover({ "go.mod": "module example.com/x\n\ngo 1.22\n" });

  assert.deepEqual(commands(config), [
    "go-build: go build ./...",
    "go-vet: go vet ./...",
    "go-tests: go test ./...",
  ]);
});

test("Go check names do not collide with the npm ones in a polyglot repo", async () => {
  const { config } = await discover({
    "go.mod": "module example.com/x\n",
    "package.json": { name: "x", scripts: { test: "node --test", lint: "eslint ." } },
  });

  // Both ecosystems are the repository's own, so both are re-run; and every name is distinct,
  // which is what keeps `RepairPacket.failed_checks` and the transcript filenames unambiguous.
  assert.deepEqual(commands(config), [
    "lint: npm run --silent lint",
    "tests: npm run --silent test",
    "go-build: go build ./...",
    "go-vet: go vet ./...",
    "go-tests: go test ./...",
  ]);
  assert.equal(new Set(config.checks.map((c) => c.name)).size, config.checks.length);
});

test("Python tools are discovered from pyproject.toml sections, not from dependencies", async () => {
  const { config } = await discover({
    "pyproject.toml": [
      "[project]",
      'name = "x"',
      'dependencies = ["pytest", "ruff", "mypy"]',
      "",
      "[tool.ruff]",
      "line-length = 100",
      "",
      "[tool.ruff.lint]",
      'select = ["E"]',
      "",
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
    ].join("\n"),
  });

  // `mypy` appears only as a dependency, which says it is installed and not that it is run.
  assert.deepEqual(commands(config), ["py-lint: python -m ruff check .", "py-tests: python -m pytest"]);
});

test("a uv.lock or poetry.lock changes how the discovered Python tools are reached", async () => {
  const pyproject = "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n";

  const uv = await discover({ "pyproject.toml": pyproject, "uv.lock": "version = 1\n" });
  assert.deepEqual(commands(uv.config), ["py-tests: uv run pytest"]);

  const poetry = await discover({ "pyproject.toml": pyproject, "poetry.lock": "# lock\n" });
  assert.deepEqual(commands(poetry.config), ["py-tests: poetry run pytest"]);

  // A repo pinning with uv and carrying a stale poetry.lock means uv: the more specific runner.
  const both = await discover({
    "pyproject.toml": pyproject,
    "uv.lock": "version = 1\n",
    "poetry.lock": "# lock\n",
  });
  assert.deepEqual(commands(both.config), ["py-tests: uv run pytest"]);
});

test("Python tooling declared in the standalone config files is discovered too", async () => {
  const dotted = await discover({ ".ruff.toml": "line-length = 100\n", ".mypy.ini": "[mypy]\n" });
  assert.deepEqual(commands(dotted.config), [
    "py-lint: python -m ruff check .",
    "py-typecheck: python -m mypy .",
  ]);

  const ini = await discover({ "pytest.ini": "[pytest]\n", "setup.cfg": "[mypy]\nstrict = True\n" });
  assert.deepEqual(commands(ini.config), [
    "py-typecheck: python -m mypy .",
    "py-tests: python -m pytest",
  ]);
});

test("a requirements.txt alone declares no checks — installing is not the same as testing", async () => {
  const { config } = await discover({ "requirements.txt": "flask==3.0.0\n" });

  // Inferring `pytest` here would be a discovered check that does not exist: it fails the gate
  // and spends a repair turn on a non-problem. The repo says what it runs, or declares it.
  assert.deepEqual(config.checks, []);
});

test("a repo with nothing recognisable still discovers nothing", async () => {
  const { config } = await discover({ "README.md": "# nothing verifiable\n" });

  assert.deepEqual(config.checks, []);
  assert.equal(config.checksRequired, false);
});

test("windkeel.config.json still overrides discovery in every ecosystem", async () => {
  const declared = { checks: [{ name: "tests", command: "make check" }] };
  for (const marker of [
    { "go.mod": "module example.com/x\n" },
    { "pyproject.toml": "[tool.pytest.ini_options]\n" },
    { "package.json": { name: "x", scripts: { test: "node --test" } } },
  ]) {
    const { config } = await discover({ ...marker, "windkeel.config.json": declared });

    assert.deepEqual(commands(config), ["tests: make check"], JSON.stringify(marker));
  }
});

test("checks.required with no commands still discovers, and still overrides nothing else", async () => {
  const { config } = await discover({
    "go.mod": "module example.com/x\n",
    "windkeel.config.json": { checks: { required: true } },
  });

  assert.equal(config.checksRequired, true);
  assert.deepEqual(commands(config), [
    "go-build: go build ./...",
    "go-vet: go vet ./...",
    "go-tests: go test ./...",
  ]);
});

test("CHECK_DISCOVERY_FILES is exactly what discovery looks at", async () => {
  const { touched } = await discover({ "README.md": "# empty\n" });

  // Every declared source is genuinely consulted...
  for (const file of CHECK_DISCOVERY_FILES) {
    assert.ok(touched.includes(file), `discovery never looked at ${file}, but claims it does`);
  }
  // ...and nothing is consulted that the evidence does not name.
  for (const file of new Set(touched)) {
    assert.ok(
      CHECK_DISCOVERY_FILES.includes(file),
      `discovery reads ${file} without declaring it in CHECK_DISCOVERY_FILES`,
    );
  }
});

test("CHECK_DISCOVERY_SOURCES, the prose the evidence quotes, names every ecosystem", async () => {
  for (const file of CHECK_DISCOVERY_FILES) {
    assert.ok(CHECK_DISCOVERY_SOURCES.includes(file), `${file} is missing from the evidence prose`);
  }
});
