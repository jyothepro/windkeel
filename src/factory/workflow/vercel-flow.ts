import { sleep } from "workflow";

export const STAGE_RUNNER_KEY = Symbol.for("windkeel.workflow.stage-runner");

export type TickResult =
  | { kind: "continue" }
  | { kind: "wait" }
  | { kind: "poll"; afterMs: number }
  | { kind: "retry" }
  | { kind: "finished"; state: string };

export interface StageRunner {
  tick(engineeringRunId: string, attempt: number, executionToken?: string): Promise<TickResult>;
  exhausted(engineeringRunId: string, executionToken?: string): Promise<void>;
}

const DEFAULT_MAX_TICKS = 2000;

async function tick(
  engineeringRunId: string,
  attempt: number,
  executionToken?: string,
): Promise<TickResult> {
  "use step";
  const runner = (globalThis as Record<symbol, unknown>)[STAGE_RUNNER_KEY] as
    | StageRunner
    | undefined;
  if (runner) return await runner.tick(engineeringRunId, attempt, executionToken);
  const deployed = await import("./deployed-runner.js");
  return await (await deployed.stageRunnerFromEnvironment()).tick(engineeringRunId, attempt, executionToken);
}

async function exhausted(engineeringRunId: string, executionToken?: string): Promise<void> {
  "use step";
  const runner = (globalThis as Record<symbol, unknown>)[STAGE_RUNNER_KEY] as
    | StageRunner
    | undefined;
  if (runner) return await runner.exhausted(engineeringRunId, executionToken);
  const deployed = await import("./deployed-runner.js");
  return await (await deployed.stageRunnerFromEnvironment()).exhausted(engineeringRunId, executionToken);
}

export async function orqonRunFlow(
  engineeringRunId: string,
  options: { waitSleepMs: number; retrySleepMs: number; maxTicks?: number; executionToken?: string },
): Promise<{ state: string | null; ticks: number }> {
  "use workflow";
  const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
  let attempt = 1;
  for (let ticks = 1; ticks <= maxTicks; ticks++) {
    const result = await tick(engineeringRunId, attempt, options.executionToken);
    if (result.kind === "finished") return { state: result.state, ticks };
    if (result.kind === "retry") {
      attempt += 1;
      await sleep(options.retrySleepMs);
      continue;
    }
    attempt = 1;
    if (result.kind === "poll") await sleep(result.afterMs);
    else if (result.kind === "wait") await sleep(options.waitSleepMs);
  }
  await exhausted(engineeringRunId, options.executionToken);
  return { state: null, ticks: maxTicks };
}
