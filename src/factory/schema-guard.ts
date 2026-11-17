import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectAppliedMigrations } from "./stores/schema-migrations-store.js";

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: R[] }>;
}

export type SchemaStatus =
  | { state: "current"; bundled: number }
  | { state: "behind"; pending: string[] }
  | { state: "unverifiable"; reason: string }
  | { state: "unknown"; reason: string };

export function pendingMigrationNames(
  bundled: readonly string[],
  applied: readonly string[],
): string[] {
  const appliedSet = new Set(applied);
  return [...bundled].sort().filter((name) => !appliedSet.has(name));
}

export function migrationFilenames(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function bundledMigrationFilenames(
  candidates: readonly URL[] = [
    new URL("./migrations/", import.meta.url),
    new URL("../../migrations/", import.meta.url),
  ],
): string[] | null {
  for (const candidate of candidates) {
    const found = migrationFilenames(fileURLToPath(candidate));
    if (found && found.length > 0) return found;
  }
  return null;
}

const UNDEFINED_TABLE = "42P01";

export async function readSchemaStatus(
  db: Queryable,
  bundled: readonly string[] | null,
): Promise<SchemaStatus> {
  if (!bundled || bundled.length === 0) {
    return {
      state: "unverifiable",
      reason: "no migrations are bundled with this deployment, so its schema cannot be compared",
    };
  }
  let applied: string[];
  try {
    applied = await selectAppliedMigrations(db);
  } catch (error) {
    if ((error as { code?: unknown }).code === UNDEFINED_TABLE) {
      applied = [];
    } else {
      return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const pending = pendingMigrationNames(bundled, applied);
  return pending.length === 0
    ? { state: "current", bundled: bundled.length }
    : { state: "behind", pending };
}

export interface SchemaBehindBody {
  ok: false;
  error: string;
  code: "schema_behind";
  pending: string[];
}

export function schemaBehindBody(pending: readonly string[]): SchemaBehindBody {
  return {
    ok: false,
    error:
      `this deployment's database is missing ${pending.length} migration(s); ` +
      "run `npm run db:migrate` against it (docs/running-the-factory.md)",
    code: "schema_behind",
    pending: [...pending],
  };
}

export interface SchemaGuardOptions {
  bundled?: readonly string[] | null;
  recheckMs?: number;
  now?: () => number;
}

export interface SchemaGuard {
  status(db: Queryable): Promise<SchemaStatus>;
  refusal(db: Queryable): Promise<SchemaBehindBody | null>;
}

const DEFAULT_RECHECK_MS = 15_000;

export function schemaGuard(options: SchemaGuardOptions = {}): SchemaGuard {
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  const now = options.now ?? Date.now;
  let bundled: readonly string[] | null | undefined = options.bundled;
  let cached: { status: SchemaStatus; at: number } | null = null;
  let inFlight: Promise<SchemaStatus> | null = null;

  const fresh = (): boolean => {
    if (!cached) return false;
    if (cached.status.state === "current" || cached.status.state === "unverifiable") return true;
    if (cached.status.state === "behind") return now() - cached.at < recheckMs;
    return false;
  };

  const guard: SchemaGuard = {
    async status(db) {
      if (fresh()) return cached!.status;
      inFlight ??= (async () => {
        try {
          if (bundled === undefined) bundled = bundledMigrationFilenames();
          const status = await readSchemaStatus(db, bundled);
          cached = status.state === "unknown" ? null : { status, at: now() };
          return status;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    async refusal(db) {
      const status = await guard.status(db);
      return status.state === "behind" ? schemaBehindBody(status.pending) : null;
    },
  };
  return guard;
}
