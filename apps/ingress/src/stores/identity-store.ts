
export interface IdentityDb {
  query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function githubIdentityRows(db: IdentityDb, subject: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    "select github_user_id, github_login, display_name from github_identity_of($1::uuid)",
    [subject],
  );
  return rows;
}
