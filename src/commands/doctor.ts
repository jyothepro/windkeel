

import type { SandboxGitCredential } from "../sandbox/provider.js";
import {
  checkVercelDeployment,
  type DeploymentVerdict,
} from "../factory/workflow/vercel-deployment.js";
import { loadGitHubConfig } from "../github/app.js";
import { checkWebhookDeliveries } from "../github/app-deliveries.js";
import {
  type CheckResult,
  type CheckStatus,
  type DoctorEnvironment,
  type DoctorReport,
  SECRET_VARIABLES,
  SecretRegistry,
  VERIFIER_PERMISSIONS,
  fail,
  message,
  pass,
  skip,
} from "./doctor/report.js";
import {
  BILLING_CHECK,
  INTEGRATIONS_CHECK,
  checkBillingConfiguration,
  checkConfiguration,
  checkIntegrationSwitches,
} from "./doctor/config.js";
import {
  BACKING_CHECK,
  MIGRATIONS_CHECK,
  POSTGRES_CHECK,
  checkMigrations,
  checkPostgres,
  checkWorkflowBacking,
} from "./doctor/database.js";
import { STORAGE_CHECK, checkObjectStore } from "./doctor/storage.js";
import {
  SANDBOX_CHECK,
  SECRETS_CHECK,
  checkRepositorySecrets,
  checkSandbox,
  repositoryFromUrl,
} from "./doctor/sandbox.js";
import {
  MODEL_CHECK,
  MODEL_CREDENTIALS_CHECK,
  checkModelCredentials,
  checkModelEndpoints,
} from "./doctor/models.js";
import { SECURITY_CHECK, checkSecurityControls } from "./doctor/security.js";
import {
  DELIVERY_CHECK,
  PERMISSION_CHECK,
  SCOPING_CHECK,
  checkAppPermissions,
  checkTokenScoping,
  reportDeliveries,
} from "./doctor/github.js";

export {
  ADR_0009_PERMISSIONS,
  MAKER_PERMISSIONS,
  VERIFIER_PERMISSIONS,
  SecretRegistry,
  SECRET_VARIABLES,
} from "./doctor/report.js";
export type { CheckStatus, CheckResult, DoctorReport, DoctorEnvironment } from "./doctor/report.js";
export {
  checkBillingConfiguration,
  collectConfigProblems,
  checkConfiguration,
  checkIntegrationSwitches,
} from "./doctor/config.js";
export {
  detectPooler,
  sessionPoolerNote,
  checkPostgres,
  checkMigrations,
} from "./doctor/database.js";
export { checkObjectStore } from "./doctor/storage.js";
export { comparePermissions, checkAppPermissions, checkTokenScoping } from "./doctor/github.js";
export { endpointProbes, checkModelEndpoints } from "./doctor/models.js";
export { checkSandbox, repositoryFromUrl } from "./doctor/sandbox.js";

export const DOCTOR_CHECKS: ReadonlyArray<{ id: string }> = [
  { id: "config" },
  { id: "integrations" },
  { id: "postgres" },
  { id: "migrations" },
  { id: "workflow-backing" },
  { id: "workflow-deployment" },
  { id: "storage" },
  { id: "repository-secrets" },
  { id: "model-credentials" },
  { id: "security-controls" },
  { id: "github-permissions" },
  { id: "github-deliveries" },
  { id: "github-scoping" },
  { id: "models" },
  { id: "sandbox" },
  { id: "billing" },
];

const DEPLOYMENT_CHECK = { id: "workflow-deployment", title: "Workflow deployment (ADR-0020)" };

function reportDeployment(verdict: DeploymentVerdict): CheckResult {
  if (verdict.status === "pass") {
    return pass(DEPLOYMENT_CHECK.id, DEPLOYMENT_CHECK.title, verdict.summary, verdict.details);
  }
  if (verdict.status === "skip") {
    return skip(DEPLOYMENT_CHECK.id, DEPLOYMENT_CHECK.title, verdict.summary, verdict.details);
  }
  return fail(DEPLOYMENT_CHECK.id, DEPLOYMENT_CHECK.title, verdict.summary, verdict.details);
}

