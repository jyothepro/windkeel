
import type { Pool, PoolClient } from "pg";
import { advisoryUnlock, selectBackendPid, tryAdvisoryLock } from "../stores/doctor-store.js";
import { migrationFilenames, readSchemaStatus } from "../../factory/schema-guard.js";
import {
  backingCensus,
  resolveWorkflowBacking,
  WORKFLOW_BACKING_ENV,
} from "../../factory/workflow/backing.js";
import { type WorkerConfig } from "../../factory/worker-config.js";
import { type CheckResult, type DoctorEnvironment, fail, message, pass } from "./report.js";

export const POSTGRES_CHECK = { id: "postgres", title: "Postgres" };
export const MIGRATIONS_CHECK = { id: "migrations", title: "Migrations (#337)" };
export const BACKING_CHECK = { id: "workflow-backing", title: "Workflow backing" };

export async function checkWorkflowBacking(
  env: Record<string, string | undefined>,
  pool: Pool,
): Promise<CheckResult> {
  let resolved: { backing: string; explicit: boolean };
  try {
    resolved = resolveWorkflowBacking(env);
  } catch (error) {
    return fail(BACKING_CHECK.id, BACKING_CHECK.title, "the selection is not a known backing", [
      message(error),
      "A typo that fell back to the default would be indistinguishable from a deliberate " +
        "choice, so this refuses rather than guessing.",
    ]);
  }

  const details = [
    resolved.explicit
      ? `${WORKFLOW_BACKING_ENV} is set explicitly.`
      : `${WORKFLOW_BACKING_ENV} is unset, so the default applies. Set it to switch, and set it ` +
        "to the same value on every producer — the webhook ingress and the CLI both read it.",
  ];

  let census: Record<string, number> = {};
  try {
    census = await backingCensus(pool);
  } catch {
    details.push(
      "Could not read workflow_run_binding, so in-flight runs were not checked. If the " +
        "migrations are up to date this is worth investigating.",
    );
    return pass(BACKING_CHECK.id, BACKING_CHECK.title, `runs go to ${resolved.backing}`, details);
  }

  const strays = Object.entries(census).filter(([provider]) => provider !== resolved.backing);
  if (strays.length === 0) {
    const mine = census[resolved.backing] ?? 0;
    details.push(`${mine} run(s) currently in flight on ${resolved.backing}.`);
    return pass(BACKING_CHECK.id, BACKING_CHECK.title, `runs go to ${resolved.backing}`, details);
  }

  return fail(
    BACKING_CHECK.id,
    BACKING_CHECK.title,
    `runs are in flight on a backing this deployment no longer selects`,
    [
      ...details,
      ...strays.map(
        ([provider, n]) =>
          `${n} run(s) are bound to "${provider}", which nothing here will pick up. They will ` +
          "sit where they are until that backing runs again, or until they are cancelled.",
      ),
      "Switching back is safe and is the point of the selection being configuration: set " +
        `${WORKFLOW_BACKING_ENV}=${strays[0]?.[0]} and let them drain.`,
    ],
  );
}

export async function detectPooler(
  client: PoolClient,
  connectionString: string,
): Promise<string[]> {
  const findings: string[] = [];

  const first = await selectBackendPid(client);
  const second = await selectBackendPid(client);
  if (first.rows[0]?.pid !== second.rows[0]?.pid) {
    findings.push(
      "two consecutive statements on one client ran on different backends — this is a " +
        "transaction pooler, not a session-mode connection (ADR-0008 §1)",
    );
  }

  const key = 0x0_71_9f_02;
  const locked = await tryAdvisoryLock(client, key);
  if (locked.rows[0]?.locked !== true) {
    findings.push("a session advisory lock could not be taken — the connection is not exclusive");
  } else {
    const unlocked = await advisoryUnlock(client, key);
    if (unlocked.rows[0]?.unlocked !== true) {
      findings.push(
        "a session advisory lock did not survive to its own unlock — session state is not " +
          "preserved between statements, which pg-boss and the ADR-0015 retention sweep both need",
      );
    }
  }

  try {
    const url = new URL(connectionString);
    if (url.port === "6543") {
      findings.push(
        "the connection URL is the transaction pooler (port 6543), which ADR-0008 §1 reserves " +
          "for the ingress — it drops session state and silently ignores " +
          "`options=-csearch_path`. The worker needs session mode (5432). This is a hint from " +
          "the URL; the functional signals above are what decide.",
      );
    }
  } catch {

  }

  return findings;
}

export function sessionPoolerNote(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    if (url.port === "5432" && /pooler|pgbouncer|supavisor/i.test(url.hostname)) {
      return (
        "this is Supavisor session mode (port 5432 on a pooler host), not the transaction " +
        "pooler — session state and advisory locks are preserved, and both were verified above. " +
        "ADR-0008 §1 is satisfied; the direct host is IPv6-only, so this is the supported route " +
        "for a deployment without IPv4."
      );
    }
  } catch {

  }
  return null;
}

export async function checkPostgres(
  environment: DoctorEnvironment,
  config: WorkerConfig,
): Promise<CheckResult> {
  const pool = await environment.connect(config.databaseUrl);
  try {
    const client = await pool.connect();
    let findings: string[];
    try {
      findings = await detectPooler(client, config.databaseUrl);
    } finally {
      client.release();
    }

    if (findings.length > 0) {
      return fail(POSTGRES_CHECK.id, POSTGRES_CHECK.title, "connected, with problems", findings);
    }
    const note = sessionPoolerNote(config.databaseUrl);
    return pass(
      POSTGRES_CHECK.id,
      POSTGRES_CHECK.title,
      "session-mode connection",
      note ? [note] : [],
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function checkMigrations(
  environment: DoctorEnvironment,
  config: WorkerConfig,
): Promise<CheckResult> {
  const pool = await environment.connect(config.databaseUrl);
  try {
    const status = await readSchemaStatus(pool, migrationFilenames(environment.migrationsDir));
    switch (status.state) {
      case "current":
        return pass(
          MIGRATIONS_CHECK.id,
          MIGRATIONS_CHECK.title,
          `all ${status.bundled} migration(s) applied`,
        );
      case "behind":
        return fail(
          MIGRATIONS_CHECK.id,
          MIGRATIONS_CHECK.title,
          `${status.pending.length} migration(s) not applied: ${status.pending.join(", ")}`,
          [
            ...status.pending.map((filename) => `pending: ${filename}`),
            "Run `npm run db:migrate` against this database. A deployment serving this database " +
              "answers /v1/health with 503 and refuses requests with `schema_behind` until then.",
          ],
        );
      case "unverifiable":
        return fail(MIGRATIONS_CHECK.id, MIGRATIONS_CHECK.title, "no migrations to compare", [
          `${environment.migrationsDir} has no *.sql files. Run doctor from a checkout.`,
        ]);
      case "unknown":
        return fail(MIGRATIONS_CHECK.id, MIGRATIONS_CHECK.title, "schema_migrations could not be read", [
          status.reason,
        ]);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}
