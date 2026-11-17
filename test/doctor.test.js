/**
 * `windkeel doctor`, driven entirely through its seams.
 *
 * **Every check in this file is exercised only against stubs.** That is not a shortcut, it is
 * the situation: the command reaches about a dozen external services and the first opportunity
 * to run it against reality is the very run it exists to precede (#176). So the seams *are* the
 * test surface, and the things worth asserting are the ones that decide whether an operator can
 * trust the report:
 *
 * - a failing check is a failed check, not a failed report;
 * - a skipped check never reads as a passed one;
 * - the sandbox is destroyed even when what runs inside it throws;
 * - an over-granted installation fails, not only an under-granted one;
 * - **no secret value reaches the output**, on the success paths and the failure paths alike.
 *
 * The secret test is the one that would be embarrassing to be missing. Every check here is
 * holding a credential and every check wants to explain itself, so the assertion is made against
 * sentinel values planted in the configuration and searched for in the rendered report — rather
 * than against a list of places a value is known not to appear, which only ever proves the
 * places somebody thought of.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ADR_0009_PERMISSIONS,
  checkAppPermissions,
  checkConfiguration,
  checkMigrations,
  checkModelEndpoints,
  checkObjectStore,
  checkPostgres,
  sessionPoolerNote,
  checkSandbox,
  checkTokenScoping,
  collectConfigProblems,
  comparePermissions,
  formatDoctorReport,
  repositoryFromUrl,
  runDoctor,
  SecretRegistry,
} from "../dist/commands/doctor.js";
import { generateSecretKeyPair, sealSecret } from "../dist/factory/secret-box.js";
import { repoRoot } from "./helpers.js";
import { PINNED_CODEX_VERSION } from "../dist/worker/codex/adapter.js";

/** Any uuid; the check only slices it for the report. */
const REPO_UUID = "11111111-1111-1111-1111-111111111111";

// --- Sentinel secrets, planted so their appearance anywhere is unambiguous ----------------

const SECRETS = {
  databasePassword: "sentinel-db-password-8f21",
  privateKey: "sentinel-private-key-material-3a9c",
  webhookSecret: "sentinel-webhook-secret-71bd",
  openaiKey: "sentinel-openai-key-4e02",
  anthropicKey: "sentinel-anthropic-key-9c77",
  s3Access: "sentinel-s3-access-2d40",
  s3Secret: "sentinel-s3-secret-6b18",
  vercelToken: "sentinel-vercel-token-0af3",
  mintedToken: "sentinel-minted-installation-token-5510",
};

function env(overrides = {}) {
  return {
    DATABASE_URL: `postgresql://windkeel:${SECRETS.databasePassword}@db.example.com:5432/windkeel`,
    WINDKEEL_REPOSITORY_URL: "https://github.com/jyothepro/windkeel-fixture.git",
    OPENAI_API_KEY: SECRETS.openaiKey,
    ANTHROPIC_API_KEY: SECRETS.anthropicKey,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: SECRETS.privateKey,
    GITHUB_WEBHOOK_SECRET: SECRETS.webhookSecret,
    S3_BUCKET: "evidence",
    S3_ENDPOINT: "https://storage.example.com",
    S3_ACCESS_KEY_ID: SECRETS.s3Access,
    S3_SECRET_ACCESS_KEY: SECRETS.s3Secret,
    VERCEL_TOKEN: SECRETS.vercelToken,
    VERCEL_TEAM_ID: "team_1",
    VERCEL_PROJECT_ID: "prj_1",
    ...overrides,
  };
}

// --- Stub backings -------------------------------------------------------------------------

