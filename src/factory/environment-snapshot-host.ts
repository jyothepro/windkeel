import { Pool } from "pg";
import { SandboxGitCredentials } from "../sandbox/git-credentials.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import { githubClientFromEnv } from "../github/rest.js";
import {
  buildEnvironmentSnapshot,
  DEFAULT_SNAPSHOT_TTL_DAYS,
  secretsFromTable,
  type BuildDeps,
} from "./environment-snapshots.js";
import { buildSandboxProvider, type Log } from "./stage-wiring.js";
import { loadWorkerConfig, secretPrivateKeys, type WorkerConfig } from "./worker-config.js";
import { defaultLog } from "./log.js";

function snapshotBuildDeps(pool: Pool, config: WorkerConfig, log?: Log): BuildDeps {
  const github = process.env["GITHUB_APP_ID"] ? githubClientFromEnv() : null;
  return {
    secrets: secretsFromTable(pool, secretPrivateKeys(config)),
    ...(github ? { gitCredentials: { broker: new SandboxGitCredentials(github), host: config.gitHost } } : {}),
    ttlDays: config.environmentSnapshots?.ttlDays ?? DEFAULT_SNAPSHOT_TTL_DAYS,
    ...(log ? { log } : {}),
  };
}

let stagePool: Pool | undefined;

export async function buildEnvironmentSnapshotFromEnvironment(
  organizationId: string,
  repositoryId: string,
): Promise<{ status: string }> {
  const config = loadWorkerConfig();
  if (!config.environmentSnapshots?.enabled) return { status: "disabled" };
  if (!stagePool) {
    stagePool = new Pool({
      connectionString: config.poolDatabaseUrl ?? config.databaseUrl,
      max: 2,
      idleTimeoutMillis: 5_000,
    });
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(stagePool);
  }
  const { provider } = buildSandboxProvider(config, defaultLog) as { provider: SandboxProvider };
  const outcome = await buildEnvironmentSnapshot(stagePool, provider, snapshotBuildDeps(stagePool, config, defaultLog), {
    organizationId,
    repositoryId,
  });
  return { status: outcome.status };
}
