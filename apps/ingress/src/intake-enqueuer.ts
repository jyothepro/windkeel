import { runEnqueuer, type RunEnqueuer } from "./windkeel-actions.js";

export function intakeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env["DATABASE_POOL_URL"]?.trim() || env["DATABASE_URL"]?.trim();
  if (!url) throw new Error("DATABASE_POOL_URL (or DATABASE_URL) is not set");
  return url;
}

let enqueuer: RunEnqueuer | null = null;

export function intakeStartRun(engineeringRunId: string): Promise<{ enqueued: boolean }> {
  enqueuer ??= runEnqueuer({ connectionString: intakeDatabaseUrl() });
  return enqueuer.startRun(engineeringRunId);
}
