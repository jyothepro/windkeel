import { createHmac, randomUUID } from "node:crypto";
import type { WindkeelApi, WebhookEndpointView } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const WEBHOOK_USAGE =
  "usage: windkeel webhook list [--json]\n" +
  "       windkeel webhook create --name <name> --repo <repository-id> [--risk low|medium|high] [--json]\n" +
  "       windkeel webhook rotate <endpoint-id> [--json]\n" +
  "       windkeel webhook delete <endpoint-id>\n" +
  "       WINDKEEL_WEBHOOK_SECRET=<whsec_…> windkeel webhook send <endpoint-id> --title <title> --description <text>\n" +
  "                          [--risk low|medium|high] [--external-id <id>] [--delivery <id>]\n" +
  "                          [--url <deployment-url>] [--json]\n" +
  "         (prefer WINDKEEL_WEBHOOK_SECRET; --secret <whsec_…> also works, but a flag lands in shell\n" +
  "          history and is visible in `ps` while the command runs)\n";

export type WebhookAction =
  | { kind: "list"; json?: boolean }
  | { kind: "create"; name: string; repositoryId: string; defaultRiskLevel?: string; json?: boolean }
  | { kind: "rotate"; endpointId: string; json?: boolean }
  | { kind: "delete"; endpointId: string };

export async function webhookCommand(api: WindkeelApi, io: RemoteIo, action: WebhookAction): Promise<number> {
  switch (action.kind) {
    case "list": {
      const page = await api.listWebhookEndpoints();
      if (action.json) {
        io.out(JSON.stringify(page.items, null, 2));
        return 0;
      }
      if (page.items.length === 0) {
        io.out("no webhook endpoints; create one with `windkeel webhook create --name <name> --repo <repository-id>`");
        return 0;
      }
      for (const endpoint of page.items) io.out(formatEndpoint(endpoint));
      return 0;
    }
    case "create":
    case "rotate": {
      const { endpoint, secret } =
        action.kind === "create"
          ? await api.createWebhookEndpoint({
              name: action.name,
              repositoryId: action.repositoryId,
              ...(action.defaultRiskLevel ? { defaultRiskLevel: action.defaultRiskLevel } : {}),
            })
          : await api.rotateWebhookEndpoint(action.endpointId);
      if (action.json) {
        io.out(JSON.stringify({ endpoint, secret }, null, 2));
        return 0;
      }
      io.out(`${action.kind === "create" ? "created" : "rotated"} ${formatEndpoint(endpoint)}`);
      io.out(`url:    ${api.baseUrl}${endpoint.path}`);
      io.out(`secret: ${secret}`);
      io.out("This secret is shown once. Store it where the sending system keeps its credentials.");
      return 0;
    }
    case "delete": {
      await api.deleteWebhookEndpoint(action.endpointId);
      io.out(`deleted webhook endpoint ${action.endpointId}`);
      return 0;
    }
  }
}

export function formatEndpoint(e: WebhookEndpointView): string {
  return (
    `${e.id}  ${e.name}  -> ${e.repositoryId}  risk ${e.defaultRiskLevel}  v${e.secretVersion}` +
    (e.enabled ? "" : "  (disabled)")
  );
}

export function signWebhookRequest(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}

export interface WebhookSendOptions {
  baseUrl: string;
  endpointId: string;
  secret: string;
  title: string;
  description: string;
  riskLevel?: string;
  externalId?: string;
  deliveryId?: string;
  json?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: number;
}

export async function webhookSend(options: WebhookSendOptions): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify({
    title: options.title,
    description: options.description,
    ...(options.riskLevel ? { riskLevel: options.riskLevel } : {}),
    ...(options.externalId ? { externalId: options.externalId } : {}),
  });
  const timestamp = options.now ?? Math.floor(Date.now() / 1000);
  const url = `${options.baseUrl.replace(/\/+$/, "")}/api/intake/webhook/${encodeURIComponent(options.endpointId)}`;
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-windkeel-timestamp": String(timestamp),
      "x-windkeel-signature": signWebhookRequest(options.secret, timestamp, rawBody),
      "x-windkeel-delivery": options.deliveryId ?? randomUUID(),
    },
    body: rawBody,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
  }
  return { status: response.status, body };
}

export async function webhookSendCommand(io: RemoteIo, options: WebhookSendOptions): Promise<number> {
  const { status, body } = await webhookSend(options);
  const ok = status >= 200 && status < 300;
  if (options.json) {
    io.out(JSON.stringify({ status, body }, null, 2));
    return ok ? 0 : 1;
  }
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (ok && typeof b["taskId"] === "string") {
    io.out(`accepted (${status}): task ${b["taskId"]}, run ${String(b["engineeringRunId"])}`);
  } else if (ok) {
    io.out(`${status}: ${b["duplicate"] ? "duplicate delivery, already handled" : String(b["reason"] ?? b["intent"] ?? "ok")}`);
  } else {
    io.err(`refused (${status}): ${String(b["error"] ?? body)}`);
  }
  return ok ? 0 : 1;
}
