import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { migrationFilenames, readSchemaStatus } from "./schema-guard.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const dryRun = process.argv.slice(2).includes("--dry-run");
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const pool = new Pool({ connectionString });

try {
  if (dryRun) {
    const status = await readSchemaStatus(pool, migrationFilenames(migrationsDir));
    if (status.state === "current") {
      console.log(`dry run: schema is up to date (${status.bundled} migration(s))`);
    } else if (status.state === "behind") {
      console.log(`dry run: ${status.pending.length} migration(s) pending, none applied:`);
      for (const filename of status.pending) console.log(`pending ${filename}`);
    } else {
      console.error(`dry run: could not compare the schema: ${status.reason}`);
      process.exitCode = 1;
    }
  } else {
    const { applied } = await runMigrations(pool, migrationsDir);
    if (applied.length === 0) {
      console.log("schema is up to date");
    } else {
      for (const filename of applied) console.log(`applied ${filename}`);
    }
  }
} finally {
  await pool.end();
}
