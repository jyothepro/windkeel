import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  listRepairPackets,
  listVerificationRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { putModelCredential } from "../dist/factory/model-credentials.js";
import { putRepositorySecret } from "../dist/factory/repository-secrets.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import {
  createVerifyingHandler,
  factoryRunner,
} from "../dist/factory/workflow/handlers/verifying.js";
import { bareFixtureRepo, repoRoot, runCli, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The engine's own scripted-fake affordances are reused rather than reinvented:
 * `VerificationRequest.models.fakes` takes a JSON script per purpose and `fakeSecurity` takes
 * one for the scanners — the same seam M0's tests use to avoid live models. So no network, no
 * model key, no Vercel, no Codex.
 *
 * Postgres-gated: the `VerificationRun` row, the `RepairAttempt`, and the exactly-once guard
 * are all rows.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const DIRTY_REVIEW = {
  summary: "a blocking defect",
  findings: [
    {
      id: "REV-1",
      severity: "blocking",
      category: "correctness",
      claim: "the greeting is never printed",
      location: "index.js",
      failure_scenario: "a user runs the module and sees nothing",
    },
  ],
};

/** Every criterion satisfied by the checks evidence — a clean mapping. */
function mappingFor(criteria, evidenceId = "ev-01") {
  return {
    mappings: criteria.map((c) => ({
      criterion: c.id,
      status: "satisfied",
      evidence: [evidenceId],
      reason: "the repo's own checks pass on the candidate",
    })),
  };
}

const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];

class MutatingWorkerAdapter {
  constructor(inner) {
    this.inner = inner;
  }
  get name() {
    return this.inner.name;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  get calls() {
    return this.inner.calls;
  }
  async start(input) {
    await input.sandbox.writeFile("index.js", "console.log('hello');\n");
    return this.inner.start(input);
  }
  send(s, m) {
    return this.inner.send(s, m);
  }
  cancel(s) {
    return this.inner.cancel(s);
  }
  events(s) {
    return this.inner.events(s);
  }
  async result(s) {
    const result = await this.inner.result(s);
    if (result.outcome !== "completed") return result;
    return {
      ...result,
      diff: { patch: "+console.log('hello');\n", filesChanged: ["index.js"], truncated: false },
    };
  }
}

const STREAM = [
  { type: "started", sessionId: "sess-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
  { type: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
];

/** An in-memory `EvidenceStorage` that keeps the bytes, so a package can be round-tripped. */
class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(localDir, bucket, key) {
    const dest = tempDir("stored");
    cpSync(localDir, dest, { recursive: true });
    const ref = `${bucket}/${key}`;
    this.packages.set(ref, dest);
    return ref;
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
}

async function withVerify(fn, options = {}) {
  const schema = `windkeel_verify_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  // `test: "true"` so the re-run of the repo's own checks passes deterministically in the
  // verifier sandbox without a node_modules install.
  const remote = bareFixtureRepo({ test: "true" }, options.repoFiles ?? {});
  const sandboxes = new FakeSandboxProvider();
  const registry = new SandboxRegistry();
  const storage = new MemoryEvidenceStorage();

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m4.6",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: CRITERIA,
      riskLevel: options.riskLevel ?? "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) {
      await advanceRun(pool, run.id, to, "test seed");
    }
    if (options.prepare) await options.prepare({ pool, runId: run.id });

    const deps = {
      pool,
      sandboxes,
      worker: (options.worker ?? ((inner) => new MutatingWorkerAdapter(inner)))(new FakeWorkerAdapter(STREAM)),
      registry,
      sessions: new WorkerSessionRegistry(),
      evidence: options.noStorage ? undefined : { storage, bucket: "evidence" },
      config: {
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 60_000,
        workspaceTtlMs: 60_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "test",
        fakeSecurity: join(repoRoot, "test", "fixtures", "no-scanners.json"),
        ...(options.config ?? {}),
        checkerModels: {
          endpoints: [],
          // ADR-0010: the checker is told who the maker was, so a real endpoint from that
          // vendor would be refused by `selectGateway`.
          maker: { vendor: "openai", model: "gpt-5-codex" },
          fakes: {
            review: scripted("review", options.review ?? CLEAN_REVIEW),
            mapping: scripted("mapping", options.mapping ?? mappingFor(CRITERIA)),
          },
        },
      },
    };

    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provider.register(createProvisioningHandler(deps));
    provider.register(createImplementingHandler(deps));
    provider.register(createVerifyingHandler(deps));
    await provider.start();

    await fn({ pool, provider, deps, runId: run.id, sandboxes, registry, storage, remote });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function transitions(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.slice(3).map((r) => `${r.from_state}->${r.to_state}`);
}

test(
  "a passing candidate produces a pass verdict, a sealed package, and a VerificationRun row",
  { skip },
  async () => {
    await withVerify(async ({ pool, provider, runId, storage }) => {
      await provider.startRun(runId);
      await provider.drain();

      assert.deepEqual(await transitions(pool, runId), [
        "PROVISIONING->IMPLEMENTING",
        "IMPLEMENTING->VERIFYING",
        "VERIFYING->PR_CREATING",
      ]);

      const [verification] = await listVerificationRuns(pool, runId);
      assert.equal(verification.verdict, "pass");
      assert.match(verification.candidateSha, /^[0-9a-f]{40}$/);
      assert.equal(verification.policyVersion, "windkeel-engine@test");
      assert.ok(verification.completedAt);

      // ADR-0008 pointer and ADR-0015 manifest digest, both on the row.
      assert.equal(verification.evidencePackageRef, `evidence/${runId}/${verification.id}`);
      assert.match(verification.evidenceManifestDigest, /^[0-9a-f]{64}$/);
      assert.ok(storage.packages.has(verification.evidencePackageRef));
    });
  },
);

test(
  "the sealed package verifies offline after a storage round-trip",
  { skip },
  async () => {
    await withVerify(async ({ pool, provider, runId, storage }) => {
      await provider.startRun(runId);
      await provider.drain();

      const [verification] = await listVerificationRuns(pool, runId);
      const stored = storage.packages.get(verification.evidencePackageRef);
      assert.ok(stored, "the package is in storage");

      // Round-tripped through the real CLI, not by inspecting a directory listing: this is
      // what proves the package that reached storage is *complete*, which a partial package
      // would still have sealed and uploaded successfully.
      const result = runCli(["verify-package", stored]);
      assert.equal(result.code, 0, `verify-package failed:\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /verdict: pass/i);

      // And the digest on the row is the digest of what actually landed (ADR-0015).
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256")
        .update(readFileSync(join(stored, "hashes.json")))
        .digest("hex");
      assert.equal(verification.evidenceManifestDigest, digest);
    });
  },
);

