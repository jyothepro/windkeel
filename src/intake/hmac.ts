import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureEncoding = "hex" | "base64";

export interface HmacSignatureInput {
  secret: string | Buffer;
  body: Buffer | string;
  signature: string | undefined | null;
  prefix?: string;
  encoding: SignatureEncoding;
}

export function signHmacSha256(input: Omit<HmacSignatureInput, "signature">): string {
  return `${input.prefix ?? ""}${createHmac("sha256", input.secret).update(input.body).digest(input.encoding)}`;
}

export function verifyHmacSha256(input: HmacSignatureInput): boolean {
  const { signature } = input;
  if (typeof signature !== "string" || signature.length === 0) return false;
  const prefix = input.prefix ?? "";
  if (!signature.startsWith(prefix)) return false;
  const expected = Buffer.from(signHmacSha256(input), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

export const DEFAULT_TOLERANCE_SECONDS = 300;

export function withinTolerance(
  timestampSec: number,
  nowSec: number,
  toleranceSec: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!Number.isFinite(timestampSec) || !Number.isFinite(nowSec)) return false;
  return Math.abs(nowSec - timestampSec) <= toleranceSec;
}
