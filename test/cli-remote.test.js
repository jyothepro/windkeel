import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { WindkeelApi, ApiError, MissingApiConfigError } from "../packages/cli/dist/client/api.js";
import { handleMcpMessage, PROTOCOL_VERSION } from "../packages/cli/dist/mcp/server.js";
import { TOOLS } from "../packages/cli/dist/mcp/tools.js";
import {
  approveCommand,
  deleteSecretCommand,
  formatEvent,
  messagesCommand,
  queueCommand,
  runsCommand,
  sayCommand,
  secretsCommand,
  setSecretCommand,
  watchCommand,
  whoamiCommand,
} from "../packages/cli/dist/commands/remote.js";
import { captureCommand, formatMetrics, metricsCommand, reapCommand } from "../packages/cli/dist/commands/operator.js";
import { submitCommand } from "../packages/cli/dist/commands/remote.js";
import { insertWorkspace } from "../dist/factory/repositories.js";
import { saveSessionBinding } from "../dist/factory/workflow/session-binding.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { apiControl } from "../apps/ingress/dist/src/api/control.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const TOKEN = "cli-test-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

/** Ingress gets the public half; the private half exists only in this file, as the worker would. */
const SECRET_PAIR = generateSecretKeyPair();

/**
 * The client talks to the real router over a fetch that dispatches in-process.
 *
 * No HTTP mock and no stubbed client: a fake that answered the shapes the CLI expects would pass
 * while the real API returned something else, which is the whole class of bug an end-to-end test
 * exists to catch.
 */
function fetchInto(deps, auth) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const result = await handleApiRequest(deps, auth, {
      method: init.method ?? "GET",
      path: parsed.pathname,
      query: { get: (name) => parsed.searchParams.get(name) ?? undefined },
      headers: Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status === 302 ? 200 : result.status,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  };
}

function collect() {
  const lines = [];
  return { lines, io: { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) } };
}

