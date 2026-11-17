import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { toolInstalled, type ExecResult, type ExecutionEnvironment } from "../exec/environment.js";
import { describeExit, signalForExit } from "../exec/exit.js";
import type { EvidenceItem, Finding } from "../evidence/format.js";
import { withExitTrailer } from "../evidence/transcript.js";
import type { ScannerAssets } from "./scanner-assets.js";

export interface SecurityOutput {
  evidence: EvidenceItem;
  transcript: string;
  transcriptPath: string;
}

interface ScannerRun {
  name: string;
  tool: string;
  ran: boolean;
  note: string;
  findings: Finding[];
  raw: string;

  killed?: boolean;
}

const run = (execEnv: ExecutionEnvironment, cmd: string, args: string[], cwd: string): Promise<ExecResult> =>
  execEnv.exec(cmd, { args, cwd });

const skipped = (name: string, tool: string, note: string): ScannerRun => ({
  name,
  tool,
  ran: false,
  note,
  findings: [],
  raw: "",
});

const errored = (name: string, tool: string, result: ExecResult): ScannerRun => {

  const killed = result.signal !== null || signalForExit(result.status) !== null;
  const last = result.stderr.trim().split("\n").at(-1)?.slice(0, 200);
  return {
    name,
    tool,
    ran: false,
    note:
      `${tool} ${killed ? "was killed before it finished" : "could not complete"}: ` +
      describeExit(result) +
      (last ? ` — ${last}` : ""),
    findings: [],
    raw: truncate([result.stdout, result.stderr].filter(Boolean).join("\n")),
    ...(killed ? { killed: true } : {}),
  };
};

