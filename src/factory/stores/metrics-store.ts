
import type { Queryable } from "../db/transaction.js";

export async function selectMetricsView(db: Queryable, view: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(`select * from ${view}`);
  return rows;
}
