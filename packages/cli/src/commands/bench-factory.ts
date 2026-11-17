import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { WindkeelApi } from "../client/api.js";
import { findRepositoryId } from "./remote.js";

export const DEFAULT_TASK_CAP_USD = 2;
export const DEFAULT_TOTAL_CAP_USD = 50;
export const DEFAULT_TIMEOUT_MINUTES = 45;

export const TASK_SOURCES = ["swe-bench", "real-repo"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export interface FactoryBenchTask {
  id: string;
  source: TaskSource;
  repository: string;
  windkeel_repository?: string;
  base_ref: string;
  title: string;
  description: string;
  acceptance_criteria?: string[];
  hidden_tests: { command: string; files: string[]; timeout_seconds?: number };
  budget_usd: number;
  timeout_minutes: number;
  risk_level?: "low" | "medium" | "high";
  upstream?: { repo?: string; fix_commit?: string; pull_request?: string; license?: string };
  reference_patch?: string;
  notes?: string;
  dir: string;
}

export class TaskValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid factory bench tasks:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "TaskValidationError";
  }
}

export function githubFullName(url: string): string | null {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

const REFUSED_TARGETS = new Set(["jyothepro/windkeel"]);

export function refusedTarget(task: Pick<FactoryBenchTask, "repository" | "windkeel_repository">): string | null {
  for (const candidate of [githubFullName(task.repository), task.windkeel_repository ?? null]) {
    if (candidate && REFUSED_TARGETS.has(candidate.toLowerCase())) {
      return `targets ${candidate}, the factory's own repository — benchmark tasks run on scratch repos only`;
    }
  }
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function escapes(path: string): boolean {
  if (isAbsolute(path) || path.includes("\0")) return true;
  const normalized = normalize(path);
  return normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.startsWith("../");
}

export function validateTask(raw: unknown, dir: string, options: { taskCapUsd?: number } = {}): string[] {
  const cap = options.taskCapUsd ?? DEFAULT_TASK_CAP_USD;
  const where = dir.split(/[\\/]/).pop() ?? dir;
  const problems: string[] = [];
  const say = (problem: string) => problems.push(`${where}: ${problem}`);
  if (!isObject(raw)) {
    say("task.json is not a JSON object");
    return problems;
  }
  if (!nonEmpty(raw["id"])) say("id is required");
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(raw["id"])) say(`id ${JSON.stringify(raw["id"])} must be [a-z0-9._-]`);
  if (!TASK_SOURCES.includes(raw["source"] as TaskSource)) {
    say(`source must be one of ${TASK_SOURCES.join(", ")} (got ${JSON.stringify(raw["source"])})`);
  }
  if (!nonEmpty(raw["repository"])) say("repository is required");
  if (raw["windkeel_repository"] !== undefined && !nonEmpty(raw["windkeel_repository"])) {
    say("windkeel_repository, when given, must be a non-empty string");
  }
  if (!nonEmpty(raw["base_ref"])) say("base_ref is required");
  if (!nonEmpty(raw["title"])) say("title is required");
  if (!nonEmpty(raw["description"])) say("description is required");
  const criteria = raw["acceptance_criteria"];
  if (criteria !== undefined && (!Array.isArray(criteria) || !criteria.every(nonEmpty))) {
    say("acceptance_criteria, when given, must be a list of non-empty strings");
  }
  const budget = raw["budget_usd"];
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    say(`budget_usd must be a positive number (got ${JSON.stringify(budget)})`);
  } else if (budget > cap) {
    say(`budget_usd ${budget} is over the per-task cap of $${cap}`);
  }
  const timeout = raw["timeout_minutes"];
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    say(`timeout_minutes must be a positive number (got ${JSON.stringify(timeout)})`);
  }
  const risk = raw["risk_level"];
  if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high") {
    say(`risk_level must be low, medium or high (got ${JSON.stringify(risk)})`);
  }

  const hidden = raw["hidden_tests"];
  if (!isObject(hidden)) {
    say("hidden_tests is required: { command, files }");
  } else {
    if (!nonEmpty(hidden["command"])) say("hidden_tests.command is required");
    const files = hidden["files"];
    if (!Array.isArray(files) || files.length === 0 || !files.every(nonEmpty)) {
      say("hidden_tests.files must list at least one file");
    } else {
      for (const file of files) {
        if (escapes(file)) {
          say(`hidden test path ${JSON.stringify(file)} escapes the task directory`);
        } else if (!existsSync(join(dir, "hidden", file)) || !statSync(join(dir, "hidden", file)).isFile()) {
          say(`hidden test file hidden/${file} does not exist`);
        }
      }
      const stated = [raw["title"], raw["description"], ...(Array.isArray(criteria) ? criteria : [])]
        .filter((s): s is string => typeof s === "string")
        .join("\n");
      for (const file of files) {
        if (stated.includes(file)) say(`the task text names hidden test file ${file} — hidden tests must stay hidden`);
      }
    }
    const hiddenTimeout = hidden["timeout_seconds"];
    if (hiddenTimeout !== undefined && (typeof hiddenTimeout !== "number" || hiddenTimeout <= 0)) {
      say("hidden_tests.timeout_seconds, when given, must be a positive number");
    }
  }

  const reference = raw["reference_patch"];
  if (reference !== undefined) {
    if (!nonEmpty(reference) || escapes(reference)) say("reference_patch must be a path inside the task directory");
    else if (!existsSync(join(dir, reference))) say(`reference_patch ${reference} does not exist`);
  }
  const upstream = raw["upstream"];
  if (upstream !== undefined && !isObject(upstream)) say("upstream, when given, must be an object");

  if (nonEmpty(raw["repository"])) {
    const refused = refusedTarget({
      repository: raw["repository"],
      ...(nonEmpty(raw["windkeel_repository"]) ? { windkeel_repository: raw["windkeel_repository"] } : {}),
    });
    if (refused) say(refused);
  }
  return problems;
}