/** A `pg` pool whose two clients answer whatever the scenario says. */
function stubPool({
  pids = [11, 11],
  lock = true,
  unlock = true,
  migrations = null,
  queryError = null,
  secrets = [],
  credentials = [],
  snapshots = { total: 0, customer: 0 },
  security = {},
} = {}) {
  let pidCall = 0;
  const client = {
    async query(sql) {
      if (sql.includes("pg_backend_pid")) return { rows: [{ pid: pids[pidCall++] ?? pids[0] }] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: lock }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: unlock }] };
      throw new Error(`unexpected client query: ${sql}`);
    },
    release() {},
  };
  return {
    async connect() {
      return client;
    },
    async query(sql) {
      if (queryError) throw new Error(queryError);
      if (sql.includes("schema_migrations")) {
        return { rows: (migrations ?? allMigrationFilenames()).map((filename) => ({ filename })) };
      }
      // The repository-secrets check reads this table. `secrets` defaults to none, which is the
      // deployment most of this file describes: no key pair, no stored secrets, check skipped.
      if (sql.includes("repository_secret")) return { rows: secrets };
      // The model-credentials check (M9-7): status counts, then recent runs' snapshots. A table
      // that isn't there yet is Postgres's 42P01.
      if (sql.includes("model_credential")) {
        if (credentials === "missing") throw Object.assign(new Error('relation "model_credential" does not exist'), { code: "42P01" });
        return { rows: credentials };
      }
      if (sql.includes("model_config")) return { rows: [snapshots] };
      // The security-controls check (#393 8F): one row of counts. A table not there yet is 42P01.
      if (sql.includes("security_controls")) {
        if (security === "missing") throw Object.assign(new Error('relation "audit_event" does not exist'), { code: "42P01" });
        return { rows: [{ tokens_without_expiry: 0, bootstrap_events: 0, sink_failing: 0, verified_recent: 0, unsigned_recent: 0, ...security }] };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async end() {},
  };
}

function allMigrationFilenames() {
  // The real directory, so "up to date" means up to date with what ships.
  return readdirSync(join(repoRoot, "migrations")).filter((n) => n.endsWith(".sql")).sort();
}

class StubStorage {
  constructor({ readsBack = true, throwOn = null } = {}) {
    this.readsBack = readsBack;
    this.throwOn = throwOn;
    this.calls = [];
  }
  async putPackage(dir, bucket, key) {
    this.calls.push(["put", bucket, key]);
    if (this.throwOn === "put") throw new Error("bucket refused the write");
  }
  async listPackage(bucket, key) {
    this.calls.push(["list", bucket, key]);
    return this.readsBack ? [`${key}/probe.txt`] : [];
  }
  async deletePackage(bucket, key) {
    this.calls.push(["delete", bucket, key]);
  }
}

function stubGitHub({ permissions = ADR_0009_PERMISSIONS, tokens = null, throwOn = null } = {}) {
  const minted = [];
  return {
    minted,
    name: "stub",
    async getRepository() {
      if (throwOn === "getRepository") throw new Error("boom");
      return { owner: "jyothepro", name: "windkeel-fixture", permissions };
    },
    async mintInstallationToken(input) {
      minted.push(input);
      const role = input.permissions.contents === "write" ? "maker" : "verifier";
      return {
        token: tokens?.[role] ?? `${SECRETS.mintedToken}-${role}`,
        expiresAt: "2026-09-07T13:00:00Z",
        repository: input.repository,
        permissions: input.permissions,
      };
    },
  };
}

function stubSandbox({ execStatus = 0, execStdout = `codex-cli ${PINNED_CODEX_VERSION}`, createThrows = false, execThrows = false, destroyThrows = false } = {}) {
  const events = [];
  const provider = {
    name: "stub-vercel",
    capabilities: { credentialBrokering: true, phasedEgress: true },
    async create() {
      events.push("create");
      if (createThrows) throw new Error("no capacity");
      return {
        id: "sbx_1",
        role: "verifier",
        checkoutPath: "/repo",
        async exec() {
          events.push("exec");
          if (execThrows) throw new Error("the exec inside the sandbox threw");
          return { status: execStatus, signal: null, stdout: execStdout, stderr: "" };
        },
        async destroy() {
          events.push("destroy");
          if (destroyThrows) throw new Error("destroy failed");
        },
      };
    },
  };
  return { provider, events };
}

function stubEnvironment(overrides = {}) {
  const storage = overrides.storageStub ?? new StubStorage();
  const github = overrides.githubStub ?? stubGitHub();
  const sandbox = overrides.sandboxStub ?? stubSandbox();
  return {
    environment: {
      env: overrides.env ?? env(),
      migrationsDir: join(repoRoot, "migrations"),
      async connect() {
        return overrides.pool ?? stubPool();
      },
      storage: () => storage,
      github: () => github,
      sandboxes: () => (overrides.noSandbox ? null : sandbox.provider),
      fetch: overrides.fetch ?? (async () => ({ ok: true, status: 200 })),
      ...(overrides.repository ? { repository: overrides.repository } : {}),
    },
    storage,
    github,
    sandbox,
  };
}

const tempPackage = async () => join(repoRoot, "test", "fixtures");

// --- 1. Configuration: every problem, not the first --------------------------------------

test("the configuration check reports every problem, not just the first", () => {
  const broken = env();
  delete broken.DATABASE_URL;
  delete broken.WINDKEEL_REPOSITORY_URL;
  delete broken.OPENAI_API_KEY;
  broken.WINDKEEL_RAILS_CHECK_INTERVAL_MS = "soon";

  const { problems } = collectConfigProblems(broken);
  const named = problems.map((p) => p.variable).sort();
  assert.deepEqual(named, [
    "DATABASE_URL",
    "WINDKEEL_RAILS_CHECK_INTERVAL_MS",
    "WINDKEEL_REPOSITORY_URL",
    "OPENAI_API_KEY",
  ].sort());

  // Unlike a container start, the point here is to hand back a complete list — an operator
  // fixing one variable at a time across four restarts is exactly what this replaces.
  const { result } = checkConfiguration(broken);
  assert.equal(result.status, "fail");
  assert.equal(result.details.length, 4);
  for (const name of named) assert.ok(result.details.some((d) => d.includes(name)));
});

test("a valid configuration passes, and startup warnings ride along without failing it", () => {
  const { result, config } = checkConfiguration(env({ S3_BUCKET: "", ANTHROPIC_API_KEY: "" }));
  assert.equal(result.status, "pass");
  assert.ok(config);
  // Legal but probably not intended: reported, not failed. `configWarnings` already draws that
  // line for the container and this check does not redraw it.
  assert.ok(result.details.some((d) => d.includes("S3_BUCKET")));
  assert.ok(result.details.some((d) => d.includes("ANTHROPIC_API_KEY")));
});

test("a configuration that will not load skips everything below it, saying so", async () => {
  const broken = env();
  delete broken.DATABASE_URL;
  const { environment } = stubEnvironment({ env: broken });

  const { report } = await runDoctor(environment, tempPackage);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "fail");
  for (const result of report.results.slice(1)) {
    assert.equal(result.status, "skip");
    assert.match(result.summary, /configuration did not load/);
    assert.ok(result.details.some((d) => d.includes("Nothing below this line has been checked")));
  }
});

// --- 2. Postgres --------------------------------------------------------------------------

