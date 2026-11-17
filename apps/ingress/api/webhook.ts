import "../src/env-compat.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { githubClientFromEnv } from "@windkeel/factory/github";
import { loadIngressConfig } from "../src/config.js";
import { functionPool } from "../src/db-pool.js";
import { primeSchemaCheck, schemaRefusal } from "../src/schema-gate.js";
import { handleWebhook } from "../src/handler.js";
import { windkeelActions, runEnqueuer } from "../src/windkeel-actions.js";
import { lowerCaseHeaders, readRawBody } from "../src/raw-request.js";

export const config = { runtime: "nodejs", api: { bodyParser: false } };

const ingressConfig = loadIngressConfig();

const pool = functionPool(ingressConfig.databaseUrl, 2);
primeSchemaCheck(pool);

const github = githubClientFromEnv();
const actions = windkeelActions({
  github,
  enqueue: runEnqueuer({
    connectionString: ingressConfig.databaseUrl,
  }),
});

export default async function webhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return;
  }

  const refusal = await schemaRefusal(pool);
  if (refusal) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(refusal));
    return;
  }

  const response = await handleWebhook(
    { headers: lowerCaseHeaders(req), rawBody: await readRawBody(req) },
    { secret: ingressConfig.webhookSecret, pool, actions, permissions: github },
  );

  res.statusCode = response.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(response.body));
}