export async function runDoctor(
  environment: DoctorEnvironment,
  writeTempPackage: () => Promise<string>,
): Promise<{ report: DoctorReport; secrets: SecretRegistry }> {
  const secrets = new SecretRegistry();
  for (const name of SECRET_VARIABLES) {
    if (name === "DATABASE_URL") secrets.addConnectionString(environment.env[name]);
    else secrets.add(environment.env[name]);
  }

  const results: CheckResult[] = [];
  const { result: configResult, config } = checkConfiguration(environment.env);
  results.push(configResult);

  if (!config) {

    for (const check of [
      INTEGRATIONS_CHECK,
      POSTGRES_CHECK,
      MIGRATIONS_CHECK,
      STORAGE_CHECK,
      SECRETS_CHECK,
      MODEL_CREDENTIALS_CHECK,
      SECURITY_CHECK,
      PERMISSION_CHECK,
      DELIVERY_CHECK,
      SCOPING_CHECK,
      MODEL_CHECK,
      SANDBOX_CHECK,
      BILLING_CHECK,
    ]) {
      results.push(
        skip(check.id, check.title, "the configuration did not load, so this check has nothing to test", [
          "Fix the configuration problems above and run `windkeel doctor` again. Nothing below " +
            "this line has been checked.",
        ]),
      );
    }
    return { report: { results, ok: false }, secrets };
  }

  secrets.add(environment.env[config.modelKeyEnvVar]);
  for (const endpoint of config.checkerEndpoints) secrets.add(endpoint.apiKey);
  if (config.evidence) secrets.add(config.evidence.accessKeyId, config.evidence.secretAccessKey);

  results.push(checkIntegrationSwitches(environment.env));

  const independently = async (
    definition: { id: string; title: string },
    run: () => Promise<CheckResult>,
  ): Promise<void> => {
    try {
      results.push(await run());
    } catch (error) {
      results.push(
        fail(definition.id, definition.title, "the check itself failed", [
          message(error),
          "This is a failure of `windkeel doctor`, not necessarily of what it was checking. The " +
            "command has never been run against a real deployment.",
        ]),
      );
    }
  };

  await independently(POSTGRES_CHECK, () => checkPostgres(environment, config));
  await independently(MIGRATIONS_CHECK, () => checkMigrations(environment, config));
  await independently(BACKING_CHECK, async () => {
    const pool = await environment.connect(config.databaseUrl);
    try {
      return await checkWorkflowBacking(environment.env, pool);
    } finally {
      await pool.end();
    }
  });

  await independently(DEPLOYMENT_CHECK, async () =>
    reportDeployment(await checkVercelDeployment(environment.env)),
  );
  await independently(STORAGE_CHECK, () => checkObjectStore(environment, config, writeTempPackage));
  await independently(SECRETS_CHECK, () => checkRepositorySecrets(environment, config));
  await independently(MODEL_CREDENTIALS_CHECK, () => checkModelCredentials(environment, config));
  await independently(SECURITY_CHECK, () => checkSecurityControls(environment, config));

  const repository = environment.repository ?? repositoryFromUrl(config.repository.url);

  if (!environment.env["GITHUB_APP_ID"]) {
    results.push(
      skip(DELIVERY_CHECK.id, DELIVERY_CHECK.title, "GITHUB_APP_ID is unset, so there is no App", [
        "Nothing is sending webhooks, so there is nothing to judge. A live run needs an App.",
      ]),
    );
  } else {
    await independently(DELIVERY_CHECK, async () => {

      let githubConfig;
      try {
        githubConfig = loadGitHubConfig(environment.env);
      } catch (error) {
        return skip(
          DELIVERY_CHECK.id,
          DELIVERY_CHECK.title,
          "the App credentials could not be loaded, so delivery health is unknown",
          [message(error), "Reported as a configuration problem by the check above."],
        );
      }
      return reportDeliveries(await checkWebhookDeliveries(githubConfig, environment.fetch));
    });
  }

  let sandboxGitCredentials: SandboxGitCredential | undefined;
  if (!environment.env["GITHUB_APP_ID"]) {
    for (const check of [PERMISSION_CHECK, SCOPING_CHECK]) {
      results.push(
        skip(check.id, check.title, "GITHUB_APP_ID is unset, so no App is configured", [
          "Consequence: the worker runs in ADR-0016 hermetic mode — no issue comments, no " +
            "pull requests, and no per-role scoped tokens. A live run needs an App.",
        ]),
      );
    }
  } else if (!repository) {
    for (const check of [PERMISSION_CHECK, SCOPING_CHECK]) {
      results.push(
        skip(check.id, check.title, "no repository to check against", [
          `WINDKEEL_REPOSITORY_URL (${config.repository.url}) is not a github.com URL, so there ` +
            "is no owner/name to ask about. Pass --repository owner/name.",
        ]),
      );
    }
  } else {
    const github = environment.github(environment.env);
    await independently(PERMISSION_CHECK, () => checkAppPermissions(github, repository));
    await independently(SCOPING_CHECK, () => checkTokenScoping(github, repository, secrets));

    try {
      const forClone = await github.mintInstallationToken({
        repository,
        permissions: VERIFIER_PERMISSIONS,
      });
      secrets.add(forClone.token);
      sandboxGitCredentials = {
        username: "x-access-token",
        token: forClone.token,
        permission: "read",
        expiresAt: forClone.expiresAt,
      };
    } catch {

    }
  }

  await independently(MODEL_CHECK, () => checkModelEndpoints(environment, config));
  await independently(SANDBOX_CHECK, () =>
    checkSandbox(environment, config, sandboxGitCredentials),
  );
  results.push(checkBillingConfiguration(environment.env));

  return {
    report: { results, ok: results.every((r) => r.status !== "fail") },
    secrets,
  };
}

const MARK: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

export function formatDoctorReport(report: DoctorReport, secrets: SecretRegistry): string {
  const lines: string[] = [];
  for (const result of report.results) {
    lines.push(`${MARK[result.status]}  ${result.title} — ${result.summary}`);
    for (const detail of result.details) lines.push(`      ${detail}`);
  }
  const failed = report.results.filter((r) => r.status === "fail").length;
  const skipped = report.results.filter((r) => r.status === "skip").length;
  lines.push("");
  lines.push(
    report.ok
      ? `All checks passed${skipped > 0 ? `, ${skipped} skipped (see the reasons above)` : ""}.`
      : `${failed} check(s) failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
  );
  if (skipped > 0) {
    lines.push(
      "A skipped check has not passed. Each one states above what it means to run without it.",
    );
  }
  return secrets.redact(lines.join("\n"));
}