test("a direct session-mode connection with migrations applied passes", async () => {
  const { environment } = stubEnvironment();
  const { config } = checkConfiguration(environment.env);
  const result = await checkPostgres(environment, config);
  assert.equal(result.status, "pass");
  assert.match(result.summary, /session-mode connection/);
});

test("a transaction pooler is caught by a changing backend pid", async () => {
  const { environment } = stubEnvironment({ pool: stubPool({ pids: [11, 12] }) });
  const { config } = checkConfiguration(environment.env);
  const result = await checkPostgres(environment, config);
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("different backends")));
});

test("a pooler that loses session state is caught by the advisory lock round trip", async () => {
  const { environment } = stubEnvironment({ pool: stubPool({ unlock: false }) });
  const { config } = checkConfiguration(environment.env);
  const result = await checkPostgres(environment, config);
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("did not survive to its own unlock")));
});

test("the transaction pooler's port is reported as a hint, and labelled as one", async () => {
  const pooled = env({
    DATABASE_URL: `postgresql://windkeel:${SECRETS.databasePassword}@aws-0-eu.pooler.supabase.com:6543/windkeel`,
  });
  const { environment } = stubEnvironment({ env: pooled });
  const { config } = checkConfiguration(pooled);
  const result = await checkPostgres(environment, config);
  assert.equal(result.status, "fail");
  const hint = result.details.find((d) => d.includes("transaction pooler (port 6543)"));
  assert.ok(hint);
  assert.match(hint, /hint from the URL; the functional signals above are what decide/);
});

/**
 * The regression this pair exists to stop. Supabase's direct host is IPv6-only, so a deployment
 * without IPv4 reaches Postgres through Supavisor's **session** mode on 5432 — which ADR-0008 §1
 * is satisfied by, and which preserves the session state and advisory locks the two functional
 * signals test for. The check used to fail it on the hostname alone, telling an operator their
 * working configuration was broken. A check that does that gets ignored, including when it is
 * right.
 */
test("session mode through the pooler passes, and says so", async () => {
  const sessionPooled = env({
    DATABASE_URL: `postgresql://windkeel:${SECRETS.databasePassword}@aws-0-eu.pooler.supabase.com:5432/windkeel`,
  });
  const { environment } = stubEnvironment({ env: sessionPooled });
  const { config } = checkConfiguration(sessionPooled);
  const result = await checkPostgres(environment, config);

  assert.equal(result.status, "pass", "the hostname alone is not a failure");
  const note = result.details.find((d) => d.includes("Supavisor session mode"));
  assert.ok(note, "and the operator is told it was seen rather than left wondering");
  assert.match(note, /ADR-0008 §1 is satisfied/);
});

test("the pooler note is only for session mode, never for the transaction pooler", () => {
  const host = "aws-0-eu.pooler.supabase.com";
  assert.ok(sessionPoolerNote(`postgresql://u:p@${host}:5432/windkeel`));
  assert.equal(sessionPoolerNote(`postgresql://u:p@${host}:6543/windkeel`), null);
  assert.equal(sessionPoolerNote("postgresql://u:p@db.example.supabase.co:5432/windkeel"), null);
  assert.equal(sessionPoolerNote("not a url"), null);
});

// --- 2b. Migrations (#337) ----------------------------------------------------------------

test("migrations: every file applied passes", async () => {
  const { environment } = stubEnvironment();
  const { config } = checkConfiguration(environment.env);
  const result = await checkMigrations(environment, config);
  assert.equal(result.id, "migrations");
  assert.equal(result.status, "pass");
  assert.match(result.summary, new RegExp(`all ${allMigrationFilenames().length} migration`));
});

test("migrations: unapplied files fail the check, each named", async () => {
  const { environment } = stubEnvironment({ pool: stubPool({ migrations: ["0001_factory_schema.sql"] }) });
  const { config } = checkConfiguration(environment.env);
  const result = await checkMigrations(environment, config);
  assert.equal(result.status, "fail");
  const latest = allMigrationFilenames().at(-1);
  assert.match(result.summary, new RegExp(latest.replace(".", "\\.")));
  assert.ok(result.details.includes(`pending: ${latest}`));
  assert.ok(!result.details.includes("pending: 0001_factory_schema.sql"), "an applied file is not pending");
  assert.ok(result.details.some((d) => d.includes("npm run db:migrate")));
});

test("migrations: a pending schema is not a Postgres connection failure", async () => {
  const { environment } = stubEnvironment({ pool: stubPool({ migrations: ["0001_factory_schema.sql"] }) });
  const { config } = checkConfiguration(environment.env);
  assert.equal((await checkPostgres(environment, config)).status, "pass");
});

test("migrations: a database with no schema_migrations has every file pending", async () => {
  const pool = stubPool();
  const query = pool.query;
  pool.query = async (sql) => {
    if (sql.includes("schema_migrations")) {
      throw Object.assign(new Error('relation "schema_migrations" does not exist'), { code: "42P01" });
    }
    return query(sql);
  };
  const { environment } = stubEnvironment({ pool });
  const { config } = checkConfiguration(environment.env);
  const result = await checkMigrations(environment, config);
  assert.equal(result.status, "fail");
  assert.equal(result.details.filter((d) => d.startsWith("pending: ")).length, allMigrationFilenames().length);
});

// --- 3. Object store ----------------------------------------------------------------------

test("the object store check writes, reads back, and always deletes", async () => {
  const storage = new StubStorage();
  const { environment } = stubEnvironment({ storageStub: storage });
  const { config } = checkConfiguration(environment.env);

  const result = await checkObjectStore(environment, config, tempPackage);
  assert.equal(result.status, "pass");
  assert.deepEqual(
    storage.calls.map((c) => c[0]),
    ["put", "list", "delete"],
    "read-back is the point: a bucket that writes and does not serve looks like a working one",
  );
});