test(
  "the verifier sandbox is created fresh at the candidate SHA, distinct from the maker's",
  { skip },
  async () => {
    await withVerify(async ({ pool, provider, runId }) => {
      await provider.startRun(runId);
      await provider.drain();

      const workspaces = await listWorkspaces(pool, runId);
      const maker = workspaces.find((w) => w.role === "maker");
      const verifier = workspaces.find((w) => w.role === "verifier");
      assert.ok(maker && verifier, "two workspaces, one per role");
      assert.notEqual(
        verifier.providerHandle,
        maker.providerHandle,
        "a different handle, not the maker's reused",
      );

      const [verification] = await listVerificationRuns(pool, runId);
      assert.equal(
        verifier.baseSha,
        verification.candidateSha,
        "cloned at the candidate SHA — ADR-0004 independence",
      );
    });
  },
);

test(
  "the evidence records a factory runner and the model that actually authored the candidate",
  { skip },
  async () => {
    await withVerify(async ({ pool, provider, runId, storage }) => {
      await provider.startRun(runId);
      await provider.drain();

      const [verification] = await listVerificationRuns(pool, runId);
      const stored = storage.packages.get(verification.evidencePackageRef);
      const manifest = JSON.parse(readFileSync(join(stored, "manifest.json"), "utf8"));

      assert.equal(manifest.subject.head_sha, verification.candidateSha);
      assert.match(manifest.subject.base_sha, /^[0-9a-f]{40}$/);
      assert.notEqual(manifest.subject.base_sha, manifest.subject.head_sha);
      assert.equal(manifest.subject.author.kind, "agent");
      assert.match(manifest.subject.author.agent, /gpt-5-codex/);

      const evidence = JSON.parse(
        readFileSync(join(stored, "evidence", "ev-01.json"), "utf8"),
      );
      assert.equal(
        evidence.environment.runner,
        factoryRunner(runId),
        "not 'local' and not 'github-actions'",
      );
    });
  },
);

