import { join } from "node:path";
import type { ExecutionEnvironment } from "./exec/environment.js";
import { secretKeyProblem } from "./secret-names.js";

export interface CheckSpec {
  name: string;
  command: string;
}

export interface FlowSpec {
  name: string;
  command: string;
  artifacts?: string;
}

export interface SystemToolSpec {
  package: string;
  reason?: string;
}

export interface RejectedTool {
  value: string;
  reason: string;
}

export const MAX_TOOLS = 8;

export const TOOL_NAME = /^[a-z0-9][a-z0-9+._-]{0,63}$/;

export interface WindkeelConfig {
  checks: CheckSpec[];
  checksRequired: boolean;
  flows: FlowSpec[];
  tools: SystemToolSpec[];
  rejectedTools: RejectedTool[];
  rejectedEntries?: RejectedEntry[];
  setup?: SetupSpec;
  requiredStages?: RequirableStage[];
}

export interface SetupCommandSpec {
  name: string;
  run: string;
  timeoutSec: number;
}

export interface SetupServiceSpec {
  name: string;
  start: string;
  ready?: string;
  readyTimeoutSec: number;
}

export interface SetupSpec {
  commands: SetupCommandSpec[];
  services: SetupServiceSpec[];
  secrets: string[];
  egress: string[];
  cacheKeyFiles: string[];
}

export type RequirableStage = "browser" | "security";

export interface RejectedEntry {
  kind: "check" | "flow" | "setup";
  value: string;
  reason: string;
}

export const ENTRY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function validEntryName(name: unknown): name is string {
  return typeof name === "string" && ENTRY_NAME.test(name) && name !== "." && name !== "..";
}

export function validArtifactsPath(path: unknown): boolean {
  if (path === undefined) return true;
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((segment) => segment === "..");
}

function screenEntries(
  checks: unknown[],
  flows: unknown[],
): { checks: CheckSpec[]; flows: FlowSpec[]; rejected: RejectedEntry[] } {
  const rejected: RejectedEntry[] = [];
  const ok: CheckSpec[] = [];
  const seen = new Set<string>();
  for (const raw of checks) {
    const c = raw as Partial<CheckSpec> | null;
    if (!c || typeof c !== "object" || typeof c.command !== "string" || !c.command.trim()) {
      rejected.push({ kind: "check", value: describe(raw), reason: "each check needs a `name` and a `command` string" });
    } else if (!validEntryName(c.name)) {
      rejected.push({ kind: "check", value: describe(c.name), reason: `check name must match ${ENTRY_NAME.source} and not be "." or ".."` });
    } else if (seen.has(c.name)) {
      rejected.push({ kind: "check", value: c.name, reason: "duplicate check name — the second would overwrite the first's transcript" });
    } else {
      seen.add(c.name);
      ok.push({ name: c.name, command: c.command });
    }
  }
  const okFlows: FlowSpec[] = [];
  const seenFlows = new Set<string>();
  for (const raw of flows) {
    const f = raw as Partial<FlowSpec> | null;
    if (!f || typeof f !== "object" || typeof f.command !== "string" || !f.command.trim()) {
      rejected.push({ kind: "flow", value: describe(raw), reason: "each flow needs a `name` and a `command` string" });
    } else if (!validEntryName(f.name)) {
      rejected.push({ kind: "flow", value: describe(f.name), reason: `flow name must match ${ENTRY_NAME.source} and not be "." or ".."` });
    } else if (!validArtifactsPath(f.artifacts)) {
      rejected.push({ kind: "flow", value: f.name, reason: "`artifacts` must be a relative path inside the checkout, with no `..` segment" });
    } else if (seenFlows.has(f.name)) {
      rejected.push({ kind: "flow", value: f.name, reason: "duplicate flow name" });
    } else {
      seenFlows.add(f.name);
      okFlows.push({ name: f.name, command: f.command, ...(typeof f.artifacts === "string" ? { artifacts: f.artifacts } : {}) });
    }
  }
  return { checks: ok, flows: okFlows, rejected };
}

type RawChecks = CheckSpec[] | { required?: boolean; commands?: CheckSpec[] };

interface RawConfig {
  checks?: RawChecks;
  flows?: FlowSpec[];
  tools?: unknown;
  setup?: unknown;
}

