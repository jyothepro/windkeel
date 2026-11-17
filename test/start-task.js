/**
 * Creates a task and its run and hands the run to the Vercel Workflow provider — the e2e tests'
 * way in.
 *
 * This was `windkeel-admin task create` until ADR-0023 §10 moved task creation onto the API
 * (`POST /v1/tasks`). A run is addressed to the producer's own deployment, so the command only
 * ever worked from inside one — which is exactly what these tests are, with the local World
 * standing in for the deployment. The tests kept needing it after the command had no reason to
 * exist, so it lives here now.
 */

import { Pool } from "pg";
import { createTaskAndRun } from "../dist/billing/admitted-runs.js";
import { runRails } from "../dist/factory/rails.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";

export async function createAndStartTask(input) {
  const rails = runRails({});
  const pool = new Pool({ connectionString: input.databaseUrl });
  let created;
  try {
    created = await createTaskAndRun(pool, {
      repositoryId: input.repositoryId,
      sourceType: "local",
      sourceReference: "test",
      title: input.title,
      description: input.description,
      criteria: input.criteria,
      riskLevel: input.riskLevel,
      ...(input.playbook ? { playbook: input.playbook } : {}),
      rails: {
        spendCapUsd: rails.spend_cap_usd,
        wallClockCapSeconds: rails.wall_clock_cap_seconds,
        uncappedConfirmed: true,
      },
    });
  } finally {
    await pool.end();
  }

  const provider = new VercelWorkflowProvider({ connectionString: input.databaseUrl });
  await provider.start();
  try {
    const started = await provider.startRun(created.run.id);
    return {
      taskId: created.task.id,
      engineeringRunId: created.run.id,
      enqueued: started.enqueued,
      backing: input.backing ?? "vercel-workflow",
    };
  } finally {
    await provider.stop();
  }
}