test(
  "a failing candidate persists a RepairPacket and does not advance toward PR_CREATING",
  { skip },
  async () => {
    await withVerify(
      async ({ pool, provider, runId }) => {
        await provider.startRun(runId);
        await provider.drain();

        const seen = await transitions(pool, runId);
        assert.ok(!seen.includes("VERIFYING->PR_CREATING"), `unexpected: ${seen.join(", ")}`);
        // The repair loop's entry point. No REPAIRING handler is registered in this suite, so
        // the run parks there — which is the shape a state with no handler has, and is what
        // test/workflow-stages-repair.test.js picks up.
        assert.equal(seen.at(-1), "VERIFYING->REPAIRING");

        const [verification] = await listVerificationRuns(pool, runId);
        assert.equal(verification.verdict, "fail");

        const packets = await listRepairPackets(pool, runId);
        assert.equal(packets.length, 1, "M5's entry point exists and is proven reachable");
        assert.ok(packets[0].review_findings.some((f) => f.id === "REV-1"));
      },
      { review: DIRTY_REVIEW },
    );
  },
);

/**
 * #227's item 3, asserted as a transition rather than argued in a comment.
 *
 * A declared check whose command is not installed makes the verdict `fail` — the gate has no
 * evidence either way and must not pass on an unknown — but there is nothing a repairer could
 * do with it, so the run must not enter the loop. Run `f2455ce2` did, bought one
 * `emptyChange: true` turn, and stopped as `stuck` after one attempt of three.
 *
 * `FAILED` is ADR-0003's existing "infrastructure or worker error the machine cannot route
 * around". `MAX_REPAIR_ATTEMPTS_REACHED` is deliberately not used: that state is reserved for
 * work that "ran and verifiably does not pass, which is signal, not breakage", and this work
 * never ran.
 */
test(
  "a check that could not run stops the run at FAILED instead of buying a repair turn",
  { skip },
  async () => {
    await withVerify(
      async ({ pool, provider, runId }) => {
        await provider.startRun(runId);
        await provider.drain();

        const seen = await transitions(pool, runId);
        assert.equal(seen.at(-1), "VERIFYING->FAILED", `unexpected path: ${seen.join(", ")}`);
        assert.ok(
          !seen.includes("VERIFYING->REPAIRING"),
          "a repair turn that provably cannot help must not be spent",
        );
        assert.ok(!seen.includes("VERIFYING->MAX_REPAIR_ATTEMPTS_REACHED"));

        const [verification] = await listVerificationRuns(pool, runId);
        assert.equal(verification.verdict, "fail");

        /**
         * The packet is still written — it is the record of why the run stopped, and the run
         * report's `taken` flag already distinguishes an attempt nobody took. What changed is
         * what it asks for.
         */
        const [packet] = await listRepairPackets(pool, runId);
        assert.deepEqual(packet.failed_checks, []);
        assert.equal(packet.checks_could_not_run.length, 1);
        assert.equal(packet.checks_could_not_run[0].check, "tests");
        assert.equal(packet.checks_could_not_run[0].exit_code, 127);
        assert.deepEqual(
          packet.recommended_focus,
          [],
          "the maker must not be told to make a missing command exit 0",
        );
      },
      {
        repoFiles: {
          "windkeel.config.json": `${JSON.stringify(
            { checks: [{ name: "tests", command: "windkeel-no-such-command-227" }] },
            null,
            2,
          )}\n`,
        },
      },
    );
  },
);

test("both workspaces are destroyed on the pass path", { skip }, async () => {
  await withVerify(async ({ pool, provider, runId, registry }) => {
    await provider.startRun(runId);
    await provider.drain();

    const workspaces = await listWorkspaces(pool, runId);
    assert.equal(workspaces.length, 2);
    for (const workspace of workspaces) {
      assert.equal(workspace.status, "destroyed", `${workspace.role} was torn down`);
      assert.equal(registry.get(workspace.id), undefined, "and its handle released");
    }
  });
});

/**
 * ADR-0017 changed this one. Before it, a fail verdict destroyed the maker along with the
 * verifier, which is precisely what made ADR-0011 §2's "the session is resumed" unreachable.
 * The verifier still goes — it is finished, and it is the expensive one to leave running.
 */