const truncate = (text: string, limit = 20_000): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated at ${limit} bytes]\n` : text;

async function gitDirOf(execEnv: ExecutionEnvironment, repo: string): Promise<string> {
  const result = await run(execEnv, "git", ["rev-parse", "--absolute-git-dir"], repo);
  const dir = result.status === 0 ? result.stdout.trim() : "";
  return dir || `${repo}/.git`;
}

async function gitleaks(execEnv: ExecutionEnvironment, repo: string): Promise<ScannerRun> {
  if (!(await toolInstalled(execEnv, "gitleaks"))) {
    return skipped("secrets", "gitleaks", "gitleaks is not installed on this runner");
  }

  const scratch = await execEnv.mkdtemp("windkeel-gitleaks-");
  const reportPath = `${scratch}/report.json`;

  const configPath = `${scratch}/gitleaks.toml`;
  const ignorePath = `${scratch}/gitleaksignore`;
  await execEnv.writeFile(configPath, 'title = "windkeel gate"\n\n[extend]\nuseDefault = true\n');
  await execEnv.writeFile(ignorePath, "");
  const result = await execEnv.exec("gitleaks", {
    args: [
      "detect",
      "--no-banner",
      "--no-color",
      "--redact",
      "--source",
      scratch,
      "--config",
      configPath,
      "--gitleaks-ignore-path",
      ignorePath,
      "--report-format",
      "json",
      "--report-path",
      reportPath,
    ],
    cwd: repo,
    env: { GIT_DIR: await gitDirOf(execEnv, repo) },
  });
  const report = (await execEnv.exists(reportPath))
    ? (await execEnv.readFile(reportPath)).toString("utf8")
    : "";
  const leaks = safeParse<Array<Record<string, string>>>(report);

  if (!leaks && result.status !== 0) return errored("secrets", "gitleaks", result);
  const found = leaks ?? [];
  return {
    name: "secrets",
    tool: "gitleaks",
    ran: true,
    note: `${found.length} secret(s) detected`,
    raw: truncate([result.stderr, report].filter(Boolean).join("\n")),
    findings: found.map((leak, i): Finding => ({
      id: `SEC-SECRET-${i + 1}`,
      severity: "blocking",
      category: "secret",
      claim: `${leak["Description"] ?? leak["RuleID"] ?? "secret"} committed to the repository`,
      location: `${leak["File"] ?? "?"}:${leak["StartLine"] ?? ""}`,
      failure_scenario:
        "The credential is readable by anyone with repository access and by anything that has already mirrored the history; it must be rotated, not just removed",
    })),
  };
}

const OSV_BLOCKING = new Set(["CRITICAL", "HIGH"]);

interface OsvReport {
  results?: Array<{
    source?: { path?: string };
    packages?: Array<{
      package?: { name?: string; ecosystem?: string };
      vulnerabilities?: Array<{ id?: string; summary?: string; database_specific?: { severity?: string } }>;
      groups?: Array<{ ids?: string[]; max_severity?: string }>;
    }>;
  }>;
}

async function osvScanner(
  execEnv: ExecutionEnvironment,
  repo: string,
  assets?: ScannerAssets,
  baseSha?: string,
): Promise<ScannerRun> {
  if (!(await toolInstalled(execEnv, "osv-scanner"))) {
    return skipped("dependencies", "osv-scanner", "osv-scanner is not installed on this runner");
  }

  const offline = assets ? await execEnv.exists(assets.osvMarker) : false;

  const configPath = `${await execEnv.mkdtemp("windkeel-osv-")}/osv-scanner.toml`;
  await execEnv.writeFile(configPath, "");
  const scan = (cwd: string) =>
    run(
      execEnv,
      "osv-scanner",
      [...(offline ? ["--offline-vulnerabilities"] : []), "--config", configPath, "--format", "json", "-r", "."],
      cwd,
    );
  const result = await scan(repo);
  const report = safeParse<OsvReport>(result.stdout);

  if (!report && result.status === 128 && /No package sources found/i.test(result.stderr)) {
    return {
      name: "dependencies",
      tool: "osv-scanner",
      ran: true,
      note: "no package manifests found, so there was nothing to check",
      raw: truncate(result.stderr),
      findings: [],
    };
  }
  if (!report && result.status !== 0) return errored("dependencies", "osv-scanner", result);
  const matches = advisoryMatches(report, repo);

  let baseline: Set<string> | null = null;
  let baselineNote = "";
  if (matches.some((m) => OSV_BLOCKING.has(m.severity))) {
    const base = await baselineAdvisories(execEnv, repo, baseSha, scan);
    if ("keys" in base) baseline = base.keys;
    else baselineNote = `; baseline unavailable (${base.unavailable}), so every advisory is treated as introduced by this change`;
  }
  const findings: Finding[] = [];
  let preexisting = 0;
  for (const match of matches) {
    const onBase = baseline?.has(match.key) ?? false;
    if (onBase) preexisting += 1;
    findings.push({
      id: `SEC-DEP-${match.vulnId || findings.length + 1}`,
      severity: OSV_BLOCKING.has(match.severity) && !onBase ? "blocking" : "non_blocking",
      category: "dependency",
      claim:
        `${match.pkg} is affected by ${match.vulnId} (${match.severity}): ${match.summary}` +
        (onBase ? ` — already present on the base revision ${(baseSha ?? "").slice(0, 12)}, not introduced by this change` : ""),
      location: match.location,
      failure_scenario: onBase
        ? `An attacker exploits ${match.vulnId} through ${match.pkg}, which the base revision already ships; this change neither introduces nor fixes it`
        : `An attacker exploits ${match.vulnId} through ${match.pkg} as shipped by this change`,
    });
  }
  return {
    name: "dependencies",
    tool: "osv-scanner",
    ran: true,
    note:
      `${findings.length} advisory match(es)${offline ? " (local database)" : ""}` +
      (preexisting ? `; ${preexisting} already on the base revision (reported, not blocking)` : "") +
      baselineNote,
    raw: truncate(result.stdout || result.stderr),
    findings,
  };
}

interface AdvisoryMatch {

  key: string;
  vulnId: string;
  pkg: string;
  severity: string;
  summary: string;
  location: string;
}

export function advisoryMatches(report: OsvReport | null, root: string): AdvisoryMatch[] {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  const out: AdvisoryMatch[] = [];
  for (const source of report?.results ?? []) {
    const location = source.source?.path ?? "";
    const relative = location.startsWith(prefix) ? location.slice(prefix.length) : location.replace(/^\.\//, "");
    for (const pkg of source.packages ?? []) {
      const name = pkg.package?.name ?? "dependency";
      for (const vuln of pkg.vulnerabilities ?? []) {
        const vulnId = vuln.id ?? "";
        out.push({
          key: `${relative}|${pkg.package?.ecosystem ?? ""}|${name}|${vulnId}`,
          vulnId,
          pkg: name,
          severity: (vuln.database_specific?.severity ?? "UNKNOWN").toUpperCase(),
          summary: vuln.summary ?? "",
          location,
        });
      }
    }
  }
  return out;
}

async function baselineAdvisories(
  execEnv: ExecutionEnvironment,
  repo: string,
  baseSha: string | undefined,
  scan: (cwd: string) => Promise<ExecResult>,
): Promise<{ keys: Set<string> } | { unavailable: string }> {
  if (!baseSha || !/^[0-9a-fA-F]{7,64}$/.test(baseSha)) return { unavailable: "no base revision was given" };
  const dir = await execEnv.mkdtemp("windkeel-osv-base-");

  const exported = await execEnv.exec("sh", {
    args: ["-c", 'git -C "$0" archive --format=tar -o "$2/.windkeel-base.tar" "$1" && tar -x -f "$2/.windkeel-base.tar" -C "$2" && rm -f "$2/.windkeel-base.tar"', repo, baseSha, dir],
  });
  if (exported.status !== 0) {
    const last = exported.stderr.trim().split("\n").at(-1)?.slice(0, 200);
    return { unavailable: `could not export ${baseSha.slice(0, 12)}: ${describeExit(exported)}${last ? ` — ${last}` : ""}` };
  }
  const result = await scan(dir);
  const report = safeParse<OsvReport>(result.stdout);
  if (!report && result.status === 128 && /No package sources found/i.test(result.stderr)) return { keys: new Set() };
  if (!report && result.status !== 0) return { unavailable: `osv-scanner on the base: ${describeExit(result)}` };
  return { keys: new Set(advisoryMatches(report, dir).map((m) => m.key)) };
}

interface SemgrepReport {
  results?: Array<{
    check_id?: string;
    path?: string;
    start?: { line?: number };
    extra?: { message?: string; severity?: string };
  }>;
}

async function semgrep(
  execEnv: ExecutionEnvironment,
  repo: string,
  assets?: ScannerAssets,
): Promise<ScannerRun> {
  if (!(await toolInstalled(execEnv, "semgrep"))) {
    return skipped("patterns", "semgrep", "semgrep is not installed on this runner");
  }

  const prefetched = assets && (await execEnv.exists(assets.semgrepRules));
  const rules = prefetched ? assets.semgrepRules : "p/ci";

  const ignoreName = `.windkeel-semgrepignore-${randomBytes(12).toString("hex")}`;
  const result = await run(
    execEnv,
    "semgrep",
    [
      "--config",
      rules,
      "--json",
      "--quiet",
      "--metrics",
      "off",
      "--x-semgrepignore-filename",
      ignoreName,
      ".",
    ],
    repo,
  );
  const report = safeParse<SemgrepReport>(result.stdout);
  if (!report && result.status !== 0) return errored("patterns", "semgrep", result);
  const findings = (report?.results ?? []).map((r, i): Finding => ({
    id: `SEC-PATTERN-${i + 1}`,
    severity: (r.extra?.severity === "ERROR" ? "blocking" : "non_blocking"),
    category: "dangerous-pattern",
    claim: `${r.check_id ?? "pattern"}: ${r.extra?.message ?? ""}`,
    location: `${r.path ?? "?"}:${r.start?.line ?? ""}`,
    failure_scenario: "The flagged construct is reachable in the shipped code path",
  }));
  return {
    name: "patterns",
    tool: "semgrep",
    ran: true,
    note: `${findings.length} rule match(es)${prefetched ? " (pre-fetched ruleset)" : ""}`,
    raw: truncate(result.stdout || result.stderr),
    findings,
  };
}

function scriptedRuns(path: string): ScannerRun[] {
  const scripted = JSON.parse(readFileSync(path, "utf8")) as Array<Partial<ScannerRun>>;
  return scripted.map((s) => ({
    name: s.name ?? s.tool ?? "scanner",
    tool: s.tool ?? "scanner",
    ran: s.ran ?? true,
    note: s.note ?? "",
    findings: s.findings ?? [],
    raw: s.raw ?? "",
  }));
}

function safeParse<T>(text: string): T | null {
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i !== -1);
  if (!starts.length) return null;
  try {
    return JSON.parse(text.slice(Math.min(...starts))) as T;
  } catch {
    return null;
  }
}

export async function runSecurity(
  execEnv: ExecutionEnvironment,
  id: string,
  repo: string,
  fakePath?: string,
  assets?: ScannerAssets,
  baseSha?: string,
): Promise<SecurityOutput> {
  const runs = fakePath
    ? scriptedRuns(fakePath)
    : [
        await gitleaks(execEnv, repo),
        await osvScanner(execEnv, repo, assets, baseSha),
        await semgrep(execEnv, repo, assets),
      ];
  const findings = runs.flatMap((r) => r.findings);
  const ran = runs.filter((r) => r.ran);
  const missing = runs.filter((r) => !r.ran);
  const transcriptPath = `evidence/${id}-security.log`;

  const status = !ran.length
    ? "skipped"
    : findings.length
      ? "completed_with_findings"
      : missing.length
        ? "warning"
        : "passed";

  return {
    evidence: {
      id,
      stage: "security",
      type: "security_scan",
      status,
      ...(status === "skipped"
        ? { reason: `no_scanner_available — ${missing.map((m) => m.tool).join(", ")}` }
        : {
            summary: [
              `${ran.map((r) => `${r.tool}: ${r.note}`).join("; ")}`,
              missing.length ? `not run: ${missing.map((m) => `${m.tool} (${m.note})`).join("; ")}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
          }),
      scanners: runs.map((r) => ({
        tool: r.tool,
        ran: r.ran,
        note: r.note,
        ...(r.killed ? { killed: true } : {}),
      })),
      transcript: transcriptPath,
      ...(findings.length ? { findings } : {}),
    },

    transcript: withExitTrailer(
      runs.map((r) => `# ${r.tool} (${r.ran ? "ran" : "skipped"}) — ${r.note}\n${r.raw}`).join("\n\n"),
      ran.length ? 0 : "none",
    ),
    transcriptPath,
  };
}
