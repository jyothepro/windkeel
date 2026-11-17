
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function countPendingDeviceLogins(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    "select count(*) as n from device_authorization where state = 'pending' and expires_at > now()",
  );
  return Number(rows[0]!["n"]);
}

export async function insertDeviceLogin(
  db: Queryable,
  input: {
    deviceCodeHash: string;
    userCode: string;
    machineName: string;
    permissions: readonly string[];
    organizationId: string | null;
    ttlSeconds: number;
  },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into device_authorization
       (device_code_hash, user_code, machine_name, permissions, organization_id, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(secs => ${input.ttlSeconds}))
     returning *`,
    [input.deviceCodeHash, input.userCode, input.machineName, input.permissions, input.organizationId],
  );
  return rows[0]!;
}

export async function selectLatestDeviceLoginByUserCode(db: Queryable, userCode: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select * from device_authorization where user_code = $1 order by created_at desc limit 1`,
    [userCode],
  );
  return rows[0];
}

export async function decidePendingDeviceLogin(
  db: Queryable,
  userCode: string,
  decision: "approved" | "denied",
  principalId: string,
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update device_authorization
        set state = $2, decided_by_principal_id = $3, decided_at = now()
      where user_code = $1 and state = 'pending' and expires_at > now()
      returning *`,
    [userCode, decision, principalId],
  );
  return rows[0];
}

export async function recordDevicePoll(db: Queryable, deviceCodeHash: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update device_authorization d
        set last_polled_at = now(),
            state = case when d.state = 'approved' then 'consumed' else d.state end
       from (select id, last_polled_at as previous_poll, state as previous_state
               from device_authorization where device_code_hash = $1 for update) prior
      where d.id = prior.id
      returning d.*, prior.previous_poll, prior.previous_state`,
    [deviceCodeHash],
  );
  return rows[0];
}

export async function setDeviceLoginToken(db: Queryable, loginId: string, tokenId: string): Promise<void> {
  await db.query("update device_authorization set api_token_id = $2 where id = $1", [loginId, tokenId]);
}
