import type { Pool, PoolClient } from "pg";

export async function pingDatabase(db: Pool | PoolClient): Promise<void> {
  await db.query("select 1");
}
