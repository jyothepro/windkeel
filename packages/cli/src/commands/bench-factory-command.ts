import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_TASK_CAP_USD,
  DEFAULT_TOTAL_CAP_USD,
  TaskValidationError,
  apiBenchClient,
  formatFactoryPlan,
  formatFactoryReport,
  loadTasks,
  planFactoryBench,
  runFactoryBench,
  type FactoryBenchTask,
} from "./bench-factory.js";
import { checkHiddenTests, runHiddenTests } from "./bench-factory-hidden.js";

export class BenchFactoryCommandError extends Error {}

export interface BenchFactoryFlags {
  tasksDir: string;
  json: boolean;
  dryRun: boolean;
  checkHidden?: boolean;
  out: string | undefined;
  only: string | undefined;
  concurrency: string | undefined;
  taskCapUsd: string | undefined;
  totalCapUsd: string | undefined;
  pollMs: string | undefined;
}

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new BenchFactoryCommandError(`--${name} must be a positive number (got ${raw})`);
  return value;
}

export async function benchFactoryCommand(
  flags: BenchFactoryFlags,
  io: { out: (text: string) => void; err: (text: string) => void; env: NodeJS.ProcessEnv } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
  },
): Promise<number> {
  const taskCapUsd = positive("task-cap-usd", flags.taskCapUsd, DEFAULT_TASK_CAP_USD);
  const totalCapUsd = positive("total-cap-usd", flags.totalCapUsd, DEFAULT_TOTAL_CAP_USD);
  const concurrency = Math.floor(positive("concurrency", flags.concurrency, 1));
  const pollMs = positive("poll", flags.pollMs, 10_000);

  let tasks: FactoryBenchTask[];
  try {
    tasks = loadTasks(flags.tasksDir, { taskCapUsd });
  } catch (error) {
    if (error instanceof TaskValidationError) throw new BenchFactoryCommandError(error.message);
    throw error;
  }
  if (flags.only) {
    const wanted = new Set(flags.only.split(",").map((s) => s.trim()).filter(Boolean));
    const unknown = [...wanted].filter((id) => !tasks.some((t) => t.id === id));
    if (unknown.length) throw new BenchFactoryCommandError(`--only names unknown task(s): ${unknown.join(", ")}`);
    tasks = tasks.filter((t) => wanted.has(t.id));
  }
  if (!tasks.length) throw new BenchFactoryCommandError(`no tasks in ${flags.tasksDir}`);

  if (flags.checkHidden) {
    const results = [];
    for (const task of tasks) {
      const result = await checkHiddenTests(task);
      results.push(result);
      if (!flags.json) io.out(`  ${result.ok ? "ok  " : "BAD "} ${task.id.padEnd(36)} ${result.ok ? "fails on base, passes on the reference" : result.problem}\n`);
    }
    if (flags.json) io.out(`${JSON.stringify({ check_hidden: results }, null, 2)}\n`);
    return results.every((r) => r.ok) ? 0 : 1;
  }

  const plan = planFactoryBench(tasks, { taskCapUsd, totalCapUsd });
  if (flags.dryRun) {
    io.out(flags.json ? `${JSON.stringify({ dry_run: true, ...plan }, null, 2)}\n` : `${formatFactoryPlan(plan)}\n`);
    return 0;
  }

  if (!io.env["WINDKEEL_API_URL"]) {
    throw new BenchFactoryCommandError(
      "bench-factory submits real tasks and spends real money: set WINDKEEL_API_URL (and WINDKEEL_API_TOKEN) " +
        "to the deployment, or pass --dry-run",
    );
  }
  const { WindkeelApi } = await import("../client/api.js");
  const api = WindkeelApi.fromEnv(io.env);
  const outDir = flags.out ? resolve(flags.out) : undefined;
  if (outDir) mkdirSync(outDir, { recursive: true });

  const preExcluded = new Map<string, string>();
  for (const task of tasks) {
    const check = await checkHiddenTests(task);
    if (!check.ok) {
      preExcluded.set(task.id, `unchecked_hidden_tests: ${check.problem ?? "--check-hidden did not pass"}`);
      io.err(`bench-factory: ${task.id}: excluded, its hidden tests did not check out: ${check.problem}\n`);
    }
  }

  const report = await runFactoryBench(
    tasks,
    {
      client: apiBenchClient(api),
      runHiddenTests: async (task, head) => {
        const result = await runHiddenTests(task, head);
        if (outDir) writeFileSync(join(outDir, `${task.id}.hidden.json`), `${JSON.stringify(result, null, 2)}\n`);
        return result;
      },
      log: (line) => io.err(`bench-factory: ${line}\n`),
    },
    { totalCapUsd, concurrency, pollMs, preExcluded },
  );
  const recorded = {
    generated_at: new Date().toISOString(),
    deployment: api.baseUrl,
    caps: { task_usd: taskCapUsd, total_usd: totalCapUsd },
    ...report,
  };
  if (outDir) writeFileSync(join(outDir, "report.json"), `${JSON.stringify(recorded, null, 2)}\n`);
  io.out(flags.json ? `${JSON.stringify(recorded, null, 2)}\n` : `${formatFactoryReport(report)}\n`);
  return 0;
}