async function withCli(fn, controlOverrides = {}, depsOverrides = {}) {
  const schema = `windkeel_cli_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "github_issue",
      sourceReference: "acme/widgets#7",
      title: "Make the gauge read zero when empty",
      description: "- [ ] the gauge reads zero",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
    /*
     * Approve, cancel and startRun are stubbed — their real implementations reach GitHub. Guidance is
     * **not**, and that asymmetry is deliberate: what these tests are about is the queued-not-sent
     * distinction and the four delivery states, all of which live in the real port and the real
     * tables. A stub would happily have reported "delivered" and every assertion below would pass
     * against a feature that does not work.
     */
    const real = apiControl({
      pool,
      control: { cancel: async () => {}, signal: async () => {} },
      github: {},
    });
    const deps = {
      pool,
      // The public half only, exactly as ingress gets it.
      secretPublicKey: SECRET_PAIR.publicKey,
      control: {
        approve: async () => ({ outcome: "signalled" }),
        cancel: async () => ({ outcome: "cancelled" }),
        message: real.message,
        listMessages: real.listMessages,
        startRun: async () => ({ engineeringRunId: run.id }),
        enqueue: async () => ({ enqueued: true }),
        ...controlOverrides,
      },
      identity: { subject: "operator", scopes: ["operator"] },
      ...depsOverrides,
    };
    const auth = { token: TOKEN, subject: "operator" };
    const api = new WindkeelApi({
      baseUrl: "https://factory.test",
      token: TOKEN,
      fetch: fetchInto(deps, auth),
    });
    await fn({ pool, api, task, run, deps, auth });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

// --- configuration ---------------------------------------------------------

test("the client refuses to guess a base URL", () => {
  // An empty config directory, so a login stored on the machine running the tests cannot answer.
  const none = { WINDKEEL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "windkeel-no-login-")) };
  assert.throws(() => WindkeelApi.fromEnv(none), MissingApiConfigError);
  assert.throws(
    () => WindkeelApi.fromEnv({ ...none, WINDKEEL_API_URL: "https://x.test" }),
    (err) => err instanceof MissingApiConfigError && err.variable === "WINDKEEL_API_TOKEN",
  );
  // A default of localhost would report an empty factory on the day someone meant production.
  const configured = WindkeelApi.fromEnv({ ...none, WINDKEEL_API_URL: "https://x.test/", WINDKEEL_API_TOKEN: "t" });
  assert.ok(configured instanceof WindkeelApi);
});

// --- the CLI over the real API --------------------------------------------

test("windkeel runs lists real runs, and never prints a null as a number", { skip }, async () => {
  await withCli(async ({ api }) => {
    const { lines, io } = collect();
    assert.equal(await runsCommand(api, io, {}), 0);
    const body = lines.join("\n");
    assert.match(body, /Make the gauge read zero when empty/);
    assert.match(body, /—/, "an unset verdict must print as an em dash, never as 0 or empty");
    assert.doesNotMatch(body, /\bnull\b/);
  });
});

test("windkeel whoami reports the subject and the database", { skip }, async () => {
  await withCli(async ({ api }) => {
    const { lines, io } = collect();
    assert.equal(await whoamiCommand(api, io), 0);
    assert.match(lines.join("\n"), /subject {3}operator/);
    assert.match(lines.join("\n"), /database {2}reachable/);
  });
});

test("windkeel queue shows a run that has not started, and stops once it has", { skip }, async () => {
  await withCli(async ({ pool, api, run }) => {
    const before = collect();
    await queueCommand(api, before.io);
    assert.match(before.lines.join("\n"), new RegExp(run.id.slice(0, 8)));

    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");
    await advanceRun(pool, run.id, "PROVISIONING");
    const after = collect();
    await queueCommand(api, after.io);
    assert.equal(after.lines.join("\n"), "Nothing waiting.");
  });
});

test("a refusal prints its reason and exits 1, so it cannot look like success", { skip }, async () => {
  await withCli(
    async ({ api }) => {
      const { lines, io } = collect();
      const code = await approveCommand(api, io, "11111111-1111-1111-1111-111111111111");
      assert.equal(code, 1, "windkeel approve on a closed window must not exit 0");
      assert.match(lines.join("\n"), /ERR refused:/);
    },
    { approve: async () => ({ outcome: "refused", reason: "too late to approve" }) },
  );
});

test("windkeel say is refused when no maker is listening, with the server's own code", { skip }, async () => {
  await withCli(async ({ api, run }) => {
    const { lines, io } = collect();
    assert.equal(await sayCommand(api, io, run.id, "use the existing helper"), 1);
    assert.match(lines.join("\n"), /maker_not_listening/);
  });
});

test("windkeel watch follows to the end and exits on the run's own outcome", { skip }, async () => {
  await withCli(async ({ pool, api, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "agent_run",
      stageId: "22222222-2222-2222-2222-222222222222",
      kind: "model",
      usd: 0.0141,
    });
    await advanceRun(pool, run.id, "CANCELLED");

    const { lines, io } = collect();
    const code = await watchCommand(api, io, run.id, { pollMs: 1 });

    assert.equal(code, 1, "a run that did not complete cleanly must exit non-zero");
    const body = lines.join("\n");
    assert.match(body, /CREATED → CLASSIFYING/);
    assert.match(body, /cost \$0\.0141/);
    assert.match(body, /Run ended: CANCELLED/);
  });
});

test("follow resumes from a cursor, delivering each event exactly once", { skip }, async () => {
  await withCli(async ({ pool, api, run }) => {
    await advanceRun(pool, run.id, "CLASSIFYING");

    const seen = [];
    const first = api.follow(run.id, { pollMs: 1, sleep: async () => {} });
    const one = await first.next();
    seen.push(one.value.cursor);
    await first.return();

    await advanceRun(pool, run.id, "PLANNING");
    await advanceRun(pool, run.id, "CANCELLED");

    for await (const event of api.follow(run.id, { after: seen[0], pollMs: 1, sleep: async () => {} })) {
      seen.push(event.cursor);
    }
    assert.equal(new Set(seen).size, seen.length, "resuming must not repeat an event");
    assert.equal(seen.length, 3);
  });
});

test("an event renders as a line a person can read", () => {
  const line = formatEvent({
    kind: "transition",
    cursor: "5",
    at: "2026-09-23T10:20:30.000Z",
    from: "VERIFYING",
    to: "REPAIRING",
    reason: "fail verdict",
  });
  assert.equal(line, "10:20:30  VERIFYING → REPAIRING  (fail verdict)");
});

// --- the MCP server -------------------------------------------------------

test("initialize answers with the protocol version and usable instructions", { skip }, async () => {
  await withCli(async ({ api }) => {
    const reply = await handleMcpMessage(api, { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(reply.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(reply.result.serverInfo.name, "windkeel");
    assert.match(reply.result.instructions, /independent/, "an agent must be told what Windkeel is for");
    assert.match(reply.result.instructions, /endCursor/, "and how to follow a run without replaying it");
  });
});

test("a notification is never answered", { skip }, async () => {
  await withCli(async ({ api }) => {
    // Replying to notifications/initialized is a protocol violation, and every host sends it.
    assert.equal(await handleMcpMessage(api, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  });
});

test("every tool is listed with a schema, and mutations are flagged for the host", { skip }, async () => {
  await withCli(async ({ api }) => {
    const reply = await handleMcpMessage(api, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(reply.result.tools.length, TOOLS.length);
    for (const tool of reply.result.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} has no object schema`);
      assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
    }
    const destructive = reply.result.tools.filter((t) => t.annotations?.destructiveHint);
    assert.deepEqual(
      destructive.map((t) => t.name).sort(),
      ["windkeel_approve", "windkeel_cancel", "windkeel_guide"],
      "a host must be able to prompt before an agent cancels a run or approves criteria",
    );
  });
});

