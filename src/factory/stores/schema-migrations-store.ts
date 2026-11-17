

export interface SchemaQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: R[] }>;
}

export async function selectAppliedMigrations(db: SchemaQueryable): Promise<string[]> {
  const { rows } = await db.query<{ filename: string }>("select filename from schema_migrations");
  return rows.map((r) => r.filename);
}
