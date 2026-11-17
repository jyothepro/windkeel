import { Pool } from "pg";
import { detectPooler, sessionPoolerNote } from "../commands/doctor.js";
import { createAppJwt, loadGitHubConfig } from "../github/app.js";
import { S3EvidenceStorage } from "./evidence-storage.js";
import { loadWorkerConfig } from "./worker-config.js";
import { bundledMigrationFilenames, readSchemaStatus } from "./schema-guard.js";
import { INTEGRATION_VARIABLES } from "./config/integration-env.js";

export { INTEGRATION_VARIABLES };
import { billingConfigProblem, PLAN_PRICE_VARIABLES, TOPUP_PRICE_VARIABLES } from "./config/billing.js";

export type PreflightStatus = "pass" | "fail" | "skip";

export interface PreflightCheck {
  id: string;
  status: PreflightStatus;
  summary: string;
  details: string[];
}

export interface PreflightVariable {
  name: string;
  present: boolean;
  length?: number;
  purpose: string;
}

export interface PreflightReport {
  ok: boolean;
  deployment: {
    id: string | null;
    url: string | null;
    environment: string | null;
    region: string | null;
  };
  variables: PreflightVariable[];
  checks: PreflightCheck[];
}

const pass = (id: string, summary: string, details: string[] = []): PreflightCheck => ({
  id,
  status: "pass",
  summary,
  details,
});
const fail = (id: string, summary: string, details: string[] = []): PreflightCheck => ({
  id,
  status: "fail",
  summary,
  details,
});
const skip = (id: string, summary: string, details: string[] = []): PreflightCheck => ({
  id,
  status: "skip",
  summary,
  details,
});

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const DEPLOYED_VARIABLES: ReadonlyArray<{ name: string; purpose: string }> = [
  { name: "DATABASE_URL", purpose: "the authoritative run state (ADR-0007), in session mode (ADR-0008 §1)" },
  { name: "GITHUB_APP_ID", purpose: "minting installation tokens and reading the App's own configuration" },
  { name: "GITHUB_APP_PRIVATE_KEY", purpose: "the same; the webhook function reads it at module scope" },
  { name: "GITHUB_WEBHOOK_SECRET", purpose: "verifying every delivery's X-Hub-Signature-256 (ADR-0009 §6)" },
  {
    name: "CRON_SECRET",
    purpose:
      "authorising the hourly sweep route. Without it every tick 401s: evidence retention is " +
      "not enforced and no expired sandbox is reaped, neither of which announces itself",
  },
  { name: "WINDKEEL_WORKFLOW_BACKING", purpose: "which machinery carries a run; must match every producer (#199)" },
  { name: "WINDKEEL_REPOSITORY_URL", purpose: "the repository the GitHub checks resolve against" },
  { name: "OPENAI_API_KEY", purpose: "the maker's model key, attached at the egress proxy (ADR-0014 §1)" },
  { name: "ANTHROPIC_API_KEY", purpose: "the checker's model key, which never enters a sandbox" },
  { name: "S3_BUCKET", purpose: "where sealed evidence packages go (ADR-0008)" },
  { name: "S3_ENDPOINT", purpose: "the object store's endpoint" },
  { name: "S3_ACCESS_KEY_ID", purpose: "object store credentials" },
  { name: "S3_SECRET_ACCESS_KEY", purpose: "object store credentials" },
  {
    name: "WINDKEEL_SANDBOX_TOKEN",
    purpose:
      "creating sandboxes; inside a deployment the stage refuses to start without it rather than " +
      "run repository code on the host (ADR-0016 local mode is for a developer machine only)",
  },
  { name: "WINDKEEL_SANDBOX_TEAM_ID", purpose: "the same" },
  { name: "WINDKEEL_SANDBOX_PROJECT_ID", purpose: "the project sandboxes are created in; never the deployment's own" },
  ...INTEGRATION_VARIABLES,
  { name: "WINDKEEL_BILLING_PROVIDER", purpose: "who bills metered usage: fake (default) or stripe" },
  { name: "STRIPE_SECRET_KEY", purpose: "Stripe's API key, when the billing provider is stripe" },
  { name: "STRIPE_WEBHOOK_SECRET", purpose: "verifying Stripe's webhook signatures, when the provider is stripe" },
  { name: "STRIPE_METER_EVENT_NAME", purpose: "the Stripe meter usage is reported to, when the provider is stripe" },
  {
    name: "STRIPE_PRICE_ID",
    purpose: "the metered Stripe price overage and pay-as-you-go usage are invoiced on, when the provider is stripe",
  },
  ...Object.entries(PLAN_PRICE_VARIABLES).map(([plan, name]) => ({
    name,
    purpose: `the Stripe price of the ${plan} plan (monthly, with included credits), when the provider is stripe`,
  })),
  ...Object.entries(TOPUP_PRICE_VARIABLES).map(([pack, name]) => ({
    name,
    purpose: `the Stripe price of the $${pack.replace("topup_", "")} credit top-up (one time), when the provider is stripe`,
  })),
];

