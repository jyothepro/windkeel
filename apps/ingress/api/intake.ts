import "../src/env-compat.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  dispatchIntake,
  getIntakeSource,
  INTAKE_SOURCE_NAME_PATTERN,
  INTAKE_TARGET_PATTERN,
  wireResponse,
} from "@windkeel/factory/intake";
import { functionPool } from "../src/db-pool.js";
import { schemaRefusal } from "../src/schema-gate.js";
import { intakeDatabaseUrl } from "../src/intake-enqueuer.js";
import { registerDeploymentIntakeSources } from "../src/intake-sources.js";
import { BodyTooLargeError, lowerCaseHeaders, readRawBody } from "../src/raw-request.js";

export const config = { runtime: "nodejs", api: { bodyParser: false } };

export const MAX_INTAKE_BODY_BYTES = 1024 * 1024;

registerDeploymentIntakeSources();

let pool: Pool | null = null;
function poolFor(): Pool {
  pool ??= functionPool(intakeDatabaseUrl(), 2);
  return pool;
}

export function sourceNameOf(url: string | undefined): string | null {
  return intakePathOf(url)?.source ?? null;
}

export function intakePathOf(url: string | undefined): { source: string; target?: string } | null {
  const parsed = new URL(url ?? "/", "http://localhost");
  const match = /^\/api\/intake\/([^/]+)(?:\/([^/]+))?\/?$/.exec(parsed.pathname);
  const source = match?.[1] ?? parsed.searchParams.get("source");
  const target = (match ? match[2] : parsed.searchParams.get("target")) || undefined;
  if (!source || !INTAKE_SOURCE_NAME_PATTERN.test(source)) return null;
  if (target !== undefined && !INTAKE_TARGET_PATTERN.test(target)) return null;
  return target === undefined ? { source } : { source, target };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function intake(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  const path = intakePathOf(req.url);
  const name = path?.source;
  if (!name || !getIntakeSource(name)) {
    send(res, 404, { ok: false, error: "unknown intake source" });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, { limitBytes: MAX_INTAKE_BODY_BYTES });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      send(res, 413, { ok: false, error: "request body too large" });
    } else {
      send(res, 400, { ok: false, error: "request body could not be read" });
    }
    return;
  }

  let db: Pool;
  try {
    db = poolFor();
  } catch {
    send(res, 500, { ok: false, error: "internal error" });
    return;
  }

  const refusal = await schemaRefusal(db);
  if (refusal) {
    send(res, 503, refusal);
    return;
  }

  const response = await dispatchIntake(
    name,
    { headers: lowerCaseHeaders(req), rawBody, ...(path?.target ? { target: path.target } : {}) },
    { pool: db },
  );
  const wire = wireResponse(response);
  send(res, wire.status, wire.body);
}