test("a bucket that accepts writes and serves nothing fails", async () => {
  const storage = new StubStorage({ readsBack: false });
  const { environment } = stubEnvironment({ storageStub: storage });
  const { config } = checkConfiguration(environment.env);
  const result = await checkObjectStore(environment, config, tempPackage);
  assert.equal(result.status, "fail");
});

test("a failed write still deletes, so a real bucket is not left with litter", async () => {
  const storage = new StubStorage({ throwOn: "put" });
  const { environment } = stubEnvironment({ storageStub: storage });
  const { config } = checkConfiguration(environment.env);
  await assert.rejects(() => checkObjectStore(environment, config, tempPackage));
  assert.ok(storage.calls.some((c) => c[0] === "delete"));
});

test("no object store configured is skipped with the consequence stated, never passed", async () => {
  const { environment } = stubEnvironment({ env: env({ S3_BUCKET: "" }) });
  const { config } = checkConfiguration(environment.env);
  const result = await checkObjectStore(environment, config, tempPackage);
  assert.equal(result.status, "skip");
  assert.match(result.details.join(" "), /evidence_package_ref will stay null/);
});

// --- 4. Permissions, in both directions ---------------------------------------------------

test("an installation granting exactly ADR-0009's set passes", async () => {
  const result = await checkAppPermissions(stubGitHub(), { owner: "o", name: "r" });
  assert.equal(result.status, "pass");
});

test("an under-granted installation fails and names what is missing", async () => {
  const { checks, ...withoutChecks } = ADR_0009_PERMISSIONS;
  const result = await checkAppPermissions(
    stubGitHub({ permissions: withoutChecks }),
    { owner: "o", name: "r" },
  );
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.startsWith("checks:")));
});

test("an OVER-granted installation fails too, and says why an over-grant buys nothing", async () => {
  // The direction that is easy to forget: a run fails loudly on a missing permission rather
  // than degrading, so extra access only widens what a compromised installation could reach.
  const result = await checkAppPermissions(
    stubGitHub({ permissions: { ...ADR_0009_PERMISSIONS, administration: "write" } }),
    { owner: "o", name: "r" },
  );
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("administration")));
  assert.ok(result.details.some((d) => d.includes("over-broad grant buys nothing")));
});

test("comparePermissions reports a widened read as an over-grant", () => {
  const { missing, extra } = comparePermissions({ ...ADR_0009_PERMISSIONS, metadata: "write" });
  assert.deepEqual(missing, []);
  assert.equal(extra.length, 1);
  assert.match(extra[0], /metadata/);
});

// --- 5. Per-role scoping ------------------------------------------------------------------

test("maker and verifier tokens are minted with different scopes, and differ", async () => {
  const github = stubGitHub();
  const result = await checkTokenScoping(github, { owner: "o", name: "r" }, new SecretRegistry());
  assert.equal(result.status, "pass");
  assert.deepEqual(
    github.minted.map((m) => m.permissions),
    [{ contents: "write" }, { contents: "read" }],
  );
});

test("a verifier token that can write fails — that is the property verification rests on", async () => {
  const github = {
    ...stubGitHub(),
    async mintInstallationToken(input) {
      return {
        token: `${SECRETS.mintedToken}-${input.permissions.contents}`,
        expiresAt: "2026-09-07T13:00:00Z",
        repository: input.repository,
        // GitHub granting more than was asked for: what the check exists to notice.
        permissions: { contents: "write" },
      };
    },
  };
  const result = await checkTokenScoping(github, { owner: "o", name: "r" }, new SecretRegistry());
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("verifier")));
});

test("both roles handed the same token fails", async () => {
  const github = stubGitHub({ tokens: { maker: "same-token-value", verifier: "same-token-value" } });
  const result = await checkTokenScoping(github, { owner: "o", name: "r" }, new SecretRegistry());
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("same token")));
});

// --- 6. Model endpoints -------------------------------------------------------------------

test("two reachable endpoints from different vendors pass", async () => {
  const { environment } = stubEnvironment();
  const { config } = checkConfiguration(environment.env);
  const result = await checkModelEndpoints(environment, config);
  assert.equal(result.status, "pass");
});

test("maker and checker sharing a vendor fails, whatever the endpoints say", async () => {
  const shared = env({ WINDKEEL_MAKER_VENDOR: "anthropic" });
  const { environment } = stubEnvironment({ env: shared });
  const { config } = checkConfiguration(shared);
  const result = await checkModelEndpoints(environment, config);
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("ADR-0010 requires")));
});

test("a rejected key fails with the status and never the key", async () => {
  const { environment } = stubEnvironment({
    fetch: async () => ({ ok: false, status: 401 }),
  });
  const { config } = checkConfiguration(environment.env);
  const result = await checkModelEndpoints(environment, config);
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("401")));
  assert.ok(!result.details.join(" ").includes(SECRETS.openaiKey));
});

test("no checker configured is skipped with its consequence, not passed", async () => {
  const solo = env({ ANTHROPIC_API_KEY: "" });
  const { environment } = stubEnvironment({ env: solo });
  const { config } = checkConfiguration(solo);
  const result = await checkModelEndpoints(environment, config);
  assert.equal(result.status, "skip");
  assert.match(result.details.join(" "), /independence property cannot be asserted/);
});