export function loadTasks(dir: string, options: { taskCapUsd?: number } = {}): FactoryBenchTask[] {
  const root = resolve(dir);
  if (!existsSync(root)) throw new TaskValidationError([`no tasks directory at ${root}`]);
  const problems: string[] = [];
  const tasks: FactoryBenchTask[] = [];
  const seen = new Map<string, string>();
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "task.json")))
    .map((d) => join(root, d.name))
    .sort();
  for (const taskDir of dirs) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
    } catch (error) {
      problems.push(`${taskDir.split(/[\\/]/).pop()}: task.json does not parse: ${(error as Error).message}`);
      continue;
    }
    const found = validateTask(raw, taskDir, options);
    problems.push(...found);
    if (found.length) continue;
    const task = { ...(raw as Omit<FactoryBenchTask, "dir">), dir: taskDir };
    const previous = seen.get(task.id);
    if (previous) {
      problems.push(`${taskDir.split(/[\\/]/).pop()}: duplicate id ${task.id} (also in ${previous})`);
      continue;
    }
    seen.set(task.id, taskDir.split(/[\\/]/).pop() ?? taskDir);
    tasks.push(task);
  }
  if (problems.length) throw new TaskValidationError(problems);
  return tasks;
}

export function submissionText(task: FactoryBenchTask): string {
  const criteria = task.acceptance_criteria ?? [];
  if (!criteria.length) return task.description;
  return `${task.description.trimEnd()}\n\n## Acceptance criteria\n\n${criteria.map((c) => `- [ ] ${c}`).join("\n")}\n`;
}

export interface BenchRunSnapshot {
  state: string;
  terminal: boolean;
  settled: boolean;
  finalVerdict: string | null;
  stopReason: string | null;
  verdicts: Array<string | null>;
  repairTurns: number;
  costUsd: number;
  costLowerBound: boolean;
  headSha: string | null;
  prNumber: number | null;
}

