

import type { PoolClient } from "pg";

export async function currentSchema(client: PoolClient): Promise<string | undefined> {
  const { rows } = await client.query<{ schema: string }>("select current_schema() as schema");
  return rows[0]?.schema;
}

export async function tryAdvisoryLock(client: PoolClient, namespace: number, key: number): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1, $2) as locked",
    [namespace, key],
  );
  return rows[0]?.locked === true;
}

export async function advisoryUnlock(client: PoolClient, namespace: number, key: number): Promise<void> {
  await client.query("select pg_advisory_unlock($1, $2)", [namespace, key]);
}
