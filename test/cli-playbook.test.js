/**
 * `windkeel submit --playbook` and `windkeel playbook list|show` (#390), against a fake API.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { playbookCommand } from "../packages/cli/dist/commands/playbook.js";
import { submitCommand } from "../packages/cli/dist/commands/remote.js";
import { cliPath } from "./helpers.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO = "11111111-1111-1111-1111-111111111111";

const DEP = {
  id: null,
  slug: "dependency-upgrade",
  name: "Dependency upgrade",
  kind: "dependency-upgrade",
  version: 1,
  builtin: true,
  makerInstructions: "This task upgrades a dependency.\n- Upgrade only the package(s) named.",
  criteria: [{ text: "Lockfile is updated consistently with the manifest" }],
  verifier: { checksRequired: true, requireStages: ["security"] },
  defaultRiskLevel: null,
  modelPresetId: null,
  verifierAdds: ["fail when the repository declares no checks", "require the security stage to run (a skip blocks)"],
  addedCriteria: [{ id: "PB1", text: "Lockfile is updated consistently with the manifest" }],
};
const MINE = { ...DEP, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", slug: "strict-lint", name: "Strict lint", kind: "custom", version: 3, builtin: false, verifierAdds: [], addedCriteria: [] };

function answer(method, path, body) {
  if (method === "GET" && path.endsWith("/playbooks")) return { status: 200, body: { items: [DEP, MINE] } };
  if (method === "GET" && path.endsWith("/playbooks/dependency-upgrade")) return { status: 200, body: { playbook: DEP } };
  if (method === "GET" && path.includes("/playbooks/")) {
    return { status: 404, body: { error: 'no playbook "nope" in this organization', code: "unknown_playbook" } };
  }
  if (method === "POST" && path.endsWith("/tasks")) {
    if (body?.playbook === "nope") return { status: 404, body: { error: 'no playbook "nope" in this organization', code: "unknown_playbook" } };
    return { status: 202, body: { accepted: true, taskId: "t-1", engineeringRunId: "r-1", enqueued: true } };
  }
  return null;
}

function fakeApi() {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method: init.method, path: parsed.pathname, body });
    const a = answer(init.method, parsed.pathname, body) ?? { status: 404, body: { error: "no route", code: "no_route" } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { api: new WindkeelApi({ baseUrl: "https://windkeel.example.com", token: "orq_test", org: ORG, fetch }), requests };
}

function collect() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

test("windkeel playbook list prints slug, kind, version and built-in, one row each", async () => {
  const { api } = fakeApi();
  const { out, io } = collect();
  assert.equal(await playbookCommand(api, io, { kind: "list" }), 0);
  assert.match(out[0], /^SLUG\s+KIND\s+VERSION\s+BUILTIN\s+NAME$/);
  assert.match(out[1], /^dependency-upgrade\s+dependency-upgrade\s+v1\s+yes\s+Dependency upgrade$/);
  assert.match(out[2], /^strict-lint\s+custom\s+v3\s+no\s+Strict lint$/);
  const json = collect();
  assert.equal(await playbookCommand(api, json.io, { kind: "list", json: true }), 0);
  assert.equal(JSON.parse(json.out.join("\n")).length, 2);
});

test("windkeel playbook show prints the instructions, the added criteria and what the verifier will also do", async () => {
  const { api } = fakeApi();
  const { out, io } = collect();
  assert.equal(await playbookCommand(api, io, { kind: "show", slug: "dependency-upgrade" }), 0);
  const text = out.join("\n");
  assert.match(text, /^dependency-upgrade v1 \(built-in\) — Dependency upgrade/);
  assert.match(text, /Maker instructions\n {2}This task upgrades a dependency\./);
  assert.match(text, /\[PB1\] Lockfile is updated consistently/);
  assert.match(text, /Verifier will also\n {2}fail when the repository declares no checks\n {2}require the security stage to run/);
});

test("an unknown playbook prints the refusal and exits 1", async () => {
  const { api } = fakeApi();
  const shown = collect();
  assert.equal(await playbookCommand(api, shown.io, { kind: "show", slug: "nope" }), 1);
  assert.match(shown.err.join("\n"), /refused: no playbook "nope".*\[unknown_playbook\]/);
  const submitted = collect();
  assert.equal(await submitCommand(api, submitted.io, { repo: REPO, title: "t", description: "d", playbook: "nope" }), 1);
  assert.match(submitted.err.join("\n"), /unknown_playbook/);
});

test("submit sends playbook in the body of POST /v1/tasks", async () => {
  const { api, requests } = fakeApi();
  const { io } = collect();
  assert.equal(await submitCommand(api, io, { repo: REPO, title: "t", description: "d", playbook: "dependency-upgrade" }), 0);
  const post = requests.find((r) => r.method === "POST");
  assert.equal(post.body.playbook, "dependency-upgrade");
  assert.equal(post.body.repositoryId, REPO);
});

/** The real binary, with `--playbook` on the command line, against a local fake control plane. */
test("windkeel submit --playbook <slug> reaches the API from the command line", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, path: new URL(req.url, "http://x").pathname, body });
      const a = answer(req.method, new URL(req.url, "http://x").pathname, body) ?? { status: 404, body: { error: "no route", code: "no_route" } };
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [cliPath, ...args], {
          env: { ...process.env, WINDKEEL_API_URL: `http://127.0.0.1:${port}`, WINDKEEL_API_TOKEN: "orq_test", WINDKEEL_ORG: ORG },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    const submitted = await run(["submit", "--repo", REPO, "--title", "Bump", "--description", "Upgrade left-pad.", "--playbook", "dependency-upgrade"]);
    assert.equal(submitted.code, 0, submitted.stderr);
    assert.equal(seen.find((r) => r.method === "POST" && r.path.endsWith("/tasks")).body.playbook, "dependency-upgrade");
    const listed = await run(["playbook", "list"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /dependency-upgrade/);
    const refused = await run(["playbook", "show", "nope"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /unknown_playbook/);
  } finally {
    server.close();
  }
});
