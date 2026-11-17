
import { INTEGRATION_VARIABLES } from "../../factory/config/integration-env.js";
import { billingConfigProblem } from "../../factory/config/billing.js";
import { enabledHarnesses } from "../../factory/harnesses.js";
import {
  InvalidConfigError,
  MissingConfigError,
  configWarnings,
  loadWorkerConfig,
  type WorkerConfig,
} from "../../factory/worker-config.js";
import { type CheckResult, fail, message, pass, skip } from "./report.js";

export const BILLING_CHECK = { id: "billing", title: "Billing provider (ADR-0037)" };

export function checkBillingConfiguration(env: NodeJS.ProcessEnv): CheckResult {
  const problem = billingConfigProblem(env);
  return problem.ok
    ? pass(BILLING_CHECK.id, BILLING_CHECK.title, problem.summary)
    : fail(BILLING_CHECK.id, BILLING_CHECK.title, "the billing configuration is refused", [problem.summary]);
}

const CONFIG_CHECK = { id: "config", title: "Configuration" };

export function collectConfigProblems(env: NodeJS.ProcessEnv): {
  problems: Array<{ variable: string; message: string }>;
  config: WorkerConfig | null;
} {
  const problems: Array<{ variable: string; message: string }> = [];
  const probe: NodeJS.ProcessEnv = { ...env };

  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      return { problems, config: loadWorkerConfig(probe) };
    } catch (error) {
      if (!(error instanceof MissingConfigError || error instanceof InvalidConfigError)) {
        problems.push({ variable: "(unknown)", message: message(error) });
        return { problems, config: null };
      }
      if (problems.some((p) => p.variable === error.variable)) {

        return { problems, config: null };
      }
      problems.push({ variable: error.variable, message: error.message });
      probe[error.variable] = "1";
    }
  }
  return { problems, config: null };
}

export function checkConfiguration(env: NodeJS.ProcessEnv): {
  result: CheckResult;
  config: WorkerConfig | null;
} {
  const { problems, config } = collectConfigProblems(env);

  if (!config || problems.length > 0) {
    return {
      result: fail(
        CONFIG_CHECK.id,
        CONFIG_CHECK.title,
        `${problems.length} configuration problem${problems.length === 1 ? "" : "s"}`,
        problems.map((p) => p.message),
      ),
      config: null,
    };
  }
  const warnings = configWarnings(config, enabledHarnesses(env).map((harness) => harness.id));
  return {
    result: pass(
      CONFIG_CHECK.id,
      CONFIG_CHECK.title,
      warnings.length === 0
        ? "every variable is set and valid"
        : `valid, with ${warnings.length} startup warning${warnings.length === 1 ? "" : "s"}`,
      warnings,
    ),
    config,
  };
}

export const INTEGRATIONS_CHECK = { id: "integrations", title: "Intake integrations (optional)" };

export function checkIntegrationSwitches(env: NodeJS.ProcessEnv): CheckResult {
  const title = INTEGRATIONS_CHECK.title;
  const details = INTEGRATION_VARIABLES.map((v) => `${v.integration}: ${env[v.name]?.trim() ? "on" : "off"} (${v.name})`);
  const on = INTEGRATION_VARIABLES.filter((v) => Boolean(env[v.name]?.trim()));
  if (on.length === 0) return skip("integrations", title, "no intake integration is configured; each is optional", details);
  if (env["WINDKEEL_CONNECT_SENTRY"]?.trim() && !env["WINDKEEL_SECRET_PRIVATE_KEY"]?.trim()) {
    details.push(
      "WINDKEEL_CONNECT_SENTRY is set but WINDKEEL_SECRET_PRIVATE_KEY is not: the flow function cannot open a Sentry " +
        "token, so Sentry comments are skipped (no_credential). Fine on an ingress-only environment.",
    );
  }
  return pass("integrations", title, `${on.map((v) => v.integration).join(", ")} configured`, details);
}
