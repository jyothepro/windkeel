#!/usr/bin/env node
// Architecture gate. Each check is a boundary rule; it exits non-zero if any rule breaks.
// Run: node scripts/arch-check.mjs
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".next", ".vercel", ".workflow-data", ".well-known"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const read = (p) => readFileSync(join(root, p), "utf8");
const lines = (p) => read(p).split("\n").length;
const rel = (p) => relative(root, p);
const results = [];
const check = (id, name, failures) => results.push({ id, name, failures });

// 1. One API contract, shared by server, console and CLI.
{
  const f = [];
  const pkg = "packages/api-contract/package.json";
  if (!existsSync(join(root, pkg))) f.push(`${pkg} missing`);
  else if (JSON.parse(read(pkg)).name !== "@windkeel/api-contract") f.push(`${pkg} must be named @windkeel/api-contract`);
  const uses = (dir) => walk(join(root, dir)).some((p) => readFileSync(p, "utf8").includes("@windkeel/api-contract"));
  for (const d of ["apps/console/lib", "packages/cli/src", "apps/ingress/src"]) if (!uses(d)) f.push(`${d} does not import @windkeel/api-contract`);
  const types = "apps/console/lib/types.ts";
  if (existsSync(join(root, types))) {
    const local = (read(types).match(/^export (interface|type) /gm) ?? []).length;
    if (local > 10) f.push(`${types} still declares ${local} local API types (max 10; re-export from the contract)`);
  }
  check(1, "single API contract", f);
}

