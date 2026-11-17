import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { withTransaction } from "./db/transaction.js";

export interface MigrationFile {
  filename: string;
  sql: string;
}

export function loadMigrations(migrationsDir: string): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => ({
      filename,
      sql: readFileSync(join(migrationsDir, filename), "utf8"),
    }));
}

export function pendingMigrations(all: MigrationFile[], applied: string[]): MigrationFile[] {
  const appliedSet = new Set(applied);
  return all.filter((m) => !appliedSet.has(m.filename));
}

const SCHEMA_MIGRATIONS_TABLE = `
  create table if not exists schema_migrations (
    filename    text primary key,
    applied_at  timestamptz not null default now()
  )
`;

const MIGRATION_LOCK_KEY = 0x6f7271_6f6e;

export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(SCHEMA_MIGRATIONS_TABLE);
      const { rows } = await client.query<{ filename: string }>(
        "select filename from schema_migrations",
      );
      const pending = pendingMigrations(loadMigrations(migrationsDir), rows.map((r) => r.filename));

      const applied: string[] = [];
      for (const migration of pending) {
        try {
          await withTransaction(client, async (tx) => {
            await tx.query(migration.sql);
            await tx.query("insert into schema_migrations (filename) values ($1)", [
              migration.filename,
            ]);
          });
          applied.push(migration.filename);
        } catch (err) {
          throw new Error(`migration ${migration.filename} failed: ${(err as Error).message}`, {
            cause: err,
          });
        }
      }
      return { applied };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
