import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentHeadline, sizeLabel, suggestedPatch, workspaceEnvironmentLabel, type RepositoryEnvironment } from "./environment.ts";

const row = (status: RepositoryEnvironment["items"][number]["status"], baseSha = "abcdef0123456789") => ({
  id: "11111111-2222-3333-4444-555555555555",
  status,
  sandboxProvider: "vercel",
  cacheKey: "f".repeat(64),
  baseSha,
  sizeBytes: 2_500_000,
  detail: null,
  setupLogRef: null,
  builtBy: "system",
  createdAt: "2026-10-21T00:00:00Z",
  readyAt: status === "ready" ? "2026-10-21T00:05:00Z" : null,
  expiresAt: null,
  lastUsedAt: null,
});
const env = (over: Partial<RepositoryEnvironment>): RepositoryEnvironment => ({ items: [], current: null, pendingRequest: null, proposedSetup: null, ...over });

test("the headline says warm, building, queued, failed or cold", () => {
  assert.match(environmentHeadline(env({ items: [row("ready")], current: row("ready") })), /warm from a snapshot built at abcdef0/);
  assert.match(environmentHeadline(env({ items: [row("building")] })), /building/);
  assert.match(environmentHeadline(env({ pendingRequest: { requestedBy: "x", reason: "y", requestedAt: "z" } })), /queued/);
  assert.match(environmentHeadline(env({ items: [row("failed")] })), /failed/);
  assert.equal(environmentHeadline(env({})), "No snapshot. Runs start cold.");
});

test("sizes, the suggested patch and the run page's label", () => {
  assert.equal(sizeLabel(2_500_000), "2.5 MB");
  assert.equal(sizeLabel(null), "—");
  assert.equal(suggestedPatch(env({ proposedSetup: { setup: { commands: [], services: [] }, reasons: [] } })), null);
  const patch = suggestedPatch(env({ proposedSetup: { setup: { commands: [{ name: "bootstrap", run: "make bootstrap" }], services: [] }, reasons: [] } }));
  assert.match(patch ?? "", /make bootstrap/);
  assert.equal(workspaceEnvironmentLabel("cold"), "cold");
  assert.equal(workspaceEnvironmentLabel("snapshot", "1a2b3c4d5e"), "warm (snapshot 1a2b3c4d)");
  assert.equal(workspaceEnvironmentLabel(null), null);
});
