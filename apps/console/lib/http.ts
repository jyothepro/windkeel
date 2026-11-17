export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiAnswer {
  ok: boolean;
  status: number;
  statusText: string;
  json: Record<string, unknown>;
}

export async function callApi(
  base: string,
  token: string,
  method: Method,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ApiAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError(502, "unreachable", `The control plane at ${base} didn't answer (${(err as Error).message}).`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ApiError(res.status, "bad_gateway", `The control plane answered ${res.status} with something other than the API's JSON.`);
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, json };
}

export function refusal(answer: ApiAnswer): ApiError {
  return new ApiError(answer.status, String(answer.json["code"] ?? answer.status), String(answer.json["error"] ?? answer.statusText));
}