test("a tool call reaches the real API and returns its rows", { skip }, async () => {
  await withCli(async ({ api, run }) => {
    const reply = await handleMcpMessage(api, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "windkeel_list_runs", arguments: {} },
    });
    assert.equal(reply.result.isError, false);
    const payload = JSON.parse(reply.result.content[0].text);
    assert.equal(payload.items[0].id, run.id);
  });
});

test("a factory refusal is tool content, not a protocol error", { skip }, async () => {
  await withCli(async ({ api, run }) => {
    const reply = await handleMcpMessage(api, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "windkeel_guide", arguments: { runId: run.id, message: "hi" } },
    });
    // The model has to be able to read "no maker is listening" and decide what to do. A JSON-RPC
    // error would mean the server failed, which is a different thing entirely.
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /maker_not_listening/);
  });
});

test("a missing required argument is a readable tool error, not a crash", { skip }, async () => {
  await withCli(async ({ api }) => {
    const reply = await handleMcpMessage(api, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "windkeel_guide", arguments: { runId: "abc" } },
    });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /requires message/);
  });
});

test("an unknown tool and an unknown method are distinguished", { skip }, async () => {
  await withCli(async ({ api }) => {
    const badTool = await handleMcpMessage(api, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "windkeel_delete_everything", arguments: {} },
    });
    assert.equal(badTool.error.code, -32602);

    const badMethod = await handleMcpMessage(api, { jsonrpc: "2.0", id: 7, method: "resources/list" });
    assert.equal(badMethod.error.code, -32601);
  });
});

test("the guidance tool tells the model the constraint the API enforces", () => {
  const guide = TOOLS.find((t) => t.name === "windkeel_guide");
  // The server cannot inspect intent, so the rule has to be where the model reads it.
  assert.match(guide.description, /never \*what\*/);
  assert.match(guide.description, /cancel and submit a new task/);
});

test("submitting work tells the model to write its own criteria", () => {
  const submit = TOOLS.find((t) => t.name === "windkeel_submit_task");
  assert.match(submit.description, /checklist/);
  assert.match(submit.description, /approve/, "the generation path costs a human's attention");
});

// --- guidance, from a person's side ---------------------------------------

