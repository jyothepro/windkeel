import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterFromEnv, consoleAdapter, webhookAdapter } from "./access-adapter.ts";

const request = {
  email: "lead@example.com",
  company: "Acme",
  teamSize: "11-50" as const,
  agents: "Codex",
  receivedAt: "2026-11-17T00:00:00.000Z",
};

test("uses the console adapter when no webhook is configured", async () => {
  const adapter = adapterFromEnv({});
  assert.equal(adapter.name, "console");
  const lines: string[] = [];
  await consoleAdapter((line) => lines.push(line)).submit(request);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^access-request /);
  assert.deepEqual(JSON.parse((lines[0] ?? "").slice("access-request ".length)), request);
});

test("posts JSON to the configured webhook", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  const adapter = adapterFromEnv({ ACCESS_REQUEST_WEBHOOK_URL: "https://hooks.example.com/in" }, fetcher);
  assert.equal(adapter.name, "webhook");
  await adapter.submit(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://hooks.example.com/in");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { type: "access_request", ...request });
});

test("throws when the webhook answers with an error", async () => {
  const fetcher: typeof fetch = async () => new Response("no", { status: 500 });
  await assert.rejects(webhookAdapter("https://hooks.example.com/in", fetcher).submit(request), /500/);
});

test("refuses a plain-http webhook outside localhost", () => {
  assert.throws(() => adapterFromEnv({ ACCESS_REQUEST_WEBHOOK_URL: "http://hooks.example.com/in" }), /https/);
  assert.equal(adapterFromEnv({ ACCESS_REQUEST_WEBHOOK_URL: "http://localhost:9000/in" }).name, "webhook");
});
