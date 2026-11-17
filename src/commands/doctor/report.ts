
import type { Pool } from "pg";
import type {
  GitHubClient,
  InstallationPermissions,
  RepositoryRef,
} from "../../github/client.js";
import type { SandboxProvider } from "../../sandbox/provider.js";
import type { EvidenceStorage } from "../../factory/evidence-storage.js";
import { type WorkerConfig } from "../../factory/worker-config.js";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;

  readonly summary: string;

  readonly details: readonly string[];
}

export interface DoctorReport {
  readonly results: readonly CheckResult[];

  readonly ok: boolean;
}

export const ADR_0009_PERMISSIONS: Required<InstallationPermissions> = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "write",
};

export const MAKER_PERMISSIONS: InstallationPermissions = { contents: "write" };
export const VERIFIER_PERMISSIONS: InstallationPermissions = { contents: "read" };

export interface DoctorEnvironment {
  env: NodeJS.ProcessEnv;

  migrationsDir: string;
  connect(connectionString: string): Promise<Pool>;
  storage(config: NonNullable<WorkerConfig["evidence"]>): EvidenceStorage;
  github(env: NodeJS.ProcessEnv): GitHubClient;

  sandboxes(env: NodeJS.ProcessEnv): SandboxProvider | null;
  fetch: typeof fetch;

  repository?: RepositoryRef;
}

export class SecretRegistry {
  private readonly values = new Set<string>();

  add(...values: Array<string | undefined | null>): void {
    for (const value of values) {

      if (typeof value === "string" && value.trim().length >= 8) this.values.add(value.trim());
    }
  }

  addConnectionString(url: string | undefined): void {
    this.add(url);
    if (!url) return;
    try {
      const parsed = new URL(url);
      this.add(parsed.password, parsed.username);
    } catch {

    }
  }

  redact(text: string): string {
    let out = text;

    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join("[redacted]");
    }
    return out;
  }

  get size(): number {
    return this.values.size;
  }
}

export const SECRET_VARIABLES = [
  "DATABASE_URL",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "VERCEL_TOKEN",
  "SANDBOX_GIT_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WINDKEEL_SENTRY_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

export function pass(id: string, title: string, summary: string, details: string[] = []): CheckResult {
  return { id, title, status: "pass", summary, details };
}
export function fail(id: string, title: string, summary: string, details: string[] = []): CheckResult {
  return { id, title, status: "fail", summary, details };
}
export function skip(id: string, title: string, summary: string, details: string[] = []): CheckResult {
  return { id, title, status: "skip", summary, details };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
