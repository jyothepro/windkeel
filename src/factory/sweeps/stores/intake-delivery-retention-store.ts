
import type { Queryable } from "../../db/transaction.js";

export async function deleteIgnoredDeliveriesBefore(db: Queryable, days: number): Promise<number> {
  const { rowCount } = await db.query(
    `delete from intake_delivery
      where intent = 'ignore'
        and received_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  return rowCount ?? 0;
}