// --- 7. Sandbox ---------------------------------------------------------------------------

test("the sandbox check creates, execs, and destroys", async () => {
  const sandbox = stubSandbox();
  const { environment } = stubEnvironment({ sandboxStub: sandbox });
  const { config } = checkConfiguration(environment.env);
  const result = await checkSandbox(environment, config);
  assert.equal(result.status, "pass");
  assert.deepEqual(sandbox.events, ["create", "exec", "destroy"]);
});

test("the sandbox is destroyed even when the exec inside it throws", async () => {
  // A leaked sandbox bills until expires_at with no process able to reach it — SandboxProvider
  // has no attach(). This is the assertion that keeps the teardown in a finally.
  const sandbox = stubSandbox({ execThrows: true });
  const { environment } = stubEnvironment({ sandboxStub: sandbox });
  const { config } = checkConfiguration(environment.env);
  const result = await checkSandbox(environment, config);
  assert.equal(result.status, "fail");
  assert.deepEqual(sandbox.events, ["create", "exec", "destroy"]);
});

test("a failed teardown is reported loudly rather than swallowed", async () => {
  const sandbox = stubSandbox({ destroyThrows: true });
  const { environment } = stubEnvironment({ sandboxStub: sandbox });
  const { config } = checkConfiguration(environment.env);
  const result = await checkSandbox(environment, config);
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("NOT DESTROYED")));
});

test("a codex version that does not match the pin is a finding", async () => {
  const sandbox = stubSandbox({ execStdout: "codex-cli 0.1.0" });
  const { environment } = stubEnvironment({ sandboxStub: sandbox });
  const { config } = checkConfiguration(environment.env);
  const result = await checkSandbox(environment, config);
  assert.equal(result.status, "fail");
  assert.ok(result.details.some((d) => d.includes("0.1.0")));
  assert.deepEqual(sandbox.events, ["create", "exec", "destroy"]);
});

test("no sandbox provider is skipped with the consequence, never passed", async () => {
  const { environment } = stubEnvironment({ noSandbox: true });
  const { config } = checkConfiguration(environment.env);
  const result = await checkSandbox(environment, config);
  assert.equal(result.status, "skip");
  assert.match(result.details.join(" "), /ADR-0016 local mode/);
});

// --- Independence, exit code, and the report ----------------------------------------------

test("a check that throws becomes one failed check, not a failed report", async () => {
  const { environment } = stubEnvironment({ githubStub: stubGitHub({ throwOn: "getRepository" }) });
  const { report } = await runDoctor(environment, tempPackage);

  const permissions = report.results.find((r) => r.id === "github-permissions");
  assert.equal(permissions.status, "fail");
  assert.match(permissions.summary, /the check itself failed/);
  assert.ok(
    permissions.details.some((d) => d.includes("never been run against a real deployment")),
    "the command's own failure modes have to be legible: it is unproven against reality",
  );
  // And every other check still ran and reported. Seven since #199 added the workflow-backing
  // check, eight since M9-7 added model credentials, nine since #337 split out migrations, ten
  // since #393 added security controls, eleven since #394 added billing; the
  // number is asserted rather than the shape so that adding a check is a deliberate edit here
  // rather than something that slips past.
  assert.equal(report.results.filter((r) => r.status === "pass").length, 11);
});

test("all green is ok; one failure is not; skips alone are still ok", async () => {
  const green = await runDoctor(stubEnvironment().environment, tempPackage);
  assert.equal(green.report.ok, true);
  /**
   * Every check that applies passes. Two do not apply here, and both skip rather than passing
   * for something that was never looked at:
   *
   * - the deployment check (#213), because pg-boss is carried by a process, not a deployment;
   * - the delivery check (#229), because this environment's `GITHUB_APP_PRIVATE_KEY` is a
   *   sentinel string rather than a PEM, so the App JWT cannot be minted. That is the
   *   configuration check's finding to report, and this one declines to report it twice.
   * - the repository-secrets check, because this environment has no key pair and no stored
   *   secrets. That is a legitimate deployment rather than a gap, and passing a check for
   *   something nobody configured is what this whole file exists to prevent.
   * - the integrations check (#389), because this environment switches no intake integration on;
   *   each is optional, and "off" is not a pass.
   */
  const inapplicable = ["workflow-deployment", "github-deliveries", "repository-secrets", "integrations"];
  assert.ok(green.report.results.every((r) => r.status === "pass" || inapplicable.includes(r.id)));
  for (const id of inapplicable) {
    assert.equal(green.report.results.find((r) => r.id === id).status, "skip", id);
  }

  const skipped = await runDoctor(
    stubEnvironment({
      env: env({ S3_BUCKET: "", ANTHROPIC_API_KEY: "" }),
      noSandbox: true,
    }).environment,
    tempPackage,
  );
  assert.equal(skipped.report.ok, true, "a legitimately skipped check does not fail the command");
  // Three deliberate skips, plus the deployment check pg-boss does not need, the delivery check
  // that cannot mint a JWT from this environment's sentinel key, and the repository-secrets check
  // this environment has neither a key pair nor a stored secret for, and the integrations check
  // (#389) with no integration switched on.
  assert.equal(skipped.report.results.filter((r) => r.status === "skip").length, 7);

  const failed = await runDoctor(
    stubEnvironment({ pool: stubPool({ pids: [1, 2] }) }).environment,
    tempPackage,
  );
  assert.equal(failed.report.ok, false);
});

