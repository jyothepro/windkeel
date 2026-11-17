import { WINDKEEL_RUN_WORKFLOW_ID } from "./vercel.js";

const DEPLOYMENT_DESCRIPTOR_PATH = "/.well-known/windkeel/deployment.json";

export const DEPLOYMENT_URL_ENV = "WINDKEEL_DEPLOYMENT_URL";

export type DeploymentVerdict = {
  status: "pass" | "fail" | "skip";
  summary: string;
  details: string[];
};

export function resolveTargetWorld(env: Record<string, string | undefined>): string {
  const configured = env["WORKFLOW_TARGET_WORLD"];
  if (configured) return configured;
  return env["VERCEL_DEPLOYMENT_ID"] ? "vercel" : "local";
}

const REQUIRED_WORLD = "vercel";

export async function checkVercelDeployment(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentVerdict> {
  const details: string[] = [];

  const world = resolveTargetWorld(env);
  if (world !== REQUIRED_WORLD) {
    details.push(
      `The Workflow World resolves to "${world}" in this process. ` +
        (env["WORKFLOW_TARGET_WORLD"]
          ? `WORKFLOW_TARGET_WORLD is set to "${env["WORKFLOW_TARGET_WORLD"]}".`
          : "VERCEL_DEPLOYMENT_ID is unset, so this process is not inside a deployment."),
      "Consequence: starting a run from here fails — the Vercel World addresses every queue " +
        "message to the producer's own deployment id, and there is none. On this backing a run " +
        "is started by the deployed webhook; `windkeel task` cannot start one.",
    );
  }

  const base = env[DEPLOYMENT_URL_ENV];
  if (!base) {
    return {
      status: "skip",
      summary: `${DEPLOYMENT_URL_ENV} is unset, so there is no deployment to check`,
      details: [
        ...details,
        `Set ${DEPLOYMENT_URL_ENV} to the deployment that serves the flow route and this checks ` +
          "that it is reachable, that its workflow id is the one startRun names, and that it " +
          "was built for the Vercel World.",
      ],
    };
  }

  let descriptor: { workflowIds?: unknown; targetWorld?: unknown };
  try {
    const response = await fetchImpl(new URL(DEPLOYMENT_DESCRIPTOR_PATH, base).toString());
    if (!response.ok) {
      return {
        status: "fail",
        summary: `the deployment did not serve ${DEPLOYMENT_DESCRIPTOR_PATH} (HTTP ${response.status})`,
        details: [
          ...details,
          "That file is emitted by `npm run -w @windkeel/ingress build:vercel`. A deployment " +
            "without it was not built by that command, which means it serves no flow function " +
            "either — nothing would execute a run started against it.",
        ],
      };
    }
    descriptor = (await response.json()) as typeof descriptor;
  } catch (error) {
    return {
      status: "fail",
      summary: "the deployment is not reachable",
      details: [
        ...details,
        error instanceof Error ? error.message : String(error),
        `${DEPLOYMENT_URL_ENV} is ${base}.`,
      ],
    };
  }

  const ids = Array.isArray(descriptor.workflowIds) ? descriptor.workflowIds.map(String) : [];
  if (!ids.includes(WINDKEEL_RUN_WORKFLOW_ID)) {
    return {
      status: "fail",
      summary: "the deployment registers a different workflow id",
      details: [
        ...details,
        `Starting a run names ${WINDKEEL_RUN_WORKFLOW_ID}.`,
        `The deployment has: ${ids.length ? ids.join(", ") : "(none)"}.`,
        "Every run started against it would fail to start, and nothing would say why. The id " +
          "is derived from the workflow file's path relative to the build's working directory.",
      ],
    };
  }

  const deployedWorld = typeof descriptor.targetWorld === "string" ? descriptor.targetWorld : null;
  if (deployedWorld && deployedWorld !== REQUIRED_WORLD) {
    return {
      status: "fail",
      summary: `the deployment was built for the "${deployedWorld}" World`,
      details: [
        ...details,
        "ADR-0002 recorded that the SDK's Postgres World needs a long-running Node server, and " +
          "ADR-0007 rejected it. ADR-0020 removed the long-running server. The Vercel World is " +
          "the only one left.",
        "Unset WORKFLOW_TARGET_WORLD in the Vercel project and redeploy.",
      ],
    };
  }

  return {
    status: "pass",
    summary: `${base} serves the run workflow, on the Vercel World`,
    details,
  };
}
