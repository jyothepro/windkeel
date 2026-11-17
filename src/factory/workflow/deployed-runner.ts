import { attachDatabasePool } from "@vercel/functions";
import { loadWorkerConfig } from "../worker-config.js";
import { buildStageDeps, registerStageHandlers, type Log } from "../stage-wiring.js";
import { VercelWorkflowProvider } from "./vercel.js";
import { registerDeploymentNotifiers } from "./deployment-notifiers.js";
import { registerBatchNotifier } from "../../batches/notifier.js";
import { STAGE_RUNNER_KEY, type StageRunner } from "./vercel-flow.js";

const DEPLOYED_POOL_MAX = 2;

export const deployedLog: Log = (message, fields) => {
  try {
    process.stdout.write(
      `${JSON.stringify({ at: new Date().toISOString(), src: "windkeel", message, ...fields })}\n`,
    );
  } catch {
    try {
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), src: "windkeel", message })}\n`);
    } catch {
    }
  }
};

let building: Promise<StageRunner> | null = null;

function published(): StageRunner | undefined {
  return (globalThis as Record<symbol, unknown>)[STAGE_RUNNER_KEY] as StageRunner | undefined;
}

async function buildAndPublish(): Promise<StageRunner> {
  const config = loadWorkerConfig();
  const { deps } = buildStageDeps(config, { poolMax: DEPLOYED_POOL_MAX, log: deployedLog });
  attachDatabasePool(deps.pool);
  const provider = new VercelWorkflowProvider({
    connectionString: config.poolDatabaseUrl ?? config.databaseUrl,
    poolMax: DEPLOYED_POOL_MAX,
    onPool: attachDatabasePool,
    log: deployedLog,
  });
  registerStageHandlers(provider, deps);
  registerDeploymentNotifiers({
    pool: deps.pool,
    env: process.env,
    log: deployedLog,
    ...(deps.github ? { github: deps.github } : {}),
  });
  registerBatchNotifier(deps.pool, (runId) => provider.startRun(runId), deployedLog);
  await provider.start();
  const runner = published();
  if (!runner) {
    throw new Error(
      "windkeel: VercelWorkflowProvider.start() did not publish a stage runner. The deployed " +
        "step host has no other way to reach the handlers; see deployed-runner.ts.",
    );
  }
  return runner;
}

export async function stageRunnerFromEnvironment(): Promise<StageRunner> {
  const existing = published();
  if (existing) return existing;
  building ??= buildAndPublish().catch((err) => {
    building = null;
    throw err;
  });
  return await building;
}