test("the rendered report never lets a skip read as a pass", async () => {
  const { report, secrets } = await runDoctor(
    stubEnvironment({ env: env({ S3_BUCKET: "" }) }).environment,
    tempPackage,
  );
  const rendered = formatDoctorReport(report, secrets);
  assert.match(rendered, /^SKIP {2}Evidence object store/m);
  assert.match(rendered, /A skipped check has not passed/);
  // The object store's skip, the deployment check pg-boss does not need, the delivery check that
  // cannot mint a JWT from this environment's sentinel key, and repository secrets, which this
  // environment has neither a key pair nor a stored secret for, and the integrations check (#389),
  // which nothing here switches on.
  assert.match(rendered, /5 skipped/);
});

test("GITHUB_APP_ID unset skips the two App checks with the consequence stated", async () => {
  const hermetic = env();
  delete hermetic.GITHUB_APP_ID;
  const { report } = await runDoctor(stubEnvironment({ env: hermetic }).environment, tempPackage);
  for (const id of ["github-permissions", "github-scoping"]) {
    const result = report.results.find((r) => r.id === id);
    assert.equal(result.status, "skip");
    assert.match(result.details.join(" "), /hermetic mode/);
  }
});

test("a repository URL that is not github.com skips the App checks rather than guessing", async () => {
  const elsewhere = env({ WINDKEEL_REPOSITORY_URL: "/local/bare/repo.git" });
  const { report } = await runDoctor(stubEnvironment({ env: elsewhere }).environment, tempPackage);
  const result = report.results.find((r) => r.id === "github-permissions");
  assert.equal(result.status, "skip");
  assert.match(result.details.join(" "), /--repository owner\/name/);
});

// --- Repository secrets ---------------------------------------------------------------------

test("stored secrets with no private key here is a failure, not a skip", async () => {
  const { environment } = stubEnvironment({
    pool: stubPool({ secrets: [{ key: "NPM_TOKEN", sealed_value: "x", repository_id: REPO_UUID }] }),
  });
  const { report } = await runDoctor(environment, tempPackage);
  const result = report.results.find((r) => r.id === "repository-secrets");
  assert.equal(
    result.status,
    "fail",
    "every install would run without this credential and fail with the registry's own error",
  );
  assert.match(result.summary, /no WINDKEEL_SECRET_PRIVATE_KEY/);
  assert.equal(report.ok, false);
});

test("a secret sealed to another key pair is named rather than silently dropped", async () => {
  const mine = generateSecretKeyPair();
  const theirs = generateSecretKeyPair();
  const { environment } = stubEnvironment({
    env: env({ WINDKEEL_SECRET_PRIVATE_KEY: mine.privateKey }),
    pool: stubPool({
      secrets: [
        { key: "GOOD", sealed_value: sealSecret(mine.publicKey, "GOOD", "v"), repository_id: REPO_UUID },
        { key: "STALE", sealed_value: sealSecret(theirs.publicKey, "STALE", "v"), repository_id: REPO_UUID },
      ],
    }),
  });
  const { report, secrets } = await runDoctor(environment, tempPackage);
  const result = report.results.find((r) => r.id === "repository-secrets");
  assert.equal(result.status, "fail");
  assert.match(result.details.join(" "), /STALE/);
  assert.ok(
    !result.details.join(" ").includes("GOOD"),
    "only the ones that failed are named; listing the healthy ones buries the finding",
  );
  // And no part of a key or a ciphertext is rendered, on a path that handles both.
  const rendered = formatDoctorReport(report, secrets);
  assert.ok(!rendered.includes(mine.privateKey));
  assert.ok(!rendered.includes(theirs.privateKey));
});

test("secrets that all open pass with the count", async () => {
  const pair = generateSecretKeyPair();
  const { environment } = stubEnvironment({
    env: env({ WINDKEEL_SECRET_PRIVATE_KEY: pair.privateKey }),
    pool: stubPool({
      secrets: [
        { key: "NPM_TOKEN", sealed_value: sealSecret(pair.publicKey, "NPM_TOKEN", "v"), repository_id: REPO_UUID },
      ],
    }),
  });
  const { report } = await runDoctor(environment, tempPackage);
  const result = report.results.find((r) => r.id === "repository-secrets");
  assert.equal(result.status, "pass");
  assert.match(result.summary, /all 1 stored secret/);
});

test("repositoryFromUrl handles the shapes a clone URL actually comes in", () => {
  for (const url of [
    "https://github.com/jyothepro/windkeel.git",
    "https://github.com/jyothepro/windkeel",
    "git@github.com:jyothepro/windkeel.git",
    "https://github.com/jyothepro/windkeel/",
  ]) {
    assert.deepEqual(repositoryFromUrl(url), { owner: "jyothepro", name: "windkeel" }, url);
  }
  assert.equal(repositoryFromUrl("/local/bare/repo.git"), null);
});

// --- No secret reaches the output ---------------------------------------------------------

/** Every sentinel, and the DATABASE_URL that contains one. */
function everySecretValue(environmentEnv) {
  return [...Object.values(SECRETS), environmentEnv.DATABASE_URL].filter(Boolean);
}

test("no secret value appears in the report — the all-green path", async () => {
  const { environment } = stubEnvironment();
  const { report, secrets } = await runDoctor(environment, tempPackage);
  assert.equal(report.ok, true);

  const rendered = formatDoctorReport(report, secrets);
  for (const secret of everySecretValue(environment.env)) {
    assert.ok(!rendered.includes(secret), `the report contains a secret value: ${secret}`);
  }
  // Names are what it prints instead, so the report is still actionable.
  assert.match(rendered, /Configuration/);
});