// 2. Apps use the factory's public exports, never dist internals.
{
  const f = [];
  const exp = JSON.parse(read("package.json")).exports;
  if (!exp) f.push(`root package.json has no "exports" map`);
  for (const p of walk(join(root, "apps"))) {
    const n = (readFileSync(p, "utf8").match(/@windkeel\/factory\/dist\//g) ?? []).length;
    if (n) f.push(`${rel(p)}: ${n} deep import(s) of @windkeel/factory/dist/`);
  }
  check(2, "factory public surface", f);
}

// 3. No god files.
{
  const f = [];
  const MAX_CORE = 600; // the split folders
  const MAX_ANY = 700; // every source file
  for (const d of ["apps/ingress/src/api", "src/factory/tenancy", "src/factory/workflow"]) {
    for (const p of walk(join(root, d))) {
      const n = readFileSync(p, "utf8").split("\n").length;
      if (n > MAX_CORE) f.push(`${rel(p)}: ${n} lines (max ${MAX_CORE} here)`);
    }
  }
  for (const p of ["src/factory/tenancy.ts", "src/factory/workflow/vercel.ts", "apps/ingress/src/api/handlers.ts"]) {
    if (existsSync(join(root, p)) && lines(p) > MAX_CORE) f.push(`${p}: ${lines(p)} lines (max ${MAX_CORE})`);
  }
  const roots = ["src", "packages/cli/src", "packages/verification/src", "packages/api-contract/src", "apps/ingress/src", "apps/ingress/api", "apps/console/lib", "apps/console/app", "apps/console/components"];
  const DATA = new Set(["apps/console/lib/fixtures.ts"]); // static fixture data, not logic
  for (const d of roots) {
    if (!existsSync(join(root, d))) continue;
    for (const p of walk(join(root, d))) {
      if (DATA.has(rel(p))) continue;
      const n = readFileSync(p, "utf8").split("\n").length;
      if (n > MAX_ANY) f.push(`${rel(p)}: ${n} lines (max ${MAX_ANY})`);
    }
  }
  check(3, "module size", [...new Set(f)]);
}

// 4. Raw SQL lives in store modules, everywhere; transactions open in one place.
{
  const f = [];
  const isStore = (p) => /(^|\/)(stores?\/[^/]+|[\w-]*store)\.(ts|mjs)$/.test(rel(p));
  const SQL_ALLOWED = new Set(["src/factory/db/transaction.ts", "src/factory/migrate.ts"]); // the tx helper; the migration runner executes .sql files
  const TX_HOME = "src/factory/db/transaction.ts";
  const roots = ["src", "apps/ingress/src", "apps/ingress/api", "apps/console", "packages/cli/src"];
  for (const d of roots) {
    if (!existsSync(join(root, d))) continue;
    for (const p of walk(join(root, d))) {
      const r = rel(p);
      const text = readFileSync(p, "utf8");
      if (!isStore(p) && !SQL_ALLOWED.has(r) && /\.query\s*[<(]/.test(text)) f.push(`${r}: raw SQL outside a store module`);
      if (r !== TX_HOME && /\.query\s*\(\s*["'`]\s*(begin|commit|rollback)\b/i.test(text)) f.push(`${r}: opens/ends a transaction by hand (use withTransaction from ${TX_HOME})`);
    }
  }
  check(4, "SQL behind stores", f);
}

// 5. Migrations: numbered, unique, and never schema-qualified (shared database, `orqon` schema
//    via search_path — ADR-0024 §11). migrations/supabase/ is applied by hand and exempt.
{
  const f = [];
  const seen = new Map();
  for (const name of readdirSync(join(root, "migrations"))) {
    const p = join(root, "migrations", name);
    if (statSync(p).isDirectory() || name === "AGENTS.md") continue;
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) { f.push(`migrations/${name}: name must be NNNN_snake_case.sql`); continue; }
    const n = name.slice(0, 4);
    if (seen.has(n)) f.push(`migrations/${name}: number ${n} also used by ${seen.get(n)}`);
    seen.set(n, name);
    // Ignore comments and string literals: `set_config('orqon.x', …)` is a setting, not a schema.
    const code = readFileSync(p, "utf8").replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
    const m = code.match(/\b(public|windkeel)\.[a-z_]\w*/gi);
    if (m) f.push(`migrations/${name}: schema-qualified name(s) ${[...new Set(m)].join(", ")} — use unqualified names`);
  }
  check(5, "migration naming", f);
}

// 6. ADRs: numbered, unique, with a Status line, and listed in docs/adr/README.md with that status.
{
  const f = [];
  const dir = "docs/adr";
  const index = existsSync(join(root, dir, "README.md")) ? read(`${dir}/README.md`) : "";
  if (!index) f.push(`${dir}/README.md missing`);
  const seen = new Map();
  const tableRows = index.split("\n").filter((line) => line.trim().startsWith("|"));
  const statusColumn = tableRows[0]?.split("|").findIndex((cell) => cell.trim().toLowerCase() === "status") ?? -1;
  if (statusColumn < 0) f.push(`${dir}/README.md: no Status column`);
  const files = readdirSync(join(root, dir)).filter((name) => statSync(join(root, dir, name)).isFile());
  if (existsSync(join(root, dir, "archive"))) {
    files.push(...readdirSync(join(root, dir, "archive")).filter((name) => statSync(join(root, dir, "archive", name)).isFile()).map((name) => `archive/${name}`));
  }
  for (const path of files) {
    const name = path.split("/").at(-1);
    if (name === "README.md") continue;
    if (!/^\d{4}-[a-z0-9-]+\.md$/.test(name)) { f.push(`${dir}/${name}: name must be NNNN-kebab-title.md`); continue; }
    const n = name.slice(0, 4);
    if (seen.has(n)) f.push(`${dir}/${name}: number ${n} also used by ${seen.get(n)}`);
    seen.set(n, name);
    const status = read(`${dir}/${path}`).match(/^- Status: (.+)$/m)?.[1].trim();
    if (!status) { f.push(`${dir}/${name}: no "- Status: …" line`); continue; }
    const row = index.split("\n").find((l) => l.includes(`](${path})`));
    if (!row) f.push(`${dir}/README.md: no row for ${name}`);
    else if (row.split("|")[statusColumn]?.trim() !== status) f.push(`${dir}/README.md: ${n} status should be "${status}"`);
  }
  check(6, "ADR index", f);
}

// 7. Agent-facing docs link only to files that exist, so the prose can't silently rot.
{
  const f = [];
  const PLACEHOLDER = /NNNN|XXXX/; // templates in skills
  const docs = ["AGENTS.md", "CONTEXT.md", "docs/README.md", "docs/agents/domain.md", "docs/adr/README.md"];
  for (const d of ["src/factory", "src/sandbox", "packages", "packages/verification", "apps/ingress", "migrations", "test"]) docs.push(`${d}/AGENTS.md`);
  for (const d of readdirSync(join(root, ".claude/skills"))) docs.push(`.claude/skills/${d}/SKILL.md`);
  for (const doc of docs) {
    if (!existsSync(join(root, doc))) { f.push(`${doc} missing`); continue; }
    const base = join(root, doc, "..");
    for (const [, target] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target) || PLACEHOLDER.test(target)) continue;
      const path = target.split("#")[0];
      if (path && !existsSync(join(base, path))) f.push(`${doc}: broken link ${target}`);
    }
    // Paths in backticks that look like repo files, from the repo root or the doc's own folder.
    for (const [, path] of read(doc).matchAll(/`((?:src|docs|test|scripts|packages|apps|migrations)\/[\w./-]+\.\w+)`/g)) {
      if (!PLACEHOLDER.test(path) && !existsSync(join(root, path)) && !existsSync(join(base, path))) f.push(`${doc}: names missing file ${path}`);
    }
  }
  check(7, "agent docs resolve", f);
}

// 8. API responses match the contract at runtime, not only in types. Every route the ingress table
// declares has a response schema in the contract, and the router validates responses against it
// when WINDKEEL_VALIDATE_RESPONSES=1 (the test suite runs with it on).
{
  const f = [];
  const routeFile = "apps/ingress/src/api/route.ts";
  const names = [...read(routeFile).matchAll(/name:\s*"([\w.-]+)"/g)].map((m) => m[1]);
  const table = "packages/api-contract/src/routes.ts";
  if (!existsSync(join(root, table))) f.push(`${table} missing (export routeResponses: one schema per RouteName)`);
  else {
    const src = read(table);
    if (!/export const routeResponses\b/.test(src)) f.push(`${table} must export routeResponses`);
    for (const n of new Set(names)) {
      if (!new RegExp(`(^|[\\s{,])["']?${n.replace(/[.-]/g, "\\$&")}["']?\\s*:`, "m").test(src)) f.push(`route "${n}" has no response schema in ${table}`);
    }
    if (/z\.(any|unknown)\(\)/.test(src)) f.push(`${table} uses z.any()/z.unknown(); describe the response`);
  }
  const ingress = walk(join(root, "apps/ingress/src")).map((p) => readFileSync(p, "utf8")).join("\n");
  if (!/WINDKEEL_VALIDATE_RESPONSES/.test(ingress) || !/routeResponses/.test(ingress)) f.push("apps/ingress/src does not validate responses against routeResponses under WINDKEEL_VALIDATE_RESPONSES");
  if (!/WINDKEEL_VALIDATE_RESPONSES/.test(read("test/helpers.js"))) f.push("test/helpers.js does not turn WINDKEEL_VALIDATE_RESPONSES on for the suite");
  check(8, "responses validated against the contract", f);
}

// 9. Layering: the factory core sits below the domains built on it. Core = src/factory except the
// orchestration layers (workflow/, sweeps/) and the public barrels. Core never imports
// integrations, intake, billing, batches or schedules; those may import the core.
{
  const f = [];
  const UPPER = /^\.\.\/(?:\.\.\/)*(integrations|intake|billing|batches|schedules)\//;
  const ORCH = /^src\/factory\/(workflow|sweeps)\//;
  for (const p of walk(join(root, "src/factory"))) {
    const r = rel(p);
    if (ORCH.test(r)) continue;
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms)) {
      if (m[1]) continue; // type-only imports are erased
      const target = join(p, "..", m[2]);
      const tr = rel(target);
      if (/^src\/(integrations|intake|billing|batches|schedules)\//.test(tr)) f.push(`${r} imports ${m[2]} (core must not depend on ${tr.split("/")[1]})`);
    }
    for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const tr = rel(join(p, "..", m[1]));
      if (/^src\/(integrations|intake|billing|batches|schedules)\//.test(tr)) f.push(`${r} dynamically imports ${m[1]}`);
    }
  }
  check(9, "factory core layering", f);
}

// 10. No `export *`: a barrel names what it re-exports, so private helpers cannot leak through it.
{
  const f = [];
  for (const d of ["src", "apps/ingress/src", "apps/ingress/api", "apps/console/lib", "apps/console/app", "apps/console/components", "packages/cli/src", "packages/verification/src", "packages/api-contract/src"]) {
    if (!existsSync(join(root, d))) continue;
    for (const p of walk(join(root, d))) {
      const n = (readFileSync(p, "utf8").match(/^\s*export\s+\*\s+(as\s+\w+\s+)?from\s/gm) ?? []).length;
      if (n) f.push(`${rel(p)}: ${n} \`export *\` (name the re-exports)`);
    }
  }
  check(10, "no export *", f);
}

// 11. No unused exports in the factory and ingress: every exported name is imported somewhere else
// (source, apps, packages or tests), or it should not be exported. Values only: exported types
// may name a public signature without being imported. Name-based, so it errs toward
// passing; the public barrels (src/public) and route/entry files are the surface and exempt.
{
  const f = [];
  const scope = ["src", "apps/ingress/src"];
  const surface = /^(src\/public\/|apps\/ingress\/src\/(handler|config)\.ts$)/;
  const everything = [];
  for (const d of ["src", "apps", "packages", "test", "scripts", "bench"]) if (existsSync(join(root, d))) everything.push(...walk(join(root, d)));
  for (const t of existsSync(join(root, "test")) ? readdirSync(join(root, "test")) : []) if (/\.test\.(m?js|ts)$/.test(t)) everything.push(join(root, "test", t));
  const texts = new Map(everything.map((p) => [p, readFileSync(p, "utf8")]));
  const importedNames = new Set();
  for (const text of texts.values()) {
    for (const m of text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) importedNames.add(name);
      }
    }
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s*:\s*/)[0].trim();
        if (name) importedNames.add(name);
      }
    }
    for (const m of text.matchAll(/\b(?:\w+)\.(\w+)/g)) importedNames.add(m[1]); // namespace use: handlers.foo, mod.bar
  }
  for (const d of scope) {
    for (const p of walk(join(root, d))) {
      const r = rel(p);
      if (surface.test(r) || /"use (workflow|step)"/.test(texts.get(p) ?? "")) continue;
      const src = texts.get(p) ?? readFileSync(p, "utf8");
      for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|enum)\s+(\w+)/gm)) {
        if (!importedNames.has(m[1])) f.push(`${r}: export ${m[1]} is never imported (drop the export, or delete it if unused)`);
      }
    }
  }
  check(11, "no unused exports", f);
}

let bad = 0;
for (const r of results) {
  const ok = r.failures.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.id}. ${r.name}${ok ? "" : ` (${r.failures.length})`}`);
  for (const x of r.failures.slice(0, 15)) console.log(`        - ${x}`);
  if (r.failures.length > 15) console.log(`        … ${r.failures.length - 15} more`);
}
process.exit(bad ? 1 : 0);