const SETTLED_STATES = new Set(["COMPLETED", "CANCELLED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "WAITING_FOR_HUMAN", "BLOCKED"]);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function snapshotFromReport(report: unknown, extra: { prNumber?: number | null } = {}): BenchRunSnapshot {
  const r = isObject(report) ? report : {};
  const state = str(r["state"]) ?? "UNKNOWN";
  const verifications = Array.isArray(r["verifications"]) ? r["verifications"].filter(isObject) : [];
  const completed = verifications.filter((v) => v["completedAt"] !== null && v["completedAt"] !== undefined);
  const ofRecord = verifications.find((v) => v["verdictOfRecord"] === true);
  const cost = isObject(r["cost"]) ? r["cost"] : {};
  return {
    state,
    terminal: r["terminal"] === true,
    settled: r["terminal"] === true || SETTLED_STATES.has(state),
    finalVerdict: str(r["finalVerdict"]),
    stopReason: str(r["stopReason"]),
    verdicts: completed.map((v) => str(v["verdict"])),
    repairTurns: num(r["repairAttemptsTaken"]) ?? 0,
    costUsd: num(cost["totalUsd"]) ?? 0,
    costLowerBound: (num(cost["unpricedModelCalls"]) ?? 0) > 0,
    headSha: str(ofRecord?.["candidateSha"]) ?? str(completed.at(-1)?.["candidateSha"]) ?? null,
    prNumber: extra.prNumber ?? null,
  };
}

export interface FactoryBenchClient {
  submit(task: FactoryBenchTask): Promise<{ runId: string }>;
  snapshot(runId: string): Promise<BenchRunSnapshot>;
  cancel(runId: string, reason: string): Promise<void>;
}

export function apiBenchClient(api: WindkeelApi): FactoryBenchClient {
  const repositories = new Map<string, string>();
  const tasksByRun = new Map<string, string>();
  return {
    async submit(task) {
      const wanted = task.windkeel_repository ?? githubFullName(task.repository) ?? task.repository;
      let repositoryId = repositories.get(wanted);
      if (!repositoryId) {
        const found = await findRepositoryId(api, wanted);
        if (!found) throw new Error(`no repository ${wanted} is granted to this organization`);
        repositoryId = found;
        repositories.set(wanted, found);
      }
      const ack = await api.submitTask({
        repositoryId,
        title: task.title,
        description: submissionText(task),
        riskLevel: task.risk_level ?? "low",
        spendCapUsd: task.budget_usd,
        wallClockCapSeconds: Math.round(task.timeout_minutes * 60),
      });
      if (!ack.accepted || !ack.engineeringRunId) {
        throw new Error(`the deployment did not start a run (outcome ${ack.outcome ?? "unknown"})`);
      }
      if (ack.taskId) tasksByRun.set(ack.engineeringRunId, ack.taskId);
      return { runId: ack.engineeringRunId };
    },
    async snapshot(runId) {
      const { report } = await api.getRun(runId);
      const taskId =
        tasksByRun.get(runId) ?? (isObject(report) && isObject(report["task"]) ? str(report["task"]["id"]) : null);
      let prNumber: number | null = null;
      if (taskId) {
        const page = await api.listRuns({ task: taskId });
        prNumber = page.items.find((r) => r.id === runId)?.prNumber ?? null;
      }
      return snapshotFromReport(report, { prNumber });
    },
    async cancel(runId, reason) {
      await api.cancel(runId, reason);
    },
  };
}

export type HiddenOutcome = "pass" | "fail" | "not_run";

export interface HiddenTestResult {
  outcome: HiddenOutcome;
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputTail?: string;
}

export interface FactoryBenchDeps {
  client: FactoryBenchClient;
  runHiddenTests(task: FactoryBenchTask, head: { sha: string; prNumber: number | null }): Promise<HiddenTestResult>;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  log?: (line: string) => void;
}

export interface FactoryBenchOptions {
  totalCapUsd?: number;
  concurrency?: number;
  pollMs?: number;
  preExcluded?: ReadonlyMap<string, string>;
}

export interface FactoryTaskResult {
  id: string;
  source: TaskSource;
  run_id: string | null;
  state: string | null;
  stop_reason: string | null;
  verdict: string | null;
  first_verdict: string | null;
  hidden_tests: HiddenOutcome;
  hidden_detail: string | null;
  repair_turns: number;
  cost_usd: number | null;
  cost_lower_bound: boolean;
  wall_seconds: number | null;
  pr_url: string | null;
  head_sha: string | null;
  excluded?: string;
}

export interface Distribution {
  mean: number | null;
  p50: number | null;
  p90: number | null;
}

export interface BenchFactoryReport {
  tasks: FactoryTaskResult[];
  attempted: number;
  successes: number;
  success_rate: number;
  verified_false_accept_rate: number;
  verified_false_reject_rate: number;
  repair_conversion_rate: number;
  cost_per_task_usd: Distribution;
  cost_per_success_usd: number | null;
  wall_seconds_per_task: Distribution;
  total_cost_usd: number;
  counts: {
    accepted: number;
    false_accepts: number;
    rejected: number;
    false_rejects: number;
    failed_first: number;
    converted: number;
  };
  excluded: Array<{ id: string; reason: string }>;
}

const ratio = (numerator: number, denominator: number, whenEmpty: number): number =>
  denominator === 0 ? whenEmpty : Number((numerator / denominator).toFixed(4));

const round = (value: number): number => Number(value.toFixed(6));

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function distribution(values: number[]): Distribution {
  if (!values.length) return { mean: null, p50: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: round(values.reduce((s, v) => s + v, 0) / values.length),
    p50: round(percentile(sorted, 0.5)!),
    p90: round(percentile(sorted, 0.9)!),
  };
}

export function scoreFactoryBench(results: FactoryTaskResult[]): BenchFactoryReport {
  const scored = results.filter((r) => !r.excluded);
  const accepted = scored.filter((r) => r.verdict === "pass");
  const rejected = scored.filter((r) => r.verdict !== "pass");
  const successes = accepted.filter((r) => r.hidden_tests === "pass");
  const falseAccepts = accepted.filter((r) => r.hidden_tests === "fail");
  const falseRejects = rejected.filter((r) => r.hidden_tests === "pass");
  const failedFirst = scored.filter((r) => r.first_verdict === "fail");
  const converted = failedFirst.filter((r) => r.verdict === "pass");
  const costs = scored.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  const scoredCost = costs.reduce((s, c) => s + c, 0);
  return {
    tasks: results,
    attempted: scored.length,
    successes: successes.length,
    success_rate: ratio(successes.length, scored.length, 0),
    verified_false_accept_rate: ratio(falseAccepts.length, accepted.length, 0),
    verified_false_reject_rate: ratio(falseRejects.length, rejected.length, 0),
    repair_conversion_rate: ratio(converted.length, failedFirst.length, 0),
    cost_per_task_usd: distribution(costs),
    cost_per_success_usd: successes.length ? round(scoredCost / successes.length) : null,
    wall_seconds_per_task: distribution(
      scored.map((r) => r.wall_seconds).filter((w): w is number => w !== null),
    ),
    total_cost_usd: round(results.reduce((s, r) => s + (r.cost_usd ?? 0), 0)),
    counts: {
      accepted: accepted.length,
      false_accepts: falseAccepts.length,
      rejected: rejected.length,
      false_rejects: falseRejects.length,
      failed_first: failedFirst.length,
      converted: converted.length,
    },
    excluded: results.filter((r) => r.excluded).map((r) => ({ id: r.id, reason: r.excluded! })),
  };
}

export function pullRequestUrl(task: Pick<FactoryBenchTask, "repository">, prNumber: number | null): string | null {
  const name = githubFullName(task.repository);
  return name && prNumber !== null ? `https://github.com/${name}/pull/${prNumber}` : null;
}

function exclusionFor(snapshot: BenchRunSnapshot, budgetUsd: number): string | null {
  if (snapshot.stopReason === "spend_cap" || snapshot.costUsd > budgetUsd) {
    return `budget: the run spent $${snapshot.costUsd.toFixed(4)} against a cap of $${budgetUsd}`;
  }
  if (snapshot.stopReason === "model_policy") return "infra: the run's models could not be used (model_policy)";
  if (snapshot.stopReason === "approval_expired") return "infra: generated criteria were never approved";
  if (!snapshot.verdicts.length) {
    return `infra: the run ended ${snapshot.state}${snapshot.stopReason ? ` (${snapshot.stopReason})` : ""} with no completed verification`;
  }
  if (snapshot.stopReason === "error") return `infra: the run could not continue (${snapshot.state})`;
  if (snapshot.state === "CANCELLED") return "infra: the run was cancelled by someone else";
  if (!snapshot.headSha) return "infra: no candidate of record to test";
  return null;
}

const defaultClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

export async function runFactoryBench(
  tasks: FactoryBenchTask[],
  deps: FactoryBenchDeps,
  options: FactoryBenchOptions = {},
): Promise<BenchFactoryReport> {
  const clock = deps.clock ?? defaultClock;
  const log = deps.log ?? (() => {});
  const totalCap = options.totalCapUsd ?? DEFAULT_TOTAL_CAP_USD;
  const pollMs = options.pollMs ?? 10_000;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));

  let spent = 0;
  let reserved = 0;
  const results: FactoryTaskResult[] = new Array(tasks.length);

  const runOne = async (task: FactoryBenchTask): Promise<FactoryTaskResult> => {
    const row: FactoryTaskResult = {
      id: task.id,
      source: task.source,
      run_id: null,
      state: null,
      stop_reason: null,
      verdict: null,
      first_verdict: null,
      hidden_tests: "not_run",
      hidden_detail: null,
      repair_turns: 0,
      cost_usd: null,
      cost_lower_bound: false,
      wall_seconds: null,
      pr_url: null,
      head_sha: null,
    };
    const refused = refusedTarget(task);
    if (refused) return { ...row, excluded: `refused: ${refused}` };
    const unchecked = options.preExcluded?.get(task.id);
    if (unchecked) return { ...row, excluded: unchecked };
    if (spent + reserved + task.budget_usd > totalCap + 1e-9) {
      return {
        ...row,
        excluded: `total_budget: $${(spent + reserved).toFixed(2)} spent or reserved, and this task's $${task.budget_usd} would pass the $${totalCap} cap`,
      };
    }
    reserved += task.budget_usd;
    const started = clock.now();
    let snapshot: BenchRunSnapshot | null = null;
    let excluded: string | null = null;
    try {
      let runId: string;
      try {
        runId = (await deps.client.submit(task)).runId;
      } catch (error) {
        return { ...row, excluded: `infra: submit failed: ${(error as Error).message}` };
      }
      row.run_id = runId;
      log(`${task.id}: submitted as run ${runId}`);
      const deadline = started + task.timeout_minutes * 60_000;
      for (;;) {
        try {
          snapshot = await deps.client.snapshot(runId);
        } catch (error) {
          log(`${task.id}: reading run ${runId} failed, retrying: ${(error as Error).message}`);
        }
        if (snapshot?.settled) break;
        if (snapshot && snapshot.costUsd > task.budget_usd) {
          excluded = `budget: cancelled client-side at $${snapshot.costUsd.toFixed(4)}, over the $${task.budget_usd} cap`;
          break;
        }
        if (clock.now() >= deadline) {
          excluded = `timeout: not settled after ${task.timeout_minutes} minute(s)${snapshot ? ` (last state ${snapshot.state})` : ""}`;
          break;
        }
        await clock.sleep(pollMs);
      }
      if (excluded) {
        await deps.client.cancel(runId, `windkeel bench-factory: ${excluded}`).catch((error: unknown) => {
          log(`${task.id}: cancel failed: ${(error as Error).message}`);
        });
        snapshot = (await deps.client.snapshot(runId).catch(() => null)) ?? snapshot;
      }
    } finally {
      reserved -= task.budget_usd;
    }

    row.wall_seconds = Number(((clock.now() - started) / 1000).toFixed(3));
    if (snapshot) {
      spent += snapshot.costUsd;
      row.state = snapshot.state;
      row.stop_reason = snapshot.stopReason;
      row.verdict = snapshot.finalVerdict;
      row.first_verdict = snapshot.verdicts[0] ?? null;
      row.repair_turns = snapshot.repairTurns;
      row.cost_usd = round(snapshot.costUsd);
      row.cost_lower_bound = snapshot.costLowerBound;
      row.head_sha = snapshot.headSha;
      row.pr_url = pullRequestUrl(task, snapshot.prNumber);
    }
    excluded ??= snapshot ? exclusionFor(snapshot, task.budget_usd) : "infra: the run could never be read";
    if (excluded) return { ...row, excluded };

    const hidden = await deps.runHiddenTests(task, { sha: snapshot!.headSha!, prNumber: snapshot!.prNumber });
    row.hidden_tests = hidden.outcome;
    row.hidden_detail = hidden.reason ?? null;
    log(`${task.id}: verdict ${row.verdict}, hidden tests ${hidden.outcome}`);
    if (hidden.outcome === "not_run") {
      return { ...row, excluded: `hidden_tests_not_run: ${hidden.reason ?? "unknown"}` };
    }
    return row;
  };

  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runOne(tasks[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return scoreFactoryBench(results);
}

export interface FactoryBenchPlan {
  tasks: Array<{
    id: string;
    source: TaskSource;
    repository: string;
    base_ref: string;
    title: string;
    budget_usd: number;
    timeout_minutes: number;
    hidden_test_files: number;
  }>;
  task_cap_usd: number;
  total_cap_usd: number;
  worst_case_usd: number;
  over_total_cap: string[];
}

export function planFactoryBench(
  tasks: FactoryBenchTask[],
  caps: { taskCapUsd?: number; totalCapUsd?: number } = {},
): FactoryBenchPlan {
  const total = caps.totalCapUsd ?? DEFAULT_TOTAL_CAP_USD;
  let running = 0;
  const over: string[] = [];
  for (const task of tasks) {
    if (running + task.budget_usd > total + 1e-9) over.push(task.id);
    else running += task.budget_usd;
  }
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      source: t.source,
      repository: t.repository,
      base_ref: t.base_ref,
      title: t.title,
      budget_usd: t.budget_usd,
      timeout_minutes: t.timeout_minutes,
      hidden_test_files: t.hidden_tests.files.length,
    })),
    task_cap_usd: caps.taskCapUsd ?? DEFAULT_TASK_CAP_USD,
    total_cap_usd: total,
    worst_case_usd: round(tasks.reduce((s, t) => s + t.budget_usd, 0)),
    over_total_cap: over,
  };
}