/** IMPLEMENTING, which is the only kind of run guidance is accepted for. */
async function reachImplementing(pool, runId) {
  for (const next of ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"]) {
    await advanceRun(pool, runId, next, "seed");
  }
}

test("windkeel say says queued, and says when it will land", { skip }, async () => {
  await withCli(async ({ pool, api, run }) => {
    await reachImplementing(pool, run.id);
    const { lines, io } = collect();
    assert.equal(await sayCommand(api, io, run.id, "use the existing helper"), 0);
    const printed = lines.join("\n");
    /*
     * "Sent" is the wrong word, and this asserts against it rather than only for the right one. The
     * maker gets guidance at its next turn boundary; an operator told "Sent" watches the next minute
     * of unchanged output and concludes the agent ignored them.
     */
    assert.match(printed, /^Queued for /m);
    assert.ok(!/^Sent/m.test(printed), "the CLI must not claim a delivery the API did not make");
    assert.match(printed, /next turn boundary/);
    assert.match(printed, /windkeel messages/, "the one command that answers `did it land`");
  });
});

test("windkeel messages distinguishes queued from superseded", { skip }, async () => {
  await withCli(async ({ pool, api, run }) => {
    await reachImplementing(pool, run.id);
    await sayCommand(api, { out() {}, err() {} }, run.id, "steer");

    const live = collect();
    assert.equal(await messagesCommand(api, live.io, run.id), 0);
    assert.match(live.lines.join("\n"), /\[queued\]/);
    assert.match(live.lines.join("\n"), /steer/);

    await advanceRun(pool, run.id, "CANCELLED", "done");
    const dead = collect();
    assert.equal(await messagesCommand(api, dead.io, run.id), 0);
    const printed = dead.lines.join("\n");
    assert.match(printed, /\[superseded\]/);
    assert.match(
      printed,
      /never delivered/,
      "a state name alone reads as jargon; the consequence is the message",
    );
  });
});

test("windkeel messages on a run nobody spoke to says so rather than printing nothing", { skip }, async () => {
  await withCli(async ({ api, run }) => {
    const { lines, io } = collect();
    assert.equal(await messagesCommand(api, io, run.id), 0);
    assert.match(lines.join("\n"), /Nothing has been said/);
  });
});

// --- secrets, from a person's side ----------------------------------------

test("windkeel secret set stores it, and windkeel secrets lists names without values", { skip }, async () => {
  await withCli(async ({ api }) => {
    const set = collect();
    assert.equal(
      await setSecretCommand(api, set.io, REPO_ID, "NPM_TOKEN", "npm_s3cret", "read-only"),
      0,
    );
    assert.match(set.lines.join("\n"), /Set NPM_TOKEN/);

    const listed = collect();
    assert.equal(await secretsCommand(api, listed.io, REPO_ID), 0);
    const printed = listed.lines.join("\n");
    assert.match(printed, /NPM_TOKEN/);
    assert.match(printed, /read-only/);
    assert.ok(!printed.includes("npm_s3cret"), "a value must never reach a terminal");
    // Said out loud, because "why is there no value column" is the first question.
    assert.match(printed, /sealed to a key only the worker holds/);
  });
});

test("a refused secret name exits 1 with the rule, not just a rejection", { skip }, async () => {
  await withCli(async ({ api }) => {
    const { lines, io } = collect();
    assert.equal(await setSecretCommand(api, io, REPO_ID, "PATH", "/tmp/evil"), 1);
    const printed = lines.join("\n");
    assert.match(printed, /^ERR refused:/m);
    assert.match(printed, /invalid_secret_key/);
    assert.match(printed, /interpreter/);
  });
});

test("windkeel secrets on a repository with none says so", { skip }, async () => {
  await withCli(async ({ api }) => {
    const { lines, io } = collect();
    assert.equal(await secretsCommand(api, io, REPO_ID), 0);
    assert.match(lines.join("\n"), /no secrets/);
  });
});

test("windkeel secret rm on a name that is not there exits 1", { skip }, async () => {
  await withCli(async ({ api }) => {
    const { lines, io } = collect();
    assert.equal(await deleteSecretCommand(api, io, REPO_ID, "ABSENT"), 1);
    assert.match(lines.join("\n"), /^ERR refused:/m);
  });
});