export const MAX_SETUP_TIMEOUT_SEC = 3600;
const DEFAULT_SETUP_TIMEOUT_SEC = 900;
const DEFAULT_READY_TIMEOUT_SEC = 60;
const SETUP_LIMITS = { commands: 16, services: 8, secrets: 32, egress: 16, cacheKeyFiles: 32 } as const;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function boundedSeconds(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_SETUP_TIMEOUT_SEC) return null;
  return raw;
}

export function parseSetup(raw: unknown): { setup?: SetupSpec; rejected: RejectedEntry[] } {
  const rejected: RejectedEntry[] = [];
  if (raw === undefined || raw === null) return { rejected };
  const refuse = (value: unknown, reason: string): void => {
    rejected.push({ kind: "setup", value: typeof value === "string" ? value.slice(0, 120) : describe(value), reason });
  };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    refuse(raw, "`setup` must be an object");
    return { rejected };
  }
  const r = raw as Record<string, unknown>;
  const list = (key: keyof typeof SETUP_LIMITS): unknown[] => {
    const value = r[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      refuse(value, `\`setup.${key}\` must be an array`);
      return [];
    }
    for (const extra of value.slice(SETUP_LIMITS[key])) {
      refuse(extra, `more than ${SETUP_LIMITS[key]} \`setup.${key}\` entries; the rest were not used`);
    }
    return value.slice(0, SETUP_LIMITS[key]);
  };

  const names = new Set<string>();
  const commands: SetupCommandSpec[] = [];
  for (const entry of list("commands")) {
    const c = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const timeout = c ? boundedSeconds(c["timeoutSec"], DEFAULT_SETUP_TIMEOUT_SEC) : null;
    if (!c || typeof c["run"] !== "string" || !c["run"].trim()) {
      refuse(entry, "each setup command needs a `name` and a `run` string");
    } else if (!validEntryName(c["name"])) {
      refuse(c["name"], `setup command name must match ${ENTRY_NAME.source} and not be "." or ".."`);
    } else if (names.has(c["name"])) {
      refuse(c["name"], "duplicate setup name");
    } else if (timeout === null) {
      refuse(c["name"], `\`timeoutSec\` must be a whole number of seconds from 1 to ${MAX_SETUP_TIMEOUT_SEC}`);
    } else {
      names.add(c["name"]);
      commands.push({ name: c["name"], run: c["run"], timeoutSec: timeout });
    }
  }

  const services: SetupServiceSpec[] = [];
  for (const entry of list("services")) {
    const v = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const timeout = v ? boundedSeconds(v["readyTimeoutSec"], DEFAULT_READY_TIMEOUT_SEC) : null;
    const ready = v?.["ready"];
    if (!v || typeof v["start"] !== "string" || !v["start"].trim()) {
      refuse(entry, "each setup service needs a `name` and a `start` string");
    } else if (!validEntryName(v["name"])) {
      refuse(v["name"], `setup service name must match ${ENTRY_NAME.source} and not be "." or ".."`);
    } else if (names.has(v["name"])) {
      refuse(v["name"], "duplicate setup name");
    } else if (ready !== undefined && (typeof ready !== "string" || !ready.trim())) {
      refuse(v["name"], "`ready` must be a command string when present");
    } else if (timeout === null) {
      refuse(v["name"], `\`readyTimeoutSec\` must be a whole number of seconds from 1 to ${MAX_SETUP_TIMEOUT_SEC}`);
    } else {
      names.add(v["name"]);
      services.push({
        name: v["name"],
        start: v["start"],
        ...(typeof ready === "string" ? { ready } : {}),
        readyTimeoutSec: timeout,
      });
    }
  }

  const secrets: string[] = [];
  for (const entry of list("secrets")) {
    const problem = typeof entry === "string" ? secretKeyProblem(entry) : "a secret name string is expected";
    if (problem) refuse(entry, `setup secret: ${problem}`);
    else if (!secrets.includes(entry as string)) secrets.push(entry as string);
  }

  const egress: string[] = [];
  for (const entry of list("egress")) {
    if (typeof entry !== "string" || !HOSTNAME.test(entry)) {
      refuse(entry, "setup egress entries are exact lower-case hostnames: no scheme, port, path or wildcard");
    } else if (!egress.includes(entry)) egress.push(entry);
  }

  const cacheKeyFiles: string[] = [];
  for (const entry of list("cacheKeyFiles")) {
    if (typeof entry !== "string" || !entry || entry.startsWith(":") || !validArtifactsPath(entry)) {
      refuse(entry, "`cacheKeyFiles` entries are relative paths inside the checkout, with no `..` segment");
    } else if (!cacheKeyFiles.includes(entry)) cacheKeyFiles.push(entry);
  }

  return {
    setup: { commands, services, secrets: secrets.sort(), egress: egress.sort(), cacheKeyFiles },
    rejected,
  };
}

