import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import { repoRoot, TEST_POOL } from "./helpers.js";

const TEMPLATE_SCHEMA = "windkeel_template";
const TEMPLATE_LOCK_KEY = 0x6f7271_7470;
const migrationsDir = join(repoRoot, "migrations");

function databaseUrl(name) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function migrationsHash() {
  const hash = createHash("sha256");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    hash.update(file).update("\0").update(readFileSync(join(migrationsDir, file))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

const templateName = `windkeel_tpl_${migrationsHash()}`;
let templateReady = null;

async function databaseExists(admin, name) {
  const { rows } = await admin.query("select 1 from pg_database where datname = $1", [name]);
  return rows.length > 0;
}

async function buildTemplate() {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, idleTimeoutMillis: 1_000 });
  const client = await admin.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    try {
      if (await databaseExists(client, templateName)) return;
      const building = `${templateName}_building`;
      await client.query(`drop database if exists ${building} with (force)`);
      await client.query(`create database ${building}`);
      const pool = new Pool({ connectionString: databaseUrl(building), ...TEST_POOL, options: `-c search_path=${TEMPLATE_SCHEMA}` });
      try {
        await pool.query(`create schema ${TEMPLATE_SCHEMA}`);
        await runMigrations(pool, migrationsDir);
      } finally {
        await pool.end();
      }
      await client.query(`alter database ${building} rename to ${templateName}`);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
    }
  } finally {
    client.release();
    await admin.end();
  }
}

const CLONE_MARK = "windkeel-test-clone pid=";
let orphansSwept = null;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function sweepOrphans() {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, idleTimeoutMillis: 1_000 });
  admin.on("error", () => {});
  try {
    const { rows } = await admin.query(
      "select datname, shobj_description(oid, 'pg_database') as mark from pg_database where shobj_description(oid, 'pg_database') like $1",
      [`${CLONE_MARK}%`],
    );
    for (const { datname, mark } of rows) {
      const pid = Number(mark.slice(CLONE_MARK.length));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)) {
        await admin.query(`drop database if exists ${datname} with (force)`).catch(() => {});
      }
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

export function migratedDatabaseUrl(schema) {
  return databaseUrl(schema.toLowerCase());
}

export async function createMigratedDatabase(schema) {
  const name = schema.toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || Buffer.byteLength(name) > 63) {
    throw new Error(`${schema} is not usable as a database name`);
  }
  orphansSwept ??= sweepOrphans().catch(() => {});
  templateReady ??= buildTemplate();
  await Promise.all([orphansSwept, templateReady]);
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ...TEST_POOL });
  try {
    await admin.query(`create database ${name} template ${templateName}`);
    await admin.query(`comment on database ${name} is '${CLONE_MARK}${process.pid}'`);
  } finally {
    await admin.end();
  }
  const db = new Pool({ connectionString: databaseUrl(name), ...TEST_POOL });
  try {
    await db.query(`alter schema ${TEMPLATE_SCHEMA} rename to ${name}`);
  } finally {
    await db.end();
  }
  return databaseUrl(name);
}

const DROP_RETRY_MS = 25;
const DROP_PATIENCE_MS = 15_000;

async function dropWhenIdle(name) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, idleTimeoutMillis: 1_000 });
  admin.on("error", () => {});
  try {
    const deadline = Date.now() + DROP_PATIENCE_MS;
    for (;;) {
      try {
        await admin.query(`drop database if exists ${name}`);
        return;
      } catch (err) {
        if (err?.code !== "55006" || Date.now() > deadline) break;
      }
      await new Promise((resolve) => setTimeout(resolve, DROP_RETRY_MS));
    }
    await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
  } finally {
    await admin.end().catch(() => {});
  }
}

export async function dropMigratedDatabase(schema) {
  void dropWhenIdle(schema.toLowerCase());
}