test(
  "on the fail path the verifier is destroyed and the maker is held for the repair turn",
  { skip },
  async () => {
    await withVerify(
      async ({ pool, provider, runId, registry }) => {
        await provider.startRun(runId);
        await provider.drain();
        const workspaces = await listWorkspaces(pool, runId);
        assert.equal(workspaces.length, 2);
        const byRole = new Map(workspaces.map((w) => [w.role, w]));
        assert.equal(byRole.get("verifier").status, "destroyed");
        assert.equal(byRole.get("maker").status, "ready", "held for the repair turn (ADR-0017)");
        assert.ok(
          registry.get(byRole.get("maker").id),
          "and its handle is still held, or the repair turn could not reach it",
        );
      },
      { review: DIRTY_REVIEW },
    );
  },
);

test("both workspaces are destroyed on the exception path", { skip }, async () => {
  await withVerify(async ({ pool, provider, runId, sandboxes }) => {
    /**
     * A verifier whose sandbox cannot be created: `provisionWorkspace` inserts the row, the
     * provider throws, the row is marked failed and the error propagates out of the stage.
     *
     * This used to be driven by handing the engine an unusable mapping file, which stopped
     * being an exception at all — the engine treats it as an unsatisfied mapping and returns a
     * `fail` verdict. The test kept passing because a fail verdict also tore everything down;
     * ADR-0017 is what exposed it, since a fail now deliberately holds the maker. Forcing the
     * throw at the provider is what makes this test about the exception path again.
     */
    const create = sandboxes.create.bind(sandboxes);
    sandboxes.create = async (options) => {
      if (options.role === "verifier") throw new Error("simulated provider failure");
      return create(options);
    };

    await provider.startRun(runId);
    await provider.drain();

    const workspaces = await listWorkspaces(pool, runId);
    assert.ok(workspaces.length >= 1);
    for (const workspace of workspaces) {
      assert.ok(
        ["destroyed", "teardown_failed", "failed"].includes(workspace.status),
        `${workspace.role} left as ${workspace.status} — a leaked sandbox costs real money`,
      );
    }
  });
});

test("one workspace whose destroy() throws does not leak the other", { skip }, async () => {
  await withVerify(async ({ pool, provider, runId, sandboxes }) => {
    // The maker is provisioned first, so it is first in the teardown loop. Previously the loop
    // used try/finally with no catch, so this throw propagated out of the first iteration and
    // the verifier sandbox was never destroyed — the more expensive leak of the two.
    const create = sandboxes.create.bind(sandboxes);
    let first = true;
    sandboxes.create = async (options) => {
      const handle = await create(options);
      if (first) {
        first = false;
        handle.destroy = async () => {
          throw new Error("simulated destroy failure");
        };
      }
      return handle;
    };

    await provider.startRun(runId);
    await provider.drain();

    const workspaces = await listWorkspaces(pool, runId);
    assert.equal(workspaces.length, 2);
    const byRole = new Map(workspaces.map((w) => [w.role, w.status]));
    assert.equal(byRole.get("maker"), "teardown_failed", "the throwing one is recorded as failed");
    assert.equal(
      byRole.get("verifier"),
      "destroyed",
      "and the other is still torn down rather than leaked",
    );
  });
});

test("a retried VERIFYING job uploads exactly one package", { skip }, async () => {
  await withVerify(async ({ pool, provider, runId, storage }) => {
    await provider.startRun(runId);
    await provider.drain();
    const before = storage.packages.size;

    // At-least-once delivery: the run is at PR_CREATING with no handler, so re-starting it
    // re-delivers a stage job. The guard is a state check on the completed VerificationRun.
    await provider.startRun(runId);
    await provider.drain();

    const verifications = await listVerificationRuns(pool, runId);
    assert.equal(verifications.length, 1, "one VerificationRun row");
    assert.equal(storage.packages.size, before, "and one uploaded package");
  });
});

test(
  "the verifier holds no write credential and its push guard stays armed",
  { skip },
  async () => {
    await withVerify(async ({ sandboxes }) => {
      // The guard is role-scoped, so it is asserted directly against a verifier handle: the
      // capture path is maker-only, and `runInExecutionPhase` refuses a push from a verifier.
      const { bare } = bareFixtureRepo({ test: "true" });
      const handle = await sandboxes.create({ role: "verifier", repoUrl: bare });
      try {
        const { runInExecutionPhase } = await import("../dist/sandbox/lifecycle.js");
        const refused = await runInExecutionPhase(handle, "api.openai.com", [], "git", {
          args: ["push", "origin", "HEAD:refs/heads/whatever"],
        });
        assert.match(refused.error ?? "", /refusing to run a `git push` in a verifier-role sandbox/);
        assert.equal(refused.status, null, "the command never ran");
      } finally {
        await handle.destroy();
      }
    });
  },
);

