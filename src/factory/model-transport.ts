import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ModelFetch } from "@windkeel/verification/providers/types.js";
import { guardedLookup } from "./model-endpoint-guard.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const NULL_BODY = new Set([101, 204, 205, 304]);

export function guardedModelFetch(
  options: { allowLocalhostHttp?: boolean; timeoutMs?: number } = {},
): ModelFetch {
  const lookup = guardedLookup({ allowLocalhostHttp: options.allowLocalhostHttp ?? false });
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const send = target.protocol === "http:" ? httpRequest : httpsRequest;
      const req = send(
        target,
        {
          method: init.method,
          headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
          lookup,
          timeout,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              res.destroy(Object.assign(new Error("model response too large"), { code: "ERESPONSETOOLARGE" }));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const headers = new Headers();
            const type = res.headers["content-type"];
            if (typeof type === "string") headers.set("content-type", type);
            resolve(
              new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
                status: status >= 200 && status <= 599 ? status : 502,
                headers,
              }),
            );
          });
        },
      );
      req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      req.end(init.body);
    });
}
