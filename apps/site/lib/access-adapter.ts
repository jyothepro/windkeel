import type { AccessRequest } from "./request-access.ts";

export type AccessRequestAdapter = {
  name: string;
  submit(request: AccessRequest & { receivedAt: string }): Promise<void>;
};

export function consoleAdapter(log: (line: string) => void = (line) => console.info(line)): AccessRequestAdapter {
  return {
    name: "console",
    async submit(request) {
      log(`access-request ${JSON.stringify(request)}`);
    },
  };
}

export function webhookAdapter(url: string, fetcher: typeof fetch = fetch): AccessRequestAdapter {
  return {
    name: "webhook",
    async submit(request) {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "access_request", ...request }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`webhook answered ${response.status}`);
    },
  };
}

export function adapterFromEnv(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): AccessRequestAdapter {
  const url = env.ACCESS_REQUEST_WEBHOOK_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("ACCESS_REQUEST_WEBHOOK_URL must use https");
    }
    return webhookAdapter(parsed.toString(), fetcher);
  }
  return consoleAdapter();
}
