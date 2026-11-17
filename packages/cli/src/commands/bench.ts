import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerificationEngine } from "@windkeel/verification/engine/engine.js";
import type { EvidenceItem, VerdictFile } from "@windkeel/verification/evidence/format.js";
import { toolInstalled } from "@windkeel/verification/exec/environment.js";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { modelPolicyFromEnv } from "@windkeel/verification/providers/index.js";
import { readExplicitIntent } from "@windkeel/verification/stages/intent.js";
import { resolveSubject } from "../subject.js";

export interface BenchCase {
  id: string;
  kind: "seeded" | "clean" | "replay";
  category?: string;
  expect: "pass" | "fail";
  defect?: string;
  stage?: string;
  note?: string;
  intent?: string;
  env?: Record<string, string>;
  requires?: string[];
}

export interface CaseResult extends BenchCase {
  verdict: string;
  correct: boolean;
  completeness: number;
  caughtBy: string[];
  unsatisfied: string[];
  skipped?: string;
}

export interface CategoryCoverage {
  category: string;
  planted: number;
  caught: number;
}

export interface BenchReport {
  cases: CaseResult[];
  catch_rate: number;
  false_positive_rate: number;
  evidence_completeness: number;
  controls: number;
  coverage: CategoryCoverage[];
  skipped: Array<{ id: string; reason: string }>;
}

const ratio = (numerator: number, denominator: number, whenEmpty = 1): number =>
  denominator === 0 ? whenEmpty : Number((numerator / denominator).toFixed(4));

function stageCompleteness(evidence: EvidenceItem[]): number {
  if (!evidence.length) return 0;
  return ratio(evidence.filter((e) => e.status !== "skipped").length, evidence.length, 0);
}

function materialize(caseDir: string): string {
  const work = mkdtempSync(join(tmpdir(), "windkeel-bench-"));
  const repo = join(work, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  git("init", "-q");
  git("config", "user.email", "bench@windkeel.dev");
  git("config", "user.name", "windkeel bench");
  if (existsSync(join(caseDir, "base"))) {
    cpSync(join(caseDir, "base"), repo, { recursive: true });
    git("add", "-A");
    git("commit", "-qm", "base");
  }
  cpSync(join(caseDir, "head"), repo, { recursive: true });
  git("add", "-A");
  git("commit", "-qm", "head");
  return repo;
}

function caseEnv(caseDir: string, env: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    resolved[key] = existsSync(join(caseDir, value)) ? join(caseDir, value) : value;
  }
  return resolved;
}

export async function runBench(corpus: string): Promise<BenchReport> {
  const execEnv = new LocalExecutionEnvironment();
  const caseDirs = readdirSync(corpus, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(corpus, d.name))
    .filter((dir) => existsSync(join(dir, "case.json")))
    .sort();

  const cases: CaseResult[] = [];
  for (const caseDir of caseDirs) {
    const spec = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as BenchCase;

    if (spec.kind === "replay") {
      cases.push({
        ...spec,
        verdict: "not-run",
        correct: true,
        completeness: 0,
        caughtBy: [],
        unsatisfied: [],
        skipped: "replays are non-hermetic; run `windkeel replay` instead",
      });
      continue;
    }

    const absent = [];
    for (const tool of spec.requires ?? []) {
      if (!(await toolInstalled(execEnv, tool))) absent.push(tool);
    }
    if (absent.length) {
      cases.push({
        ...spec,
        verdict: "not-run",
        correct: true,
        completeness: 0,
        caughtBy: [],
        unsatisfied: [],
        skipped: `requires ${absent.join(", ")}, not installed on this runner`,
      });
      continue;
    }

    const repo = materialize(caseDir);
    const out = join(repo, "..", "evidence");
    const env = caseEnv(caseDir, spec.env);
    const resolved = await resolveSubject(execEnv, { repo, event: null, runner: "local" });
    await createVerificationEngine().verify({
      execEnv,
      repo,
      out,
      subject: resolved.subject,
      runner: resolved.runner,
      prBody: "",
      issueBody: "",
      criteria: spec.intent ? readExplicitIntent(join(caseDir, spec.intent)) : undefined,
      models: modelPolicyFromEnv(env),
      fakeSecurity: env["WINDKEEL_FAKE_SECURITY"],
    });

    const verdictFile = JSON.parse(readFileSync(join(out, "verdict.json"), "utf8")) as VerdictFile;
    const evidence = readdirSync(join(out, "evidence"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(out, "evidence", f), "utf8")) as EvidenceItem);

    const unsatisfied = verdictFile.unsatisfied_criteria ?? [];
    cases.push({
      ...spec,
      verdict: verdictFile.verdict,
      correct: spec.expect === "fail" ? verdictFile.verdict === "fail" : verdictFile.verdict !== "fail",
      completeness: stageCompleteness(evidence),
      caughtBy: [
        ...new Set([
          ...evidence.filter((e) => e.findings?.length).map((e) => e.stage),
          ...(unsatisfied.length ? ["intent"] : []),
        ]),
      ].sort(),
      unsatisfied,
    });
  }

  const scored = cases.filter((c) => !c.skipped);
  const seeded = scored.filter((c) => c.expect === "fail");
  const clean = scored.filter((c) => c.expect === "pass");

  const coverage: CategoryCoverage[] = [];
  for (const category of [...new Set(seeded.map((c) => c.category ?? "uncategorised"))].sort()) {
    const planted = seeded.filter((c) => (c.category ?? "uncategorised") === category);
    coverage.push({
      category,
      planted: planted.length,
      caught: planted.filter((c) => c.correct).length,
    });
  }

  return {
    cases,
    catch_rate: ratio(seeded.filter((c) => c.correct).length, seeded.length),
    false_positive_rate: ratio(clean.filter((c) => !c.correct).length, clean.length, 0),
    evidence_completeness: ratio(
      scored.reduce((sum, c) => sum + c.completeness, 0),
      scored.length,
      0,
    ),
    controls: clean.length,
    coverage,
    skipped: cases.filter((c) => c.skipped).map((c) => ({ id: c.id, reason: c.skipped! })),
  };
}

export function formatReport(report: BenchReport): string {
  const rows = report.cases.map((c) =>
    c.skipped
      ? `  skip ${c.id.padEnd(28)} ${c.kind.padEnd(7)} not scored — ${c.skipped}`
      : `  ${c.correct ? "ok  " : "MISS"} ${c.id.padEnd(28)} ${c.kind.padEnd(7)} expected ${c.expect}, got ${c.verdict}${
          c.caughtBy.length ? ` (${c.caughtBy.join(", ")})` : ""
        }`,
  );
  return [
    ...rows,
    "",
    "defect categories planted:",
    ...report.coverage.map(
      (c) => `  ${c.caught === c.planted ? "ok  " : "MISS"} ${c.category.padEnd(20)} ${c.caught}/${c.planted} caught`,
    ),
    "",
    `catch rate:           ${(report.catch_rate * 100).toFixed(1)}%  (seeded defects that fail the gate)`,
    `false positive rate:  ${(report.false_positive_rate * 100).toFixed(1)}%  (clean changes wrongly failed, over ${report.controls} control(s))`,
    `evidence completeness:${(report.evidence_completeness * 100).toFixed(1)}%  (stages producing evidence, not skips)`,
    ...(report.skipped.length
      ? [
          "",
          `${report.skipped.length} case(s) not scored — the corpus is smaller than it looks on this runner:`,
          ...report.skipped.map((s) => `  ${s.id}: ${s.reason}`),
        ]
      : []),
  ].join("\n");
}
