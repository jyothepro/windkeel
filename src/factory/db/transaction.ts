
import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

function isPool(db: Queryable): db is Pool {
  return typeof (db as Pool).connect === "function" && typeof (db as PoolClient).release !== "function";
}

export async function withTransaction<T>(db: Queryable, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  if (isPool(db)) {
    const client = await db.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const client = db;
  let own = false;
  try {
    await client.query("savepoint windkeel_audit");
  } catch (err) {
    if ((err as { code?: string }).code !== "25P01") throw err;
    own = true;
    await client.query("begin");
  }
  try {
    const result = await fn(client);
    await client.query(own ? "commit" : "release savepoint windkeel_audit");
    return result;
  } catch (err) {
    await client.query(own ? "rollback" : "rollback to savepoint windkeel_audit").catch(() => {});
    throw err;
  }
}