export function formatFactoryPlan(plan: FactoryBenchPlan): string {
  return [
    `${plan.tasks.length} task(s); nothing submitted (--dry-run):`,
    ...plan.tasks.map(
      (t) =>
        `  ${t.id.padEnd(36)} ${t.source.padEnd(9)} $${t.budget_usd.toFixed(2)}  ${String(t.timeout_minutes).padStart(3)}m  ${t.repository}@${t.base_ref.slice(0, 12)}`,
    ),
    "",
    `caps: $${plan.task_cap_usd} per task, $${plan.total_cap_usd} per bench run; worst case $${plan.worst_case_usd.toFixed(2)}`,
    ...(plan.over_total_cap.length
      ? [`would not be submitted if every earlier task spent its whole budget: ${plan.over_total_cap.join(", ")}`]
      : []),
  ].join("\n");
}

const pct = (value: number, denominator: number, what: string): string =>
  denominator === 0 ? `n/a  (no ${what})` : `${(value * 100).toFixed(1)}%`;
const usd = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(4)}`);

export function formatFactoryReport(report: BenchFactoryReport): string {
  const rows = report.tasks.map((t) =>
    t.excluded
      ? `  excl ${t.id.padEnd(36)} ${t.excluded}`
      : `  ${t.verdict === "pass" && t.hidden_tests === "pass" ? "ok  " : t.verdict === "pass" ? "FA  " : t.hidden_tests === "pass" ? "FR  " : "fail"} ${t.id.padEnd(36)} verdict ${t.verdict ?? "—"}, hidden ${t.hidden_tests}, ${t.repair_turns} repair(s), ${usd(t.cost_usd)}${t.cost_lower_bound ? "+" : ""}, ${t.wall_seconds ?? "—"}s${t.pr_url ? `, ${t.pr_url}` : ""}`,
  );
  const c = report.counts;
  return [
    ...rows,
    "",
    `success rate:              ${pct(report.success_rate, report.attempted, "tasks scored")}  (${report.successes}/${report.attempted}: verifier pass and hidden tests pass)`,
    `verified false accepts:    ${pct(report.verified_false_accept_rate, c.accepted, "verifier passes")}  (${c.false_accepts}/${c.accepted}: verifier pass, hidden tests fail)`,
    `verified false rejects:    ${pct(report.verified_false_reject_rate, c.rejected, "verifier rejections")}  (${c.false_rejects}/${c.rejected}: not passed, hidden tests pass)`,
    `repair conversion:         ${pct(report.repair_conversion_rate, c.failed_first, "runs that failed first")}  (${c.converted}/${c.failed_first}: first verification failed, later passed)`,
    `cost per task:             mean ${usd(report.cost_per_task_usd.mean)}, p50 ${usd(report.cost_per_task_usd.p50)}, p90 ${usd(report.cost_per_task_usd.p90)}`,
    `cost per success:          ${usd(report.cost_per_success_usd)}`,
    `wall time per task:        mean ${report.wall_seconds_per_task.mean ?? "—"}s, p50 ${report.wall_seconds_per_task.p50 ?? "—"}s, p90 ${report.wall_seconds_per_task.p90 ?? "—"}s`,
    `total spent:               ${usd(report.total_cost_usd)} (excluded tasks included)`,
    ...(report.excluded.length
      ? ["", `${report.excluded.length} task(s) excluded from every score:`, ...report.excluded.map((e) => `  ${e.id}: ${e.reason}`)]
      : []),
  ].join("\n");
}
