
import {
  selectModelCredentialSummary,
  selectRecentModelSnapshots,
} from "../stores/doctor-store.js";
import { type WorkerConfig } from "../../factory/worker-config.js";
import { type CheckResult, type DoctorEnvironment, fail, message, pass, skip } from "./report.js";

export const MODEL_CHECK = { id: "models", title: "Model endpoints (ADR-0010)" };

interface EndpointProbe {
  vendor: string;
  url: string;
  headers: Record<string, string>;
}

export function endpointProbes(config: WorkerConfig, env: NodeJS.ProcessEnv): EndpointProbe[] {
  const probes: EndpointProbe[] = [];
  const makerKey = env[config.modelKeyEnvVar];
  if (makerKey) {
    probes.push({
      vendor: config.makerVendor,
      url: `https://${config.modelApiDomain}/v1/models`,
      headers: { authorization: `Bearer ${makerKey}` },
    });
  }
  for (const endpoint of config.checkerEndpoints) {
    const base = endpoint.baseUrl ?? `https://api.${endpoint.vendor}.com`;
    probes.push({
      vendor: endpoint.vendor,
      url: `${base.replace(/\/+$/, "")}/v1/models`,
      headers:
        endpoint.vendor === "anthropic"
          ? { "x-api-key": endpoint.apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${endpoint.apiKey}` },
    });
  }
  return probes;
}

export async function checkModelEndpoints(
  environment: DoctorEnvironment,
  config: WorkerConfig,
): Promise<CheckResult> {
  const probes = endpointProbes(config, environment.env);
  const findings: string[] = [];

  const checkerVendors = config.checkerEndpoints.map((e) => e.vendor);
  if (checkerVendors.length === 0) {
    return skip(
      MODEL_CHECK.id,
      MODEL_CHECK.title,
      "no checker endpoint is configured (ANTHROPIC_API_KEY)",
      [
        "Consequence: the review and mapping stages report themselves skipped rather than " +
          "passing, so a verdict from this deployment is about checks and findings only.",
        "ADR-0010's independence property cannot be asserted with only one vendor configured.",
      ],
    );
  }
  const sameVendor = checkerVendors.filter((v) => v === config.makerVendor);
  if (sameVendor.length > 0) {
    findings.push(
      `a checker endpoint uses the maker's vendor (${config.makerVendor}). ADR-0010 requires ` +
        "the two to differ, and selectGateway refuses a run where they match — this is the " +
        "independence property verification rests on, not a preference.",
    );
  }

  for (const probe of probes) {
    try {
      const response = await environment.fetch(probe.url, {
        method: "GET",
        headers: probe.headers,
      });
      if (!response.ok) {
        findings.push(
          `${probe.vendor}: ${probe.url} answered ${response.status} — the key named in the ` +
            "configuration was rejected or the endpoint is wrong",
        );
      }
    } catch (error) {
      findings.push(`${probe.vendor}: ${probe.url} was unreachable (${message(error)})`);
    }
  }

  if (findings.length > 0) {
    return fail(MODEL_CHECK.id, MODEL_CHECK.title, `${findings.length} problem(s)`, findings);
  }
  return pass(
    MODEL_CHECK.id,
    MODEL_CHECK.title,
    `${probes.length} endpoint(s) reachable; maker (${config.makerVendor}) and checker ` +
      `(${checkerVendors.join(", ")}) vendors differ`,
  );
}

export const MODEL_CREDENTIALS_CHECK = { id: "model-credentials", title: "Model credentials (ADR-0026)" };

const STALE_UNVERIFIED_HOURS = 1;

export async function checkModelCredentials(environment: DoctorEnvironment, config: WorkerConfig): Promise<CheckResult> {
  const pool = await environment.connect(config.databaseUrl);
  try {
    let rows: Array<{ status: string; total: number; stale: number; invalid_labels: string[] | null }>;
    try {
      ({ rows } = await selectModelCredentialSummary(pool, STALE_UNVERIFIED_HOURS));
    } catch (error) {

      if ((error as { code?: unknown })?.code === "42P01") {
        return skip(MODEL_CREDENTIALS_CHECK.id, MODEL_CREDENTIALS_CHECK.title, "the model_credential table does not exist yet", [
          "Apply the migrations (see the migrations check above); until then no organization can store a key.",
        ]);
      }
      throw error;
    }

    const count = (status: string) => rows.find((r) => r.status === status)?.total ?? 0;
    const stale = rows.reduce((n, r) => n + (r.stale ?? 0), 0);
    const invalid = rows.flatMap((r) => r.invalid_labels ?? []);
    const live = count("valid") + count("unverified") + count("invalid");

    const { rows: snapshots } = await selectRecentModelSnapshots(pool);
    const recent = snapshots[0] ?? { total: 0, customer: 0 };

    const details: string[] = [
      `${recent.total} run(s) in the last 7 days were frozen to a model snapshot at intake, ` +
        `${recent.customer} of them on an organization's own key.`,
    ];
    if (invalid.length > 0) {
      details.push(
        `Warning: ${invalid.length} key(s) the provider refused: ${invalid.join(", ")}. Runs routed to one ` +
          "fail when they call the model; the organization rotates it or chooses another in Settings → Models.",
      );
    }
    if (stale > 0) {
      details.push(
        `Warning: ${stale} key(s) unverified for over ${STALE_UNVERIFIED_HOURS} hour with no check landing. ` +
          "Checks aren't starting or aren't finishing: confirm WINDKEEL_SECRET_PRIVATE_KEY is set where stages run, " +
          "that the Workflow queue is delivering, and that /api/sweep runs (it restarts stalled checks).",
      );
    }
    if (live === 0) {
      return pass(MODEL_CREDENTIALS_CHECK.id, MODEL_CREDENTIALS_CHECK.title, "no organization has stored a model key; every run is Windkeel-managed", details);
    }
    return pass(
      MODEL_CREDENTIALS_CHECK.id,
      MODEL_CREDENTIALS_CHECK.title,
      `${count("valid")} valid, ${count("unverified")} unverified, ${count("invalid")} invalid, ${count("revoked")} revoked` +
        (invalid.length + stale > 0 ? " — with warnings" : ""),
      details,
    );
  } finally {
    await pool.end();
  }
}
