import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export interface ReadRawBodyOptions {
  limitBytes?: number;
}

export function readRawBody(req: IncomingMessage, options: ReadRawBodyOptions = {}): Promise<Buffer> {
  const { limitBytes } = options;
  return new Promise((resolve, reject) => {
    if (limitBytes !== undefined) {
      const declared = Number(req.headers?.["content-length"]);
      if (Number.isFinite(declared) && declared > limitBytes) {
        reject(new BodyTooLargeError(limitBytes));
        return;
      }
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      received += chunk.length;
      if (limitBytes !== undefined && received > limitBytes) {
        settled = true;
        req.off("data", onData);
        req.resume();
        reject(new BodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export function lowerCaseHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}