const SCRIPT_CHECKS: Array<{ script: string; name: string }> = [
  { script: "typecheck", name: "typecheck" },
  { script: "lint", name: "lint" },
  { script: "test", name: "tests" },
];

export const CONFIG_FILE = "windkeel.config.json";
export const LEGACY_CONFIG_FILE = "orqon.config.json";

export async function configFileIn(source: ConfigSource): Promise<string | null> {
  if (await source.exists(CONFIG_FILE)) return CONFIG_FILE;
  if (await source.exists(LEGACY_CONFIG_FILE)) return LEGACY_CONFIG_FILE;
  return null;
}

export const CHECK_DISCOVERY_FILES = [
  CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  "package.json",
  "go.mod",
  "pyproject.toml",
  "pytest.ini",
  "setup.cfg",
  "ruff.toml",
  ".ruff.toml",
  "mypy.ini",
  ".mypy.ini",
  "uv.lock",
  "poetry.lock",
] as const;

export const CHECK_DISCOVERY_SOURCES =
  "`checks` in windkeel.config.json (or the older orqon.config.json), then the repo's own conventions per ecosystem: " +
  "package.json scripts (typecheck, lint, test); go.mod (go build/vet/test); and, for Python, " +
  "a tool configured in pyproject.toml, pytest.ini, setup.cfg, ruff.toml/.ruff.toml or " +
  "mypy.ini/.mypy.ini (pytest, ruff, mypy — run through uv.lock/poetry.lock's runner when one is present)";

export interface ConfigSource {
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<string>;
}

export function checkoutSource(execEnv: ExecutionEnvironment, repo: string): ConfigSource {
  return {
    exists: (name) => execEnv.exists(join(repo, name)),
    read: async (name) => (await execEnv.readFile(join(repo, name))).toString("utf8"),
  };
}