/**
 * ADR-0014 §1 under ADR-0026 §7: a maker on an organization's key. The verifier sandbox and the
 * maker's install phase never have a key brokered — not the customer's and not Windkeel's — and the
 * maker's rules are the customer's alone, opened by a resolver rather than carried.
 */
test(
  "on a customer maker key, the verifier and the install phase never receive a key",
  { skip },
  async () => {
    const KEY = "sk-or-v1-Vf3kR8tN2qB6mX9cL1pW4zH7jD0gA5sE";
    const pair = generateSecretKeyPair();
    await withVerify(
      async ({ pool, provider, runId, sandboxes }) => {
        const handles = [];
        const realCreate = sandboxes.create.bind(sandboxes);
        sandboxes.create = async (options) => {
          const handle = await realCreate(options);
          handles.push({ options, handle });
          return handle;
        };
        await provider.startRun(runId);
        await provider.drain();

        assert.deepEqual(await transitions(pool, runId), [
          "PROVISIONING->IMPLEMENTING",
          "IMPLEMENTING->VERIFYING",
          "VERIFYING->PR_CREATING",
        ]);
        const maker = handles.find((h) => h.options.role === "maker");
        const verifier = handles.find((h) => h.options.role === "verifier");
        assert.ok(maker && verifier);
        assert.equal(maker.options.operatorModelKey, false, "Windkeel's key is kept off the maker from create");

        const verifierRules = verifier.handle.calls.filter((c) => c.type === "credentialBroker").flatMap((c) => c.rules);
        assert.deepEqual(verifierRules, [], "the verifier has no broker rule at all");

        const makerBrokered = maker.handle.calls.filter((c) => c.type === "credentialBroker");
        assert.ok(makerBrokered.every((c) => c.rules.every((r) => r.domain === "openrouter.ai" && !r.secretEnvVar)));
        const firstBroker = maker.handle.calls.findIndex((c) => c.type === "credentialBroker");
        assert.ok(firstBroker > 0, "a broker rule is applied only once the maker runs");
        // Narrowed to the execution phase first, then brokered (ORQ-15).
        assert.deepEqual(maker.handle.calls[firstBroker - 1].policy.allowedDomains, ["openrouter.ai"]);
        for (const { handle } of handles) {
          for (const call of handle.calls.filter((c) => c.type === "exec")) {
            assert.ok(!JSON.stringify(call.options ?? {}).includes(KEY), `${handle.role}: ${call.command}`);
          }
        }
      },
      {
        config: { secretPrivateKey: pair.privateKey },
        prepare: async ({ pool, runId }) => {
          const { rows } = await pool.query("select id from organization where is_default");
          const credential = await putModelCredential(pool, {
            organizationId: rows[0].id,
            provider: "openrouter",
            label: "team-router",
            value: KEY,
            publicKey: pair.publicKey,
          });
          await pool.query("update engineering_run set model_config = $2 where id = $1", [
            runId,
            {
              version: 1,
              maker: {
                provider: "openrouter",
                vendor: "openai",
                model: "openai/gpt-5-codex",
                credentialId: credential.id,
                credentialLabel: credential.label,
                keySource: "customer",
                source: "organization",
              },
              checker: [],
              resolvedAt: new Date().toISOString(),
              policyIds: [],
            },
          ]);
        },
      },
    );
  },
);

test(
  "with no evidence store the verdict is still recorded, and the missing ref is visible",
  { skip },
  async () => {
    await withVerify(
      async ({ pool, provider, runId }) => {
        await provider.startRun(runId);
        await provider.drain();

        const [verification] = await listVerificationRuns(pool, runId);
        assert.equal(verification.verdict, "pass");
        assert.equal(verification.evidencePackageRef, null);
        assert.equal(verification.evidenceManifestDigest, null);
      },
      { noStorage: true },
    );
  },
);


/**
 * #219: the end of the plumbing. A tool the repo declared and the sandbox did not provide has to
 * reach the *verdict* — not a log line, not a skipped check — or the run says something weaker
 * than the truth while looking identical to a clean one.
 */