// --- what the MCP surface tells a model -----------------------------------

test("the guidance tool warns the model not to repeat itself while queued", () => {
  const guide = TOOLS.find((t) => t.name === "windkeel_guide");
  /*
   * The specific failure this sentence prevents: an agent sends guidance, sees a minute of unchanged
   * output, and sends it again — two turns of identical instructions and two turns of tokens. A tool
   * description is the only thing a model reads before deciding.
   */
  assert.match(guide.description, /QUEUES/);
  assert.match(guide.description, /Do not send the same guidance again/);
  assert.match(guide.description, /windkeel_messages/);
});

test("there is a tool to read secret names and deliberately none to set one", () => {
  assert.ok(TOOLS.some((t) => t.name === "windkeel_list_secrets"));
  assert.equal(
    TOOLS.filter((t) => /secret/.test(t.name) && t.annotations?.readOnlyHint !== true).length,
    0,
    "a set-secret tool would put a credential into a model context window and a vendor transcript",
  );
  const list = TOOLS.find((t) => t.name === "windkeel_list_secrets");
  assert.match(list.description, /never returned/);
  assert.match(list.description, /windkeel secret set/, "it has to say where the value does go");
});

// --- the operator commands, over the API (ADR-0023 §10) ----------------------

test("windkeel submit resolves owner/name against the repositories this token can see", { skip }, async () => {
  const submitted = [];
  await withCli(
    async ({ api }) => {
      const { lines, io } = collect();
      const code = await submitCommand(api, io, {
        repo: "jyothepro/windkeel-fixture-11111111",
        title: "t",
        description: "- [ ] it works",
        spendCapUsd: 4,
      });
      assert.equal(code, 0, lines.join("\n"));
      assert.match(lines.join("\n"), /^Submitted /);
      assert.equal(submitted.length, 1, "the created run was handed to the workflow");

      const unknown = collect();
      assert.equal(await submitCommand(api, unknown.io, { repo: "acme/nothing", title: "t", description: "d" }), 1);
      assert.match(unknown.lines.join("\n"), /no repository acme\/nothing is granted/);
    },
    { enqueue: async (id) => (submitted.push(id), { enqueued: true }) },
  );
});

test("windkeel metrics renders the views, and a null as an em dash", { skip }, async () => {
  await withCli(async ({ api }) => {
    const { lines, io } = collect();
    assert.equal(await metricsCommand(api, io), 0);
    const text = lines.join("\n");
    assert.match(text, /^task_success_rate$/m);
    assert.match(text, /time_to_pr \(0 rows\)/);
    assert.doesNotMatch(text, /: null$/m, "a null is never printed as the word null");
  });
  assert.match(formatMetrics({ summary: { merge_rate: { merge_rate_pct: null } }, perRun: {} }), /merge_rate_pct: —/);
});