test("no secret value appears in the report — every check failing", async () => {
  // The path that matters more: error messages are where values leak, because whoever wrote the
  // message was thinking about the failure and not about the credential in scope.
  const leaky = new Error("connect failed for user windkeel");
  const environment = stubEnvironment({
    pool: {
      async connect() {
        throw leaky;
      },
      async query() {
        throw leaky;
      },
      async end() {},
    },
    storageStub: new StubStorage({ throwOn: "put" }),
    githubStub: stubGitHub({ throwOn: "getRepository" }),
    sandboxStub: stubSandbox({ createThrows: true }),
    fetch: async () => {
      throw new Error("network is unreachable");
    },
  }).environment;

  const { report, secrets } = await runDoctor(environment, tempPackage);
  assert.equal(report.ok, false);
  assert.ok(report.results.filter((r) => r.status === "fail").length >= 4);

  const rendered = formatDoctorReport(report, secrets);
  for (const secret of everySecretValue(environment.env)) {
    assert.ok(!rendered.includes(secret), `a failure path leaked a secret: ${secret}`);
  }
});

test("no secret value appears in the report — an error message carrying one verbatim", async () => {
  // A driver that echoes the connection string, which is exactly how this leaks in practice.
  const environment = stubEnvironment({
    pool: {
      async connect() {
        throw new Error(
          `could not connect to postgresql://windkeel:${SECRETS.databasePassword}@db.example.com:5432/windkeel`,
        );
      },
      async query() {
        throw new Error("unused");
      },
      async end() {},
    },
  }).environment;

  const { report, secrets } = await runDoctor(environment, tempPackage);
  const rendered = formatDoctorReport(report, secrets);

  assert.ok(!rendered.includes(SECRETS.databasePassword), "the password survived into the report");
  assert.match(rendered, /\[redacted\]/, "and the redaction is visible rather than silent");
});

test("no secret value appears in the JSON output either", async () => {
  const { environment } = stubEnvironment();
  const { report, secrets } = await runDoctor(environment, tempPackage);
  const json = secrets.redact(JSON.stringify(report, null, 2));
  for (const secret of everySecretValue(environment.env)) {
    assert.ok(!json.includes(secret));
  }
});

test("a minted installation token is registered as a secret, not just the configured ones", async () => {
  // Tokens this command creates are as much a credential as the ones it was handed, and they do
  // not exist until the check runs — so the registry has to grow during the run.
  const secrets = new SecretRegistry();
  await checkTokenScoping(stubGitHub(), { owner: "o", name: "r" }, secrets);
  assert.equal(secrets.redact(`${SECRETS.mintedToken}-maker`), "[redacted]");
});

test("the registry does not scrub short strings into uselessness", () => {
  const secrets = new SecretRegistry();
  secrets.add("ok", "1", "read", "write");
  assert.equal(secrets.size, 0, "a four-character value is not a credential, and redacting it " +
    "would replace half the report with [redacted]");
});

/**
 * #200 asked that `windkeel doctor` keep checking everything that still existed once `apps/worker`
 * was deleted, and drop only what was genuinely about the container. A doctor that silently
 * stops checking something is worse than one that fails, because a green report is taken as an
 * answer.
 *
 * The answer was that **nothing had to go**, and this inventory is what made that a visible
 * decision rather than a hope. It outlives the deletion: a check that disappears still has to be
 * removed from `DOCTOR_CHECKS` too, which is still a diff someone has to justify.
 */
test("every check the doctor runs is named, and the inventory is complete", async () => {
  const doctor = await import("../dist/commands/doctor.js");
  const { environment } = stubEnvironment();
  const { report } = await runDoctor(environment, tempPackage);

  assert.deepEqual(
    report.results.map((r) => r.id).sort(),
    doctor.DOCTOR_CHECKS.map((c) => c.id).sort(),
    "a check exists that DOCTOR_CHECKS does not name, or vice versa — the list #200 works from " +
      "is wrong, and the deletion would be done against a stale inventory",
  );
});

/**
 * **Deleted with the container it was about, and this is the argument for deleting it.**
 *
 * It asserted `DOCTOR_CHECKS.filter((c) => c.scope === "container")` was empty. That was a real
 * claim while a container existed and a check might have been about it — it is the finding that
 * let #200 delete `apps/worker` without dropping a single check.
 *
 * The container is gone, so `scope` is gone with it, and the filter would now be empty because
 * the field does not exist rather than because the classification holds. A test that cannot fail
 * is worse than no test: it reads as coverage. The claim it made is recorded in `DOCTOR_CHECKS`'s
 * own comment and in the PR, where a claim about a past decision belongs.
 *
 * What survives is the test above, which pins the inventory against the checks the command
 * actually produces — and that one can still fail.
 */

// --- model credentials (M9-7 #325) ------------------------------------------------------------

async function modelCredentialsResult(poolOptions) {
  const { environment } = stubEnvironment();
  environment.connect = async () => stubPool(poolOptions);
  const { report } = await runDoctor(environment, tempPackage);
  return { result: report.results.find((r) => r.id === "model-credentials"), report };
}

test("model credentials: counts by status, and snapshot runs, with nothing stored passing plainly", async () => {
  const { result } = await modelCredentialsResult({ snapshots: { total: 4, customer: 0 } });
  assert.equal(result.status, "pass");
  assert.match(result.summary, /no organization has stored a model key/);
  assert.match(result.details[0], /^4 run\(s\) in the last 7 days were frozen to a model snapshot/);
});

