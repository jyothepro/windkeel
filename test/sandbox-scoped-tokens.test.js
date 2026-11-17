import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { PermissionDeniedError } from "../dist/github/client.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import {
  ROLE_PERMISSIONS,
  SandboxGitCredentials,
  installGitCredential,
} from "../dist/sandbox/git-credentials.js";
import { runInExecutionPhase } from "../dist/sandbox/lifecycle.js";
import { getWorkspace } from "../dist/factory/repositories.js";
import { provisionWorkspace } from "../dist/factory/workspace-service.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { bareFixtureRepo, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * ADR-0014 §2 and §4's verifier row, proved rather than asserted: a verifier holding a
 * `contents: read` token cannot push, and the proof is a *server-side* rejection, not the static
 * argv guard. The fake sandbox mirrors the remote read-only precisely so this is testable
 * without GitHub.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let serial = 0;

const REPOSITORY = { owner: "jyothepro", name: "windkeel-fixture" };

function github() {
  return new FakeGitHubClient({
    repositories: [{ owner: REPOSITORY.owner, name: REPOSITORY.name }],
  });
}

// --- The broker (no database) ---

test("role scoping is what ADR-0014 §2's table says, and it is asserted on the mint request", async () => {
  const client = github();
  const broker = new SandboxGitCredentials(client);

  const maker = await broker.forWorkspace("ws-maker", "maker", REPOSITORY);
  const verifier = await broker.forWorkspace("ws-verifier", "verifier", REPOSITORY);

  assert.equal(maker.permission, "write");
  assert.equal(verifier.permission, "read");
  assert.notEqual(maker.token, verifier.token, "one token per workspace, never shared");

  const mints = client.calls.filter((c) => c.type === "mintInstallationToken");
  assert.deepEqual(mints[0].input.permissions, ROLE_PERMISSIONS.maker);
  assert.deepEqual(mints[1].input.permissions, ROLE_PERMISSIONS.verifier);
  // Least privilege end to end: exactly one repository, asserted on the request.
  for (const mint of mints) {
    assert.deepEqual(mint.input.repository, REPOSITORY);
  }
});

test("two runs on the same repository never share a token", async () => {
  const broker = new SandboxGitCredentials(github());
  const first = await broker.forWorkspace("run-1-maker", "maker", REPOSITORY);
  const second = await broker.forWorkspace("run-2-maker", "maker", REPOSITORY);
  assert.notEqual(first.token, second.token);
});

test("a token is re-minted at the margin, and not before", async () => {
  let now = Date.parse("2026-09-06T12:00:00.000Z");
  const client = new FakeGitHubClient(
    { repositories: [{ owner: REPOSITORY.owner, name: REPOSITORY.name }] },
    { now: () => now, tokenLifetimeMs: 60 * 60 * 1000 },
  );
  const broker = new SandboxGitCredentials(client, { now: () => now });
  const mints = () => client.calls.filter((c) => c.type === "mintInstallationToken").length;

  await broker.forWorkspace("ws", "maker", REPOSITORY);
  await broker.forWorkspace("ws", "maker", REPOSITORY);
  assert.equal(mints(), 1, "a fresh token is reused — no re-mint-every-call regression");

  now += 50 * 60 * 1000; // 10 minutes of life left: outside the 5-minute margin.
  await broker.forWorkspace("ws", "maker", REPOSITORY);
  assert.equal(mints(), 1);

  now += 6 * 60 * 1000; // 4 minutes left: inside the margin.
  await broker.forWorkspace("ws", "maker", REPOSITORY);
  assert.equal(mints(), 2, "re-minted before it could die mid-push");
});

test("a mint that loses the contents permission propagates, with no fallback credential", async () => {
  const client = github();
  client.revokePermission(REPOSITORY, "contents");
  const broker = new SandboxGitCredentials(client);
  await assert.rejects(
    () => broker.forWorkspace("ws", "maker", REPOSITORY),
    PermissionDeniedError,
    "ADR-0009 §6: this fails the run; it does not reach for another credential",
  );
});

// --- The headline: a verifier cannot push ---

test("a verifier's read-only credential is refused by the remote, not by a check in the sandbox", async () => {
  const { bare: remote } = bareFixtureRepo({});
  const broker = new SandboxGitCredentials(github());
  const credential = await broker.forWorkspace("ws-verifier", "verifier", REPOSITORY);
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({
    role: "verifier",
    repoUrl: remote,
    gitCredentials: credential,
  });
  try {
    await handle.exec("sh", { args: ["-c", "echo change >> README.md && git add -A && git -c user.email=a@b -c user.name=a commit -q -m x"] });

    /**
     * The push goes through a **shell one-liner**, which the static argv guard's own doc comment
     * says it cannot see through. That is the point: this is the credential doing the work.
     */
    const sneaky = await handle.exec("sh", { args: ["-c", "git push origin HEAD:refs/heads/x"] });
    assert.notEqual(sneaky.status, 0, "the remote refused it");
    assert.match(
      `${sneaky.stderr}`,
      /contents:read|denied/i,
      "and refused it for the credential's reason",
    );

    // The static guard still refuses the direct form, fast and locally — defence in depth.
    const direct = await runInExecutionPhase(handle, "api.openai.com", [], "git", {
      args: ["push", "origin", "HEAD:refs/heads/x"],
    });
    assert.notEqual(direct.status, 0);
    assert.match(direct.error ?? "", /verifier-role sandbox/);
  } finally {
    await handle.destroy();
  }
});

