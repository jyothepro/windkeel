import type { Pool, PoolClient } from "pg";
import { withTransaction } from "@windkeel/factory/tenancy";

class RolledBack<R> extends Error {
  constructor(readonly answer: R) {
    super("transaction rolled back with an answer");
  }
}

export async function transact<T, R = T>(
  pool: Pool,
  fn: (tx: PoolClient, rollback: (answer: R) => never) => Promise<T>,
): Promise<T | R> {
  try {
    return await withTransaction(pool, (tx) =>
      fn(tx, (answer) => {
        throw new RolledBack(answer);
      }),
    );
  } catch (err) {
    if (err instanceof RolledBack) return err.answer as R;
    throw err;
  }
}
