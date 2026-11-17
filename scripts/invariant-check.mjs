#!/usr/bin/env node
// Invariant gate: ADR rules that used to live only in prose, checked deterministically.
// Each check names its ADR; it exits non-zero if any rule breaks. See docs/adr/README.md.
// Run: npm run invariant:check
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".next", ".vercel", ".workflow-data", ".well-known"]);
const rel = (p) => relative(root, p);
const read = (p) => readFileSync(join(root, p), "utf8");
const results = [];
const check = (id, name, failures) => results.push({ id, name, failures });

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// Value (non-type-only) import specifiers of a module, comments stripped.
function imports(file) {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms)) {
    if (!m[2]) out.push(m[3]);
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

// Resolve a relative specifier (".js" written for ".ts" sources) to a file on disk.
function resolveRelative(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// Transitive closure over value imports, staying inside the repository.
function closure(entries) {
  const seen = new Map(); // file -> importer chain
  const queue = entries.map((e) => [join(root, e), [e]]);
  while (queue.length) {
    const [file, chain] = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, chain);
    for (const spec of imports(file)) {
      const next = resolveRelative(file, spec);
      if (next && !seen.has(next)) queue.push([next, [...chain, rel(next)]]);
    }
  }
  return seen;
}

const KNOWLEDGE = /(^|\/)knowledge[^/]*$|(^|\/)run-knowledge|(^|\/)repo-digest/;

// ADR-0032 §1: repository knowledge shapes the maker, never the verifier.
{
  const f = [];
  // The verification package reads no knowledge at all.
  for (const p of walk(join(root, "packages/verification/src"))) {
    for (const spec of imports(p)) if (/knowledge/i.test(spec)) f.push(`${rel(p)} imports ${spec}`);
  }
  // Nothing the verification package pulls in, transitively, is a knowledge module.
  const pkgFiles = walk(join(root, "packages/verification/src")).map(rel);
  for (const [file, chain] of closure(pkgFiles)) {
    if (KNOWLEDGE.test(rel(file).replace(/\.(ts|tsx|js)$/, ""))) f.push(`verification package reaches knowledge: ${chain.join(" → ")}`);
  }
  // The verifier stage and the checker's model path reach no knowledge module, transitively.
  const entries = ["src/factory/workflow/handlers/verifying.ts", "src/factory/workflow/checker-models.ts"];
  for (const e of entries) {
    if (!existsSync(join(root, e))) { f.push(`${e} missing (update this check if it moved)`); continue; }
    const code = read(e).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (/knowledge/i.test(code)) f.push(`${e} references knowledge in code`);
  }
  for (const [file, chain] of closure(entries)) {
    if (KNOWLEDGE.test(rel(file).replace(/\.(ts|tsx|js)$/, ""))) f.push(`verifier reaches knowledge: ${chain.join(" → ")}`);
  }
  check("adr-0032-verifier-no-knowledge", "the verifier never reads repository knowledge (ADR-0032 §1)", f);
}

// ADR-0033 §3–§4: playbooks only strengthen the verifier; the verification package owns the merge.
{
  const f = [];
  const policy = "packages/verification/src/playbook-policy.ts";
  if (!existsSync(join(root, policy))) f.push(`${policy} missing`);
  else {
    if (!/export function applyPlaybookToPolicy\(/.test(read(policy))) f.push(`${policy} must export applyPlaybookToPolicy`);
    for (const spec of imports(join(root, policy))) {
      if (!spec.startsWith("./") && !spec.startsWith("node:")) f.push(`${policy} imports ${spec} (the merge depends only on the verification package)`);
    }
  }
  for (const dir of ["src", "apps", "packages"]) {
    for (const p of walk(join(root, dir))) {
      if (rel(p) === policy) continue;
      if (/function applyPlaybookToPolicy\b|applyPlaybookToPolicy\s*=\s*/.test(readFileSync(p, "utf8"))) f.push(`${rel(p)} defines its own applyPlaybookToPolicy`);
    }
  }
  check("adr-0033-merge-owned-by-verifier", "the playbook merge lives only in @windkeel/verification (ADR-0033 §4)", f);
}
{
  const f = [];
  const t = "test/playbook-policy.test.js";
  if (!existsSync(join(root, t))) f.push(`${t} missing`);
  else {
    const src = read(t);
    const required = [
      [/every base keeps every check, flow and tool/, "a test that every base check, flow and tool survives every requirement"],
      [/weakening and unknown keys are refused/, "a test that weakening requirements are refused"],
      [/cannot satisfy checks\.required/, "a test that a playbook check cannot stand in for the base's"],
    ];
    for (const [re, what] of required) if (!re.test(src)) f.push(`${t} lacks ${what}`);
    if (/\{\s*skip\s*:\s*true\s*\}|test\.skip\(/.test(src)) f.push(`${t} skips a test unconditionally`);
  }
  check("adr-0033-strengthen-only-tested", "strengthen-only is covered by tests (ADR-0033 §3)", f);
}

// ADR-0030 §2: the audit log is a hash chain, and tampering is detected — by a test that always runs.
{
  const f = [];
  const tests = readdirSync(join(root, "test")).filter((n) => n.endsWith(".test.js"));
  const blocks = [];
  for (const n of tests) {
    const src = readFileSync(join(root, "test", n), "utf8");
    if (!/from\s+["']\.\.\/dist\/factory\/audit-log\.js["']/.test(src)) continue;
    const starts = [...src.matchAll(/^[ \t]*test(?:\.(\w+))?\s*\(/gm)];
    for (const [i, start] of starts.entries()) {
      blocks.push({ modifier: start[1], chunk: src.slice(start.index, starts[i + 1]?.index) });
    }
  }
  const unconditional = blocks.filter((b) =>
    !b.modifier &&
    !/\b(?:skip|todo)\s*:|\.\s*(?:skip|todo)\s*\(/.test(b.chunk) &&
    /verify(ChainRows|AuditChain)\(/.test(b.chunk),
  );
  const detects = (reason) => unconditional.some((b) => b.chunk.includes(`"${reason}"`));
  if (!blocks.length) f.push("no test imports dist/factory/audit-log.js");
  for (const reason of ["hash_mismatch", "chain_broken", "sequence_gap"]) {
    if (!detects(reason)) f.push(`no always-run test asserts tamper reason "${reason}" via verifyChainRows/verifyAuditChain`);
  }
  check("adr-0030-audit-chain-test", "audit-chain tamper detection is tested (ADR-0030 §2)", f);
}

// ADR-0005 §3: the verification engine keeps zero runtime dependencies and depends on nothing in the repo.
{
  const f = [];
  const pkg = JSON.parse(read("packages/verification/package.json"));
  for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[k] && Object.keys(pkg[k]).length) f.push(`packages/verification/package.json has ${k}: ${Object.keys(pkg[k]).join(", ")}`);
  }
  for (const p of walk(join(root, "packages/verification/src"))) {
    for (const spec of imports(p)) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(p), spec);
        if (!target.startsWith(join(root, "packages/verification"))) f.push(`${rel(p)} imports outside its package: ${spec}`);
      } else if (!spec.startsWith("node:")) f.push(`${rel(p)} imports ${spec}`);
    }
  }
  check("adr-0005-verification-standalone", "@windkeel/verification has no runtime dependencies (ADR-0005 §3)", f);
}

// ADR-0020 §3: ingress and factory meet through data; ingress never runs a stage. Ingress may
// start a workflow (the flow module is how Vercel names it), so this is not an import closure:
// no factory export hands out a stage runner, and no ingress file imports a handler or names one.
{
  const f = [];
  const RUNNER = /\b(registerStageHandlers|buildStageDeps|create[A-Z]\w*Handlers?)\b/;
  for (const p of walk(join(root, "src/public"))) {
    const m = readFileSync(p, "utf8").match(RUNNER);
    if (m) f.push(`${rel(p)} exports ${m[1]} (a stage runner) to apps`);
  }
  for (const p of [...walk(join(root, "apps/ingress/src")), ...walk(join(root, "apps/ingress/api"))]) {
    for (const spec of imports(p)) if (/workflow\/handlers\/|stage-wiring/.test(spec)) f.push(`${rel(p)} imports ${spec}`);
    const m = readFileSync(p, "utf8").match(RUNNER);
    if (m) f.push(`${rel(p)} names ${m[1]}`);
  }
  check("adr-0020-ingress-runs-no-stage", "ingress never wires or runs a stage handler (ADR-0020 §3)", f);
}

// ADR-0030 §3: the audit log is append-only. Only audit_event_purge deletes, and only it; the
// guard trigger is never dropped; no code updates, deletes or truncates audit rows directly.
{
  const f = [];
  const IDENTIFIER = String.raw`(?:"(?:[^"]|"")*"|[a-z_][\w$]*)`;
  const TABLE = String.raw`(?:${IDENTIFIER}\s*\.\s*)?(?:"audit_event"|audit_event)(?![\w$])`;
  const TARGET = String.raw`(?:only\s+)?${TABLE}`;
  const DIRECT = new RegExp(String.raw`\b(?:update\s+${TARGET}|delete\s+from\s+${TARGET}|truncate\s+(?:table\s+)?${TARGET})`, "i");
  const DISABLE = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?${TARGET}[^;]*\bdisable\s+trigger\b`, "i");
  for (const dir of ["src", "apps", "packages"]) {
    for (const p of walk(join(root, dir))) if (DIRECT.test(readFileSync(p, "utf8"))) f.push(`${rel(p)} writes audit_event directly (use audit_event_purge)`);
  }
  let guarded = false;
  for (const name of readdirSync(join(root, "migrations")).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = read(`migrations/${name}`).replace(/--.*$/gm, "");
    if (/before\s+update\s+or\s+delete\s+on\s+audit_event/i.test(sql)) guarded = true;
    if (/drop\s+trigger[^;]*audit_event/i.test(sql) || DISABLE.test(sql)) f.push(`migrations/${name} drops or disables an audit_event trigger`);
    const outsidePurge = sql.replace(/create\s+(or\s+replace\s+)?function\s+audit_event_purge\s*\([\s\S]*?\$\$[\s\S]*?\$\$/gi, "");
    if (DIRECT.test(outsidePurge)) f.push(`migrations/${name} writes audit_event outside audit_event_purge`);
  }
  if (!guarded) f.push("no migration installs the before-update-or-delete trigger on audit_event");
  check("adr-0030-audit-append-only", "audit rows change only through audit_event_purge (ADR-0030 §3)", f);
}

// ADR-0009 / ADR-0023 §4 / ADR-0029 §5: Windkeel never merges, approves or marks ready as the App.
// A merge or mark-ready happens only in user-merge.ts, with the person's own token (user-client).
{
  const f = [];
  const MERGE_FILE = "src/factory/user-merge.ts";
  const MERGE = /pulls\/[^"'`]*\/merge\b/;
  const READY = /markPullRequestReadyForReview/;
  const APPROVE = /\/reviews\b[\s\S]{0,200}["']APPROVE["']|["']APPROVE["'][\s\S]{0,200}\/reviews\b/;
  for (const dir of ["src", "apps/ingress/src", "packages"]) {
    for (const p of walk(join(root, dir))) {
      const r = rel(p);
      const src = readFileSync(p, "utf8");
      if (MERGE.test(src) && r !== MERGE_FILE) f.push(`${r} calls the merge endpoint (only ${MERGE_FILE} may, as the person)`);
      if (READY.test(src) && r !== MERGE_FILE && r !== "src/github/user-client.ts") f.push(`${r} marks a pull request ready`);
      if (APPROVE.test(src)) f.push(`${r} submits an approving review`);
    }
  }
  if (!existsSync(join(root, MERGE_FILE))) f.push(`${MERGE_FILE} missing (update this check if it moved)`);
  else if (!imports(join(root, MERGE_FILE)).some((s) => /github\/user-client(\.js)?$/.test(s))) f.push(`${MERGE_FILE} does not use the person's client (src/github/user-client.ts)`);
  check("adr-0009-app-never-merges", "only a person's token merges or marks ready (ADR-0009, ADR-0029 §5)", f);
}

// ADR-0014: no model key enters a sandbox. Every key a harness reads is reserved (a customer
// secret can't install it into a sandbox) and can never be opted into the candidate's env.
{
  const f = [];
  const names = (file, re) => [...read(file).matchAll(re)].flatMap((m) => [...m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]));
  const keys = new Set(names("src/worker/descriptor.ts", /keyEnvVars:\s*\[([^\]]*)\]/g));
  if (!keys.size) f.push("src/worker/descriptor.ts declares no keyEnvVars (update this check if they moved)");
  const reserved = new Set(names("packages/verification/src/secret-names.ts", /RESERVED_SECRET_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/g));
  const never = new Set(names("packages/verification/src/exec/candidate-env.ts", /NEVER_PASSED[^=]*=\s*\[([\s\S]*?)\];/g));
  for (const k of keys) {
    if (!reserved.has(k)) f.push(`${k} is a model key but not in RESERVED_SECRET_KEYS`);
    if (!never.has(k)) f.push(`${k} is a model key but not in candidate-env NEVER_PASSED`);
  }
  check("adr-0014-model-keys-stay-out", "model keys are reserved and never passed to candidate code (ADR-0014)", f);
}

let failed = 0;
for (const r of results) {
  const ok = r.failures.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.id}  ${r.name}`);
  for (const x of r.failures) console.log(`        - ${x}`);
}
console.log(failed ? `\n${failed} invariant(s) broken` : `\nall ${results.length} invariants hold`);
process.exit(failed ? 1 : 0);