export async function revisionSource(
  execEnv: ExecutionEnvironment,
  repo: string,
  sha: string,
): Promise<ConfigSource | null> {
  if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) return null;
  const listing = await execEnv.exec("git", { args: ["ls-tree", "--name-only", sha], cwd: repo });
  if (listing.status !== 0) return null;
  const present = new Set(listing.stdout.split("\n").filter(Boolean));
  return {
    exists: async (name) => present.has(name),
    read: async (name) => {
      const shown = await execEnv.exec("git", {
        args: ["show", `${sha}:${name}`],
        cwd: repo,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (shown.status !== 0) throw new Error(`git show ${sha}:${name} failed: ${shown.stderr.trim()}`);
      return shown.stdout;
    },
  };
}

export async function loadConfig(
  execEnv: ExecutionEnvironment,
  repo: string,
): Promise<WindkeelConfig> {
  return loadConfigFrom(checkoutSource(execEnv, repo));
}

export async function loadConfigFrom(source: ConfigSource): Promise<WindkeelConfig> {
  const file = await configFileIn(source);
  if (file === null) {
    return {
      checks: await discoverChecks(source),
      checksRequired: false,
      flows: [],
      tools: [],
      rejectedTools: [],
    };
  }

  const parsed = JSON.parse(await source.read(file)) as RawConfig;
  const { tools, rejectedTools } = parseTools(parsed.tools);
  const setup = parseSetup(parsed.setup);
  const screened = (checks: unknown[], checksRequired: boolean): WindkeelConfig => {
    const s = screenEntries(checks, Array.isArray(parsed.flows) ? parsed.flows : []);
    const rejected = [...s.rejected, ...setup.rejected];
    return {
      checks: s.checks,
      checksRequired,
      flows: s.flows,
      tools,
      rejectedTools,
      ...(rejected.length ? { rejectedEntries: rejected } : {}),
      ...(setup.setup ? { setup: setup.setup } : {}),
    };
  };
  if (Array.isArray(parsed.checks)) return screened(parsed.checks, false);
  if (parsed.checks && typeof parsed.checks === "object") {
    const { required, commands } = parsed.checks;
    return screened(Array.isArray(commands) ? commands : await discoverChecks(source), required === true);
  }
  return screened(await discoverChecks(source), false);
}

export interface ConfigDrift {
  changes: string[];
  weakening: string[];
}

export function configDrift(base: WindkeelConfig, head: WindkeelConfig): ConfigDrift {
  const changes: string[] = [];
  const weakening: string[] = [];
  const byName = <T extends { name: string }>(xs: T[]) => new Map(xs.map((x) => [x.name, x]));

  const baseChecks = byName(base.checks);
  const headChecks = byName(head.checks);
  for (const [name, check] of baseChecks) {
    const now = headChecks.get(name);
    if (!now) weakening.push(`check \`${name}\` (\`${check.command}\`) is removed`);
    else if (now.command !== check.command) {
      changes.push(`check \`${name}\` changes from \`${check.command}\` to \`${now.command}\``);
    }
  }
  for (const [name, check] of headChecks) {
    if (!baseChecks.has(name)) changes.push(`check \`${name}\` (\`${check.command}\`) is added`);
  }
  if (base.checksRequired && !head.checksRequired) weakening.push("`checks.required` is switched off");
  if (!base.checksRequired && head.checksRequired) changes.push("`checks.required` is switched on");

  const baseFlows = byName(base.flows);
  const headFlows = byName(head.flows);
  for (const [name, flow] of baseFlows) {
    const now = headFlows.get(name);
    if (!now) weakening.push(`flow \`${name}\` is removed`);
    else if (now.command !== flow.command || now.artifacts !== flow.artifacts) {
      changes.push(`flow \`${name}\` changes`);
    }
  }
  for (const name of headFlows.keys()) {
    if (!baseFlows.has(name)) changes.push(`flow \`${name}\` is added`);
  }
  const tools = (c: WindkeelConfig) => JSON.stringify(c.tools.map((t) => t.package).sort());
  if (tools(base) !== tools(head)) changes.push("declared `tools` change");
  if (JSON.stringify(base.setup ?? null) !== JSON.stringify(head.setup ?? null)) {
    changes.push("declared `setup` changes (environments are built from the default branch's, not this one)");
  }
  return { changes, weakening };
}

export interface TrustedConfig {
  config: WindkeelConfig;
  source: "base" | "head";
  baseSha: string;
  drift: ConfigDrift;
  pinnedScripts: string[];
  scriptsOverlay?: ScriptsOverlay;
  baseUnavailable?: string;
}

export async function loadTrustedConfig(
  execEnv: ExecutionEnvironment,
  repo: string,
  baseSha: string,
): Promise<TrustedConfig> {
  const headSource = checkoutSource(execEnv, repo);
  const head = await loadConfigFrom(headSource);
  const baseSource = await revisionSource(execEnv, repo, baseSha);
  if (!baseSource) {
    return {
      config: head,
      source: "head",
      baseSha,
      drift: { changes: [], weakening: [] },
      pinnedScripts: [],
      baseUnavailable: `base revision \`${baseSha || "(none)"}\` could not be read from the checkout (shallow clone? fetch-depth: 0 fixes it)`,
    };
  }
  const base = await loadConfigFrom(baseSource);
  const drift = configDrift(base, head);

  const scriptsOf = async (source: ConfigSource): Promise<Record<string, string>> => {
    if (!(await source.exists("package.json"))) return {};
    try {
      const scripts = (JSON.parse(await source.read("package.json")) as { scripts?: unknown }).scripts;
      return scripts && typeof scripts === "object" ? (scripts as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const [baseScripts, headScripts] = [await scriptsOf(baseSource), await scriptsOf(headSource)];
  const changedScripts = [...new Set([...Object.keys(baseScripts), ...Object.keys(headScripts)])]
    .filter((name) => baseScripts[name] !== headScripts[name])
    .sort();

  let scriptsOverlay: ScriptsOverlay | undefined;
  if (changedScripts.length && (await headSource.exists("package.json"))) {
    const original = await headSource.read("package.json");
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(original) as unknown;
      parsed = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (parsed) {
      const patched = { ...parsed };
      if (Object.keys(baseScripts).length) patched["scripts"] = baseScripts;
      else delete patched["scripts"];
      scriptsOverlay = { file: "package.json", original, patched: JSON.stringify(patched, null, 2) + "\n" };
      drift.changes.push(
        `package.json \`scripts\` change (${changedScripts.map((s) => `\`${s}\``).join(", ")}); checks and flows ran with the base's scripts`,
      );
    }
  }

  return {
    config: base,
    source: "base",
    baseSha,
    drift,
    pinnedScripts: changedScripts,
    ...(scriptsOverlay ? { scriptsOverlay } : {}),
  };
}

export interface ScriptsOverlay {
  file: "package.json";
  original: string;
  patched: string;
}

export async function withScriptsOverlay<T>(
  execEnv: ExecutionEnvironment,
  repo: string,
  overlay: ScriptsOverlay | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!overlay) return fn();
  const path = join(repo, overlay.file);
  await execEnv.writeFile(path, overlay.patched);
  try {
    return await fn();
  } finally {
    await execEnv.writeFile(path, overlay.original);
  }
}