async function seedDeadSandbox(pool, run) {
  await advanceRun(pool, run.id, "CLASSIFYING", "seed");
  await advanceRun(pool, run.id, "FAILED", "seed");
  return insertWorkspace(pool, {
    engineeringRunId: run.id,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: `sbx-${Math.random().toString(36).slice(2, 10)}`,
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status: "ready",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

test("windkeel reap --dry-run says what it would destroy; windkeel reap destroys it", { skip }, async () => {
  const destroyed = [];
  const provider = {
    name: "fake",
    capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: true },
    async create() {
      throw new Error("unused");
    },
    async attach({ handleId }) {
      return { id: handleId, async destroy() { destroyed.push(handleId); } };
    },
  };
  await withCli(
    async ({ api, pool, run }) => {
      const clean = collect();
      await reapCommand(api, clean.io, { dryRun: true });
      assert.deepEqual(clean.lines, ["nothing to reap"]);

      const workspace = await seedDeadSandbox(pool, run);
      const dry = collect();
      assert.equal(await reapCommand(api, dry.io, { dryRun: true }), 0);
      assert.match(dry.lines.join("\n"), /1 sandbox\(es\) would be destroyed/);
      assert.match(dry.lines.join("\n"), new RegExp(`${workspace.providerHandle}.*because run_terminal`));
      assert.deepEqual(destroyed, [], "a dry run destroys nothing");

      const real = collect();
      assert.equal(await reapCommand(api, real.io, {}), 0);
      assert.deepEqual(real.lines, ["considered 1: destroyed 1"]);
      assert.deepEqual(destroyed, [workspace.providerHandle]);
    },
    {},
    { sandboxes: async () => ({ fake: provider }) },
  );
});

test("windkeel capture downloads what the deployment stored, and says so when the sandbox is gone", { skip }, async () => {
  const objects = new Map();
  const store = {
    bucket: "evidence-test",
    async put(localDir, key) {
      const walk = (dir, prefix = "") => {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, name.name);
          if (name.isDirectory()) walk(full, `${prefix}${name.name}/`);
          else objects.set(`${key}/${prefix}${name.name}`, readFileSync(full));
        }
      };
      walk(localDir);
    },
    async list(key) {
      return [...objects.keys()].filter((k) => k.startsWith(`${key}/`)).map((k) => k.slice(key.length + 1));
    },
    async presign(key, path) {
      return `https://store.test/${key}/${path}`;
    },
  };
  await withCli(
    async ({ pool, run, deps, auth }) => {
      const handleId = `capture-${Math.random().toString(36).slice(2, 10)}`;
      const scratchDir = join(tmpdir(), `windkeel-fake-sandbox-${handleId}`, "scratch");
      mkdirSync(scratchDir, { recursive: true });
      writeFileSync(join(scratchDir, "turn-1.events.jsonl"), '{"type":"turn.completed"}\n');
      await insertWorkspace(pool, {
        engineeringRunId: run.id,
        role: "maker",
        sandboxProvider: "fake",
        providerHandle: handleId,
        repository: "r",
        baseSha: "a".repeat(40),
        workingBranch: null,
        status: "ready",
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await saveSessionBinding(pool, run.id, {
        workerType: "codex",
        sessionRef: { id: "s", workerType: "codex", workerSessionId: "codex-1", adapterState: { scratchDir, turn: 1 } },
        resumable: true,
      });

      // The API in-process, and the presigned URLs served from the same in-memory bucket.
      const api = new WindkeelApi({
        baseUrl: "https://factory.test",
        token: TOKEN,
        fetch: async (url, init = {}) => {
          const parsed = new URL(String(url));
          if (parsed.host === "store.test") {
            assert.equal(init.headers?.authorization, undefined, "the bearer never goes to the object store");
            return new Response(objects.get(parsed.pathname.slice(1)));
          }
          return fetchInto(deps, auth)(url, init);
        },
      });

      const out = mkdtempSync(join(tmpdir(), "windkeel-cli-capture-"));
      const first = collect();
      assert.equal(await captureCommand(api, first.io, run.id, { out }), 0, first.lines.join("\n"));
      assert.equal(readFileSync(join(out, "sandbox", "turn-1.events.jsonl"), "utf8"), '{"type":"turn.completed"}\n');
      assert.ok(existsSync(join(out, "session-ref.json")));

      // The sandbox goes; the stored capture does not.
      await pool.query("delete from worker_session_binding where engineering_run_id = $1", [run.id]);
      const later = mkdtempSync(join(tmpdir(), "windkeel-cli-capture-"));
      const second = collect();
      assert.equal(await captureCommand(api, second.io, run.id, { out: later }), 1, "not a fresh capture: exit 1");
      assert.match(second.lines.join("\n"), /no worker session binding/);
      assert.match(second.lines.join("\n"), /capture stored earlier/);
      assert.ok(existsSync(join(later, "sandbox", "turn-1.events.jsonl")), "the earlier capture was downloaded");
    },
    {},
    { captures: store, sandboxes: async () => ({ fake: new FakeSandboxProvider() }) },
  );
});