function checkBilling(env: NodeJS.ProcessEnv): PreflightCheck {
  const problem = billingConfigProblem(env);
  return problem.ok ? pass("billing", problem.summary) : fail("billing", "the billing configuration is refused", [problem.summary]);
}

function describeVariables(env: NodeJS.ProcessEnv): PreflightVariable[] {
  return DEPLOYED_VARIABLES.map(({ name, purpose }) => {
    const raw = env[name];
    const present = typeof raw === "string" && raw.trim() !== "";
    return present ? { name, present, length: raw.length, purpose } : { name, present: false, purpose };
  });
}

function checkCronSecret(env: NodeJS.ProcessEnv): PreflightCheck {
  if (env["CRON_SECRET"]?.trim()) {
    return pass("cron-secret", "CRON_SECRET is set, so the hourly sweep can authorise");
  }
  return fail("cron-secret", "CRON_SECRET is not set on this deployment", [
    "Every hourly tick of /api/sweep will 401. The route fails closed by design, so this is " +
      "silent: evidence retention is not enforced and no expired sandbox is reaped.",
    "This is the state the deployment was in after #226 shipped the sweep route.",
  ]);
}

async function checkDatabase(
  env: NodeJS.ProcessEnv,
  bundled: readonly string[] | null,
): Promise<PreflightCheck> {
  const url = env["DATABASE_URL"];
  if (!url) return fail("database", "DATABASE_URL is not set on this deployment");

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const findings = await detectPooler(client, url);
      if (findings.length) {
        return fail("database", "connected, but not in session mode (ADR-0008 §1)", [
          ...findings,
          "Both sweeps take session advisory locks. A transaction pooler accepts every query " +
            "this system issues and then loses the lock between them.",
        ]);
      }
    } finally {
      client.release();
    }
    const schema = await readSchemaStatus(pool, bundled);
    if (schema.state === "behind") {
      return fail("database", `reachable, but ${schema.pending.length} migration(s) are not applied`, [
        ...schema.pending.map((filename) => `pending: ${filename}`),
        "Run `npm run db:migrate` against this DATABASE_URL (or let .github/workflows/migrate.yml).",
      ]);
    }
    if (schema.state !== "current") {
      return fail("database", "reachable, but the schema could not be compared", [schema.reason]);
    }
    const note = sessionPoolerNote(url);
    return pass("database", "reachable, session mode confirmed functionally, and migrations current", [
      ...(note ? [note] : []),
      `${schema.bundled} bundled migration(s), all applied.`,
    ]);
  } catch (error) {
    return fail("database", "DATABASE_URL could not be connected to", [reason(error)]);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkEvidenceStore(env: NodeJS.ProcessEnv): Promise<PreflightCheck> {
  let config;
  try {
    config = loadWorkerConfig(env).evidence;
  } catch (error) {
    return skip("evidence-store", "the worker configuration did not load", [reason(error)]);
  }
  if (!config) {
    return skip("evidence-store", "S3_BUCKET is unset, so no object store is configured", [
      "Verifications will record a verdict and store no package; evidence_package_ref stays null.",
    ]);
  }

  const storage = new S3EvidenceStorage(config);
  const key = `windkeel-preflight/${Date.now()}`;
  try {
    const listed = await storage.listPackage(config.bucket, key);
    return pass("evidence-store", `bucket ${config.bucket} answered a list request`, [
      `${listed.length} object(s) under a key nothing has written, which is the expected 0.`,
    ]);
  } catch (error) {
    return fail("evidence-store", `bucket ${config.bucket} could not be reached`, [reason(error)]);
  }
}

async function checkGitHubApp(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<PreflightCheck> {
  let config;
  try {
    config = loadGitHubConfig(env);
  } catch (error) {
    return fail("github-app", "the App credentials did not load", [reason(error)]);
  }

  try {
    const response = await fetchImpl(`${config.baseUrl}/app`, {
      headers: {
        authorization: `Bearer ${createAppJwt(config.credentials, Date.now())}`,
        accept: "application/vnd.github+json",
        "user-agent": "windkeel-preflight",
      },
    });
    if (response.status !== 200) {
      return fail("github-app", `GET /app answered ${response.status}`, [
        "The App ID and private key on this deployment do not authenticate as an App.",
      ]);
    }
    const body = (await response.json().catch(() => null)) as { slug?: unknown } | null;
    const slug = typeof body?.slug === "string" ? body.slug : "(unnamed)";
    return pass("github-app", `authenticated as the App \`${slug}\``);
  } catch (error) {
    return fail("github-app", "GitHub could not be reached", [reason(error)]);
  }
}

function checkIntegrations(env: NodeJS.ProcessEnv): PreflightCheck {
  const on = INTEGRATION_VARIABLES.filter((v) => Boolean(env[v.name]?.trim()));
  const details = INTEGRATION_VARIABLES.map((v) => `${v.integration}: ${env[v.name]?.trim() ? "on" : "off"} (${v.name})`);
  if (on.length === 0) return skip("integrations", "no intake integration is configured; each is optional", details);
  return pass("integrations", `${on.map((v) => v.integration).join(", ")} configured`, details);
}

export interface PreflightDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  bundledMigrations?: readonly string[] | null;
}

export async function runDeploymentPreflight({
  env = process.env,
  fetchImpl = fetch,
  bundledMigrations = bundledMigrationFilenames(),
}: PreflightDeps = {}): Promise<PreflightReport> {
  const checks = [
    checkCronSecret(env),
    checkIntegrations(env),
    checkBilling(env),
    await checkDatabase(env, bundledMigrations),
    await checkEvidenceStore(env),
    await checkGitHubApp(env, fetchImpl),
  ];

  return {
    ok: checks.every((c) => c.status !== "fail"),
    deployment: {
      id: env["VERCEL_DEPLOYMENT_ID"] ?? null,
      url: env["VERCEL_URL"] ?? null,
      environment: env["VERCEL_ENV"] ?? null,
      region: env["VERCEL_REGION"] ?? null,
    },
    variables: describeVariables(env),
    checks,
  };
}

export function scrubSecrets(report: PreflightReport, env: NodeJS.ProcessEnv): PreflightReport {
  const values = new Set<string>();
  const register = (value: string | undefined): void => {
    if (!value || value.length < 8) return;
    values.add(value);
    const encoded = JSON.stringify(value).slice(1, -1);
    if (encoded !== value) values.add(encoded);
  };

  for (const { name } of DEPLOYED_VARIABLES) {
    const raw = env[name]?.trim();
    register(raw);
    if (name !== "DATABASE_URL" || !raw) continue;
    try {
      const url = new URL(raw);
      for (const part of [url.password, url.username]) register(part);
    } catch {
    }
  }

  let json = JSON.stringify(report);
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    json = json.split(value).join("[redacted]");
  }
  return JSON.parse(json) as PreflightReport;
}