test(
  "a declared tool the sandbox could not provide reaches the verdict, with the reason",
  { skip },
  async () => {
    await withVerify(
      async ({ pool, provider, runId, storage }) => {
        await provider.startRun(runId);
        await provider.drain();

        const [verification] = await listVerificationRuns(pool, runId);
        assert.equal(verification.verdict, "fail");
        // The row carries it too, for when the package has been pruned (ADR-0015).
        assert.equal(verification.riskSummary.tools[0].status, "rejected");
        assert.ok(verification.riskSummary.tools[0].detail.includes("URLs or commands"));

        const stored = storage.packages.get(verification.evidencePackageRef);
        const verdict = JSON.parse(readFileSync(join(stored, "verdict.json"), "utf8"));
        assert.deepEqual(verdict.blocking_findings, ["F-tool-https://evil.example.com/tool.sh"]);

        const tools = JSON.parse(readFileSync(join(stored, "evidence", "ev-02.json"), "utf8"));
        assert.equal(tools.type, "tool_install");
        assert.equal(tools.status, "failed");
        assert.equal(tools.tools[0].source, "repository");
        // And the package still recomputes to the verdict it stored.
        const recomputed = runCli(["verify-package", stored]);
        assert.equal(recomputed.code, 0, recomputed.stdout);
        assert.match(recomputed.stdout, /verdict: FAIL/i);
      },
      {
        repoFiles: {
          "windkeel.config.json": JSON.stringify({
            checks: { commands: [{ name: "tests", command: "true" }] },
            tools: ["https://evil.example.com/tool.sh"],
          }),
        },
      },
    );
  },
);

/**
 * ORQ-01: a maker that commits its own work. Its first commit `A` is the one that matters (a
 * payload, and in a real attack the repository's check configuration too); its second, `B`, is
 * innocuous. The verifier used to take `candidate^` as the base — `A`, a commit the maker wrote —
 * so the trusted configuration was the maker's and the reviewer's diff was `A..B`, README only.
 */
class SelfCommittingWorkerAdapter extends MutatingWorkerAdapter {
  constructor(inner, history) {
    super(inner);
    this.history = history;
  }
  async start(input) {
    const sandbox = input.sandbox;
    const git = (...args) =>
      sandbox.exec("git", {
        args: ["-c", "user.name=Maker", "-c", "user.email=maker@example.com", ...args],
        cwd: sandbox.checkoutPath,
      });
    await this.history(sandbox, git);
    return this.inner.start(input);
  }
}

const remoteHead = (remote) =>
  spawnSync("git", ["rev-parse", "HEAD"], { cwd: remote.bare, encoding: "utf8" }).stdout.trim();

test(
  "ORQ-01: a self-committing maker does not choose the base its candidate is verified against",
  { skip },
  async () => {
    const worker = (inner) =>
      new SelfCommittingWorkerAdapter(inner, async (sandbox, git) => {
        await sandbox.writeFile("evil.js", "/* payload */\n");
        await git("add", "-A");
        await git("commit", "-qm", "A: the payload");
        await sandbox.writeFile("README.md", "docs\n");
        await git("add", "-A");
        await git("commit", "-qm", "B: innocuous");
      });

    await withVerify(
      async ({ pool, provider, runId, storage, remote }) => {
        await provider.startRun(runId);
        await provider.drain();

        const base = remoteHead(remote);
        const maker = (await listWorkspaces(pool, runId)).find((w) => w.role === "maker");
        assert.equal(maker.baseSha, base, "the maker row pins the SHA the default branch resolved to");

        const [verification] = await listVerificationRuns(pool, runId);
        const stored = storage.packages.get(verification.evidencePackageRef);
        const manifest = JSON.parse(readFileSync(join(stored, "manifest.json"), "utf8"));
        assert.equal(manifest.subject.base_sha, base, "not the maker's own commit A");

        // And so the diff the reviewer is given spans every maker commit, A included.
        const changed = spawnSync(
          "git",
          ["diff", "--name-only", manifest.subject.base_sha, manifest.subject.head_sha],
          { cwd: remote.bare, encoding: "utf8" },
        ).stdout;
        assert.match(changed, /evil\.js/);
      },
      { worker },
    );
  },
);