export function parseTools(raw: unknown): { tools: SystemToolSpec[]; rejectedTools: RejectedTool[] } {
  const tools: SystemToolSpec[] = [];
  const rejectedTools: RejectedTool[] = [];
  if (raw === undefined || raw === null) return { tools, rejectedTools };
  if (!Array.isArray(raw)) {
    return {
      tools,
      rejectedTools: [{ value: describe(raw), reason: "`tools` must be an array of package names" }],
    };
  }

  for (const entry of raw) {
    if (tools.length + rejectedTools.length >= MAX_TOOLS) {
      rejectedTools.push({
        value: describe(entry),
        reason: `more than ${MAX_TOOLS} tools declared; the rest were not installed`,
      });
      continue;
    }
    const spec =
      typeof entry === "string"
        ? { package: entry }
        : entry && typeof entry === "object" && typeof (entry as SystemToolSpec).package === "string"
          ? {
              package: (entry as SystemToolSpec).package,
              ...(typeof (entry as SystemToolSpec).reason === "string"
                ? { reason: (entry as SystemToolSpec).reason }
                : {}),
            }
          : null;
    if (!spec) {
      rejectedTools.push({
        value: describe(entry),
        reason: 'each entry must be a package name, or { "package": "name", "reason": "..." }',
      });
      continue;
    }
    if (!TOOL_NAME.test(spec.package)) {
      rejectedTools.push({
        value: spec.package,
        reason: `not a package name (must match ${TOOL_NAME.source}) — Windkeel installs named packages, never URLs or commands`,
      });
      continue;
    }
    if (tools.some((t) => t.package === spec.package)) continue;
    tools.push(spec);
  }
  return { tools, rejectedTools };
}

export interface MakerBrowserConfig {
  enabled: boolean;
  startCommand?: string;
  port?: number;
  rejected: string[];
}

const MAX_START_COMMAND = 500;

export function parseMakerBrowser(raw: unknown, hasFlows: boolean): MakerBrowserConfig {
  const rejected: string[] = [];
  const config: MakerBrowserConfig = { enabled: hasFlows, rejected };
  if (raw === undefined || raw === null) return config;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    rejected.push(`\`makerBrowser\` must be an object, got ${describe(raw)}`);
    return config;
  }
  const declared = raw as Record<string, unknown>;
  if ("enabled" in declared) {
    if (typeof declared["enabled"] === "boolean") config.enabled = declared["enabled"];
    else rejected.push(`\`makerBrowser.enabled\` must be true or false, got ${describe(declared["enabled"])}`);
  } else {
    config.enabled = true;
  }
  const start = declared["startCommand"];
  if (start !== undefined) {
    if (typeof start === "string" && start.trim() && start.length <= MAX_START_COMMAND && !/[\0\r\n]/.test(start)) {
      config.startCommand = start.trim();
    } else {
      rejected.push(
        `\`makerBrowser.startCommand\` must be one line of at most ${MAX_START_COMMAND} characters, got ${describe(start)}`,
      );
    }
  }
  const port = declared["port"];
  if (port !== undefined) {
    if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) config.port = port;
    else rejected.push(`\`makerBrowser.port\` must be an integer from 1 to 65535, got ${describe(port)}`);
  }
  return config;
}

