#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { grantRepositoryToDefaultOrganization, insertRepositoryIfMissing } from "./stores/local-api-store.mjs";

const env = process.env;
env.DATABASE_URL ??= "postgresql://localhost:5432/windkeel_console";
env.WINDKEEL_API_TOKEN ??= "local-dev-token";
env.GITHUB_WEBHOOK_SECRET ??= "local";
const database = new URL(env.DATABASE_URL);
const localDatabase = ["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(database.hostname);
if (!localDatabase && !process.argv.includes("--allow-remote-database")) {
  console.error(
    `DATABASE_URL points at ${database.hostname}, not this machine. Commands sent to this API change that database's runs.\n` +
      "Pass --allow-remote-database if that is what you mean.",
  );
  process.exit(1);
}

database.password = database.password ? "***" : "";

if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
  console.warn(`Using the real GitHub App ${env.GITHUB_APP_ID} from your environment. Commands can reach GitHub.`);
} else {
  env.GITHUB_APP_ID = "1";
  env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  console.log("No GitHub App configured: using a throwaway key. Reads work; anything that calls GitHub will fail.");
}

const seedAt = process.argv.indexOf("--seed-repository");
if (seedAt !== -1) {
  const [owner, name] = (process.argv[seedAt + 1] ?? "").split("/");
  if (!owner || !name) throw new Error("--seed-repository takes owner/name");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const added = await insertRepositoryIfMissing(client, owner, name);
  console.log(added ? `Added repository ${owner}/${name}.` : `Repository ${owner}/${name} already exists.`);

  await grantRepositoryToDefaultOrganization(client, owner, name);
  await client.end();
}

const entry = fileURLToPath(new URL("../../ingress/dist/api/v1.js", import.meta.url));
const { default: handler } = await import(entry);
const port = Number(env.PORT ?? 8787);

createServer((req, res) => {
  if (!req.url?.startsWith("/v1")) {
    res.writeHead(404).end();
    return;
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, "127.0.0.1", () => {
  const token = env.WINDKEEL_API_TOKEN === "local-dev-token" ? "local-dev-token" : "(from WINDKEEL_API_TOKEN)";
  console.log(`/v1 on http://localhost:${port}  (token: ${token}, database: ${database})`);
});