test(
  "ORQ-01: a candidate that does not descend from the recorded base fails verification",
  { skip },
  async () => {
    // An orphan history: no diff against the trusted base means anything, so nothing is sealed.
    const worker = (inner) =>
      new SelfCommittingWorkerAdapter(inner, async (sandbox, git) => {
        await git("checkout", "-q", "--orphan", "rewritten");
        await sandbox.writeFile("index.js", "console.log('hello');\n");
        await git("add", "-A");
        await git("commit", "-qm", "a history of the maker's own");
      });

    await withVerify(
      async ({ pool, provider, runId }) => {
        await provider.startRun(runId);
        await provider.drain();

        const seen = await transitions(pool, runId);
        assert.equal(seen.at(-1), "VERIFYING->FAILED", `unexpected path: ${seen.join(", ")}`);
        const { rows } = await pool.query(
          "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'",
          [runId],
        );
        assert.match(rows[0].reason, /does not descend from the run's trusted base/);
        const [verification] = await listVerificationRuns(pool, runId);
        assert.equal(verification.verdict, null, "no verdict for a candidate that could not be placed");
      },
      { worker },
    );
  },
);

/**
 * Codex on #361: the verifier's install is held to the same recorded base. With `candidate^` there,
 * a maker that rewrote `.npmrc` in commit A and committed something innocuous as B made the A..B
 * comparison show no install-configuration change, and the repository's secrets went to an install
 * reading the maker's `.npmrc`.
 */
test(
  "ORQ-01: the verifier's install compares install configuration with the recorded base, not candidate^",
  { skip },
  async () => {
    const pair = generateSecretKeyPair();
    const worker = (inner) =>
      new SelfCommittingWorkerAdapter(inner, async (sandbox, git) => {
        await sandbox.writeFile(".npmrc", "registry=https://attacker.invalid/\n");
        await git("add", "-A");
        await git("commit", "-qm", "A: point the resolver somewhere else");
        await sandbox.writeFile("README.md", "docs\n");
        await git("add", "-A");
        await git("commit", "-qm", "B: innocuous");
      });

    await withVerify(
      async ({ pool, provider, runId }) => {
        await provider.startRun(runId);
        await provider.drain();

        const [verification] = await listVerificationRuns(pool, runId);
        const detail = verification.riskSummary?.dependencies?.detail ?? "";
        assert.match(detail, /WITHHELD/, `the secrets reached the maker's .npmrc: ${detail}`);
        assert.match(detail, /\.npmrc/);
      },
      {
        worker,
        // A lockfile with no dependencies, so an install runs (offline) and holds the secrets.
        repoFiles: {
          "package-lock.json": JSON.stringify({
            name: "fixture",
            version: "0.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: { "": { name: "fixture", version: "0.0.0" } },
          }),
        },
        config: { secretPrivateKey: pair.privateKey },
        prepare: async ({ pool }) => {
          const { rows } = await pool.query("select id from organization where is_default");
          await putRepositorySecret(pool, {
            organizationId: rows[0].id,
            repositoryId: "11111111-1111-1111-1111-111111111111",
            key: "NPM_TOKEN",
            value: "npm_fixture_token_value",
            setBy: "test",
            publicKey: pair.publicKey,
          });
        },
      },
    );
  },
);

/**
 * Codex on #361: a run whose maker was provisioned before the base pin carries only the symbolic
 * name on its row. It is verified against the old expression, the first candidate's parent, rather
 * than failed across a deploy.
 */
test(
  "ORQ-01: a maker row from before the base pin still verifies, against the first candidate's parent",
  { skip },
  async () => {
    let db;
    const worker = (inner) =>
      new (class extends MutatingWorkerAdapter {
        async start(input) {
          // What the pre-pin code left on the row: the revision asked for, not what it resolved to.
          await db.query("update workspace set base_sha = 'HEAD' where role = 'maker'");
          return super.start(input);
        }
      })(inner);

    await withVerify(
      async ({ pool, provider, runId, storage, remote }) => {
        await provider.startRun(runId);
        await provider.drain();

        assert.equal((await transitions(pool, runId)).at(-1), "VERIFYING->PR_CREATING");
        const maker = (await listWorkspaces(pool, runId)).find((w) => w.role === "maker");
        assert.equal(maker.baseSha, "HEAD", "the row really is a legacy one");
        const [verification] = await listVerificationRuns(pool, runId);
        const manifest = JSON.parse(
          readFileSync(join(storage.packages.get(verification.evidencePackageRef), "manifest.json"), "utf8"),
        );
        // The factory's capture made the only candidate commit, so its parent is the remote head.
        assert.equal(manifest.subject.base_sha, remoteHead(remote));
      },
      {
        worker,
        prepare: async ({ pool }) => {
          db = pool;
        },
      },
    );
  },
);