test("model credentials: an invalid key warns by label without failing the deployment", async () => {
  const { result, report } = await modelCredentialsResult({
    credentials: [
      { status: "invalid", total: 1, stale: 0, invalid_labels: ["vllm (organization 1a2b3c4d)"] },
      { status: "valid", total: 2, stale: 0, invalid_labels: null },
    ],
    snapshots: { total: 3, customer: 2 },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.summary, "2 valid, 0 unverified, 1 invalid, 0 revoked — with warnings");
  assert.ok(result.details.some((d) => /^Warning: 1 key\(s\) the provider refused: vllm \(organization 1a2b3c4d\)/.test(d)));
  assert.match(result.details[0], /2 of them on an organization's own key/);
  assert.equal(report.ok, true, "an organization's refused key is not the deployment failing");
});

test("model credentials: unverified for over an hour warns about the checks, not the key", async () => {
  const { result } = await modelCredentialsResult({ credentials: [{ status: "unverified", total: 2, stale: 1, invalid_labels: null }] });
  assert.equal(result.status, "pass");
  assert.ok(result.details.some((d) => /^Warning: 1 key\(s\) unverified for over 1 hour/.test(d) && /\/api\/sweep/.test(d)));
});

test("model credentials: before migration 0029 the check is skipped, saying so", async () => {
  const { result } = await modelCredentialsResult({ credentials: "missing" });
  assert.equal(result.status, "skip");
  assert.match(result.summary, /does not exist yet/);
});

// --- security controls (#393 8F) -------------------------------------------------------------

async function securityResult(security, envOverrides = {}) {
  const { environment } = stubEnvironment({ env: env(envOverrides) });
  environment.connect = async () => stubPool({ security });
  const { report } = await runDoctor(environment, tempPackage);
  return { result: report.results.find((r) => r.id === "security-controls"), report };
}

test("security controls: a clean deployment passes plainly and says where the log goes", async () => {
  const { result } = await securityResult({});
  assert.equal(result.status, "pass");
  assert.equal(result.summary, "no break-glass use, no undated tokens, no failing sink");
  assert.ok(result.details.some((d) => /in Postgres only/.test(d)));
});

test("security controls: break-glass in use, undated tokens, a failing sink and unsigned evidence all fire", async () => {
  const { result, report } = await securityResult(
    { tokens_without_expiry: 3, bootstrap_events: 12, sink_failing: 1, verified_recent: 5, unsigned_recent: 5 },
    { WINDKEEL_API_TOKEN: "break-glass-value", WINDKEEL_AUDIT_WEBHOOK_URL: "https://siem.example/in" },
  );
  assert.equal(result.status, "pass", "each is a policy choice, not a broken deployment");
  assert.equal(report.ok, true);
  assert.equal(result.summary, "4 warning(s)");
  const text = result.details.join("\n");
  assert.match(text, /WINDKEEL_API_TOKEN \(the break-glass operator token\) is set and acted 12 time\(s\)/);
  assert.match(text, /3 live token\(s\) never expire/);
  assert.match(text, /without WINDKEEL_AUDIT_WEBHOOK_SECRET/);
  assert.match(text, /audit sink is failing for 1 account/);
  assert.match(text, /5 of 5 verification\(s\) .* unsigned/);
  assert.ok(!text.includes("break-glass-value"), "never a value");
});

test("security controls: before migration 0039 the check is skipped, saying so", async () => {
  const { result } = await securityResult("missing");
  assert.equal(result.status, "skip");
  assert.match(result.summary, /audit_event table does not exist yet/);
});

test("the integrations check (#389) names each optional switch, never a value, and never fails", async () => {
  const { checkIntegrationSwitches } = await import("../dist/commands/doctor.js");
  const off = checkIntegrationSwitches({});
  assert.equal(off.status, "skip");
  assert.ok(off.details.some((d) => d.includes("WINDKEEL_SENTRY_CLIENT_SECRET")));
  assert.ok(off.details.some((d) => d.includes("WINDKEEL_CONNECT_SENTRY")));
  const secret = "sentry-client-secret-value-0123456789";
  const on = checkIntegrationSwitches({ WINDKEEL_SENTRY_CLIENT_SECRET: secret, WINDKEEL_CONNECT_SENTRY: "sealed" });
  assert.equal(on.status, "pass");
  assert.match(on.summary, /Sentry intake/);
  assert.ok(!JSON.stringify(on).includes(secret), "a value never appears");
  assert.ok(on.details.some((d) => /WINDKEEL_SECRET_PRIVATE_KEY/.test(d)), "the post-back needs the private key");
});

// --- Billing (ADR-0037 §6, #394) ----------------------------------------------------------

test("billing: the fake by default passes; stripe without its keys fails naming them, never a value", async () => {
  const { checkBillingConfiguration } = await import("../dist/commands/doctor.js");
  const fake = checkBillingConfiguration({});
  assert.equal(fake.status, "pass");
  assert.match(fake.summary, /billing provider fake/);
  const stripe = checkBillingConfiguration({ WINDKEEL_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_should_not_print" });
  assert.equal(stripe.status, "fail");
  assert.match(stripe.details.join(" "), /STRIPE_WEBHOOK_SECRET, STRIPE_METER_EVENT_NAME/);
  assert.ok(!JSON.stringify(stripe).includes("sk_live_should_not_print"));
});

test("billing: the check runs on a full report too, last", async () => {
  const { environment } = stubEnvironment();
  const { report } = await runDoctor(environment, tempPackage);
  assert.equal(report.results.at(-1).id, "billing");
});
