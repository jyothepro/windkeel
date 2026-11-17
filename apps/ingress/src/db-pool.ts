import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

const IDLE_CLOSE_MS = 5_000;
const CONNECT_WAIT_MS = 5_000;

export function functionPool(connectionString: string, max: number): Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: IDLE_CLOSE_MS,
    connectionTimeoutMillis: CONNECT_WAIT_MS,
  });
  attachDatabasePool(pool);
  return pool;
}

export { isConnectionLimit } from "./connection-limit.js";
