import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { S3EvidenceStorage, type EvidenceStorage } from "../factory/evidence-storage.js";
import { githubClientFromEnv } from "../github/rest.js";
import type { GitHubClient, RepositoryRef } from "../github/client.js";
import { VercelSandboxProvider } from "../sandbox/vercel.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import type { DoctorEnvironment } from "./doctor.js";
import type { WorkerConfig } from "../factory/worker-config.js";

function migrationsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

export async function doctorTempPackage(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "windkeel-doctor-"));
  writeFileSync(
    join(dir, "probe.txt"),
    "Written by `windkeel doctor` to confirm this bucket accepts a write and serves it back. " +
      "It is deleted immediately; if you are reading it in a bucket, the delete failed.\n",
  );
  return dir;
}

function doctorSandboxProvider(env: NodeJS.ProcessEnv): SandboxProvider | null {
  const token = env["VERCEL_TOKEN"];
  const teamId = env["VERCEL_TEAM_ID"];
  const projectId = env["VERCEL_PROJECT_ID"];
  if (!token || !teamId || !projectId) return null;
  return new VercelSandboxProvider({
    token,
    teamId,
    projectId,
    makerModelApiDomain: env["WINDKEEL_MODEL_API_DOMAIN"] ?? "api.openai.com",
    makerModelKeyEnvVar: env["WINDKEEL_MODEL_KEY_ENV_VAR"] ?? "OPENAI_API_KEY",
  });
}

export function defaultDoctorEnvironment(
  overrides: Partial<DoctorEnvironment> = {},
): DoctorEnvironment {
  return {
    env: process.env,
    migrationsDir: migrationsDirectory(),
    async connect(connectionString: string): Promise<Pool> {
      return new Pool({ connectionString, max: 1 });
    },
    storage(config: NonNullable<WorkerConfig["evidence"]>): EvidenceStorage {
      return new S3EvidenceStorage({
        endpoint: config.endpoint,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
    },
    github(env: NodeJS.ProcessEnv): GitHubClient {
      return githubClientFromEnv(env);
    },
    sandboxes: doctorSandboxProvider,
    fetch,
    ...overrides,
  };
}

export type { RepositoryRef };
