import { createAppJwt, DEFAULT_GITHUB_API_BASE_URL, type GitHubConfig } from "./app.js";

export interface WebhookDelivery {
  id: number;
  status_code: number;
  status?: string | undefined;
  event?: string | undefined;
  delivered_at?: string | undefined;
  redelivery?: boolean | undefined;
}

export interface DeliveryVerdict {
  status: "pass" | "fail" | "skip";
  summary: string;
  details: string[];
}

export const DELIVERY_SAMPLE = 30;

const healthy = (delivery: WebhookDelivery): boolean =>
  delivery.status_code >= 200 && delivery.status_code < 300;

function tally(deliveries: WebhookDelivery[]): string[] {
  const counts = new Map<string, number>();
  for (const delivery of deliveries) {
    const label =
      delivery.status_code === 0
        ? "no response — the request never reached a server"
        : `${delivery.status_code} ${delivery.status ?? ""}`.trim();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label} (${count}×)`);
}

async function getJson(
  config: GitHubConfig,
  path: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(`${config.baseUrl || DEFAULT_GITHUB_API_BASE_URL}${path}`, {
    headers: {
      authorization: `Bearer ${createAppJwt(config.credentials, now())}`,
      accept: "application/vnd.github+json",
      "user-agent": "windkeel-doctor",
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function configuredUrl(
  config: GitHubConfig,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<string | null> {
  try {
    const { status, body } = await getJson(config, "/app/hook/config", fetchImpl, now);
    if (status !== 200) return null;
    const url = (body as { url?: unknown } | null)?.url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

export async function checkWebhookDeliveries(
  config: GitHubConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<DeliveryVerdict> {
  const url = await configuredUrl(config, fetchImpl, now);
  const urlLine = url
    ? `Configured webhook URL: ${url}`
    : "Configured webhook URL: could not be read from GET /app/hook/config";

  let payload: { status: number; body: unknown };
  try {
    payload = await getJson(
      config,
      `/app/hook/deliveries?per_page=${DELIVERY_SAMPLE}`,
      fetchImpl,
      now,
    );
  } catch (error) {
    return {
      status: "skip",
      summary: "GitHub could not be reached to read the App's recent deliveries",
      details: [urlLine, error instanceof Error ? error.message : String(error)],
    };
  }

  if (payload.status !== 200 || !Array.isArray(payload.body)) {
    return {
      status: "skip",
      summary: `GET /app/hook/deliveries answered ${payload.status}, so delivery health is unknown`,
      details: [
        urlLine,
        "This endpoint needs the App's own JWT and no extra permission. A 401 here means the " +
          "App credentials are wrong, which the GitHub App permission check reports directly.",
      ],
    };
  }

  const deliveries = payload.body as WebhookDelivery[];

  if (deliveries.length === 0) {
    return {
      status: "skip",
      summary: "the App has no recent deliveries, so there is nothing to judge",
      details: [
        urlLine,
        "A never-triggered App and a completely broken one are indistinguishable from here. " +
          "Label an issue with `windkeel` and run this again.",
      ],
    };
  }

  const failed = deliveries.filter((d) => !healthy(d));
  const succeeded = deliveries.length - failed.length;

  if (succeeded === 0) {
    return {
      status: "fail",
      summary: `all ${deliveries.length} recent deliveries failed — the trigger is not working`,
      details: [
        urlLine,
        ...tally(failed).map((line) => `  ${line}`),
        "Nothing downstream reports this: a delivery that never arrives produces no run, no " +
          "error and no alert, so labelling an issue simply does nothing.",
        "Check the URL above against the deployment that is actually serving " +
          "`/api/webhook`. On 2026-09-18 it named a Vercel project that did not exist and every " +
          "delivery 404'd for a day.",
      ],
    };
  }

  if (failed.length > 0) {
    return {
      status: "pass",
      summary: `${succeeded} of ${deliveries.length} recent deliveries succeeded`,
      details: [
        urlLine,
        `${failed.length} did not, which is not on its own a broken trigger:`,
        ...tally(failed).map((line) => `  ${line}`),
        "`docs/webhook-ingress.md` documents 400 and 401 as correct refusals of a malformed or " +
          "unsigned delivery, and 500 as retried. Deliveries are still arriving.",
      ],
    };
  }

  return {
    status: "pass",
    summary: `all ${deliveries.length} recent deliveries were accepted`,
    details: [urlLine],
  };
}