test("a maker's write credential pushes to the same remote successfully", async () => {
  const { bare: remote } = bareFixtureRepo({});
  const broker = new SandboxGitCredentials(github());
  const credential = await broker.forWorkspace("ws-maker", "maker", REPOSITORY);
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: remote, gitCredentials: credential });
  try {
    await handle.exec("sh", {
      args: ["-c", "echo change >> README.md && git add -A && git -c user.email=a@b -c user.name=a commit -q -m x"],
    });
    const pushed = await handle.exec("git", { args: ["push", "origin", "HEAD:refs/heads/windkeel/x"] });
    assert.equal(pushed.status, 0, `the maker may write: ${pushed.stderr}`);
  } finally {
    await handle.destroy();
  }
});

// --- Secret hygiene ---

test("the token reaches the sandbox as a file, never as an argument", async () => {
  const { bare: remote } = bareFixtureRepo({});
  const broker = new SandboxGitCredentials(github());
  const credential = await broker.forWorkspace("ws", "maker", REPOSITORY);
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: remote, gitCredentials: credential });
  try {
    const credentialPath = await installGitCredential(handle, "github.com", credential);
    const stored = (await handle.readFile(credentialPath)).toString("utf8");
    assert.match(stored, new RegExp(credential.token));

    /**
     * Outside the checkout, because the candidate capture runs `git add -A` before it commits.
     * A credential file inside the worktree is a live installation token staged, committed and
     * pushed to the repository it grants write access to.
     */
    assert.ok(
      !credentialPath.startsWith(handle.checkoutPath),
      `the credential file must live outside the checkout; got ${credentialPath} under ${handle.checkoutPath}`,
    );

    // Nothing that carried the token appeared in an exec's argv — where it would land in the
    // sandbox's own process listing, readable by the untrusted code it is being kept from.
    for (const call of handle.calls) {
      if (call.type !== "exec") continue;
      const argv = [call.command, ...(call.options?.args ?? [])].join(" ");
      assert.ok(!argv.includes(credential.token), `token leaked into argv: ${argv}`);
    }
  } finally {
    await handle.destroy();
  }
});

// --- Provisioning (Postgres-gated) ---

async function withSchema(fn) {
  const schema = `windkeel_tokens_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

async function seedRun(pool) {
  const repository = await upsertRepository(pool, {
    ...REPOSITORY,
    defaultBranch: "main",
    cloneUrl: "https://github.com/jyothepro/windkeel-fixture.git",
    githubInstallationId: 42,
  });
  const task = await insertEngineeringTask(pool, {
    repositoryId: repository.id,
    sourceType: "github_issue",
    sourceReference: "jyothepro/windkeel-fixture#7",
    title: "t",
    description: "d",
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
  return run;
}

test("provisioning records the token's expiry and never its value", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await seedRun(pool);
    const { bare: remote } = bareFixtureRepo({});
    const broker = new SandboxGitCredentials(github());
    const { workspace, handle } = await provisionWorkspace(pool, new FakeSandboxProvider(), {
      engineeringRunId: run.id,
      role: "maker",
      repository: remote,
      baseSha: "HEAD",
      gitCredentials: { broker, repository: REPOSITORY, host: "github.com" },
    });
    try {
      const stored = await getWorkspace(pool, workspace.id);
      assert.ok(stored.gitTokenExpiresAt instanceof Date, "the expiry is recorded");

      // A token in Postgres outlives the sandbox it was scoped to. Assert on the whole row.
      // Read from the broker rather than the sandbox's credential file: the file lives outside
      // the checkout at a path the handle chooses, and the broker's cache holds the same token.
      const { token } = await broker.forWorkspace(workspace.id, "maker", REPOSITORY);
      const { rows } = await pool.query("select * from workspace where id = $1", [workspace.id]);
      assert.ok(!JSON.stringify(rows[0]).includes(token), "no token value in the workspace row");
      const events = await pool.query("select * from cost_event");
      assert.ok(!JSON.stringify(events.rows).includes(token), "nor in the cost ledger");
    } finally {
      await handle.destroy();
    }
  });
});

test("a workspace whose token cannot be minted fails, and the row says so", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await seedRun(pool);
    const client = github();
    client.revokePermission(REPOSITORY, "contents");
    const broker = new SandboxGitCredentials(client);

    await assert.rejects(
      () =>
        provisionWorkspace(pool, new FakeSandboxProvider(), {
          engineeringRunId: run.id,
          role: "maker",
          repository: bareFixtureRepo({}).bare,
          baseSha: "HEAD",
          gitCredentials: { broker, repository: REPOSITORY, host: "github.com" },
        }),
      PermissionDeniedError,
    );
    const { rows } = await pool.query("select status from workspace where engineering_run_id = $1", [
      run.id,
    ]);
    assert.equal(rows[0].status, "failed", "an auditable row, not a silent absence");
  });
});

test("the hermetic path provisions with no credential at all", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await seedRun(pool);
    const { workspace, handle } = await provisionWorkspace(pool, new FakeSandboxProvider(), {
      engineeringRunId: run.id,
      role: "maker",
      repository: bareFixtureRepo({}).bare,
      baseSha: "HEAD",
    });
    try {
      const stored = await getWorkspace(pool, workspace.id);
      assert.equal(
        stored.gitTokenExpiresAt,
        null,
        "null means no token was ever minted — different from one that expired",
      );
    } finally {
      await handle.destroy();
    }
  });
});