export async function loadMakerBrowserConfig(
  execEnv: ExecutionEnvironment,
  repo: string,
): Promise<MakerBrowserConfig> {
  const source = checkoutSource(execEnv, repo);
  const file = await configFileIn(source);
  if (file === null) return { enabled: false, rejected: [] };
  let parsed: { flows?: unknown; makerBrowser?: unknown };
  try {
    parsed = JSON.parse(await source.read(file)) as typeof parsed;
  } catch (error) {
    return {
      enabled: false,
      rejected: [`windkeel.config.json is not JSON: ${error instanceof Error ? error.message.slice(0, 120) : "unreadable"}`],
    };
  }
  if (!parsed || typeof parsed !== "object") return { enabled: false, rejected: ["windkeel.config.json is not an object"] };
  const flows = screenEntries([], Array.isArray(parsed.flows) ? parsed.flows : []).flows;
  return parseMakerBrowser(parsed.makerBrowser, flows.length > 0);
}

function describe(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 120) ?? String(value).slice(0, 120);
}

async function discoverChecks(source: ConfigSource): Promise<CheckSpec[]> {
  return [
    ...(await fromScripts(source)),
    ...(await fromGoModule(source)),
    ...(await fromPythonTooling(source)),
  ];
}

async function fromScripts(source: ConfigSource): Promise<CheckSpec[]> {
  if (!(await source.exists("package.json"))) return [];
  const scripts = (
    JSON.parse(await source.read("package.json")) as {
      scripts?: Record<string, string>;
    }
  ).scripts;
  if (!scripts) return [];
  return SCRIPT_CHECKS.filter(({ script }) => script in scripts).map(({ script, name }) => ({
    name,
    command: `npm run --silent ${script}`,
  }));
}

async function fromGoModule(source: ConfigSource): Promise<CheckSpec[]> {
  if (!(await source.exists("go.mod"))) return [];
  return [
    { name: "go-build", command: "go build ./..." },
    { name: "go-vet", command: "go vet ./..." },
    { name: "go-tests", command: "go test ./..." },
  ];
}

async function fromPythonTooling(source: ConfigSource): Promise<CheckSpec[]> {
  const present = async (name: string): Promise<boolean> => source.exists(name);
  const read = async (name: string): Promise<string> =>
    (await present(name)) ? await source.read(name) : "";

  const pyproject = await read("pyproject.toml");
  const setupCfg = await read("setup.cfg");
  const pytestIni = await present("pytest.ini");
  const ruffToml = [await present("ruff.toml"), await present(".ruff.toml")].some(Boolean);
  const mypyIni = [await present("mypy.ini"), await present(".mypy.ini")].some(Boolean);
  const uvLock = await present("uv.lock");
  const poetryLock = await present("poetry.lock");

  const runner = uvLock ? "uv run" : poetryLock ? "poetry run" : "python -m";

  const checks: CheckSpec[] = [];
  if (hasSection(pyproject, "tool.ruff") || ruffToml) {
    checks.push({ name: "py-lint", command: `${runner} ruff check .` });
  }
  if (hasSection(pyproject, "tool.mypy") || mypyIni || hasSection(setupCfg, "mypy")) {
    checks.push({ name: "py-typecheck", command: `${runner} mypy .` });
  }
  if (
    hasSection(pyproject, "tool.pytest.ini_options") ||
    pytestIni ||
    hasSection(setupCfg, "tool:pytest")
  ) {
    checks.push({ name: "py-tests", command: `${runner} pytest` });
  }
  return checks;
}

function hasSection(text: string, section: string): boolean {
  if (!text) return false;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[\\s*${escaped}\\s*(\\..+?)?\\s*\\]`, "m").test(text);
}
