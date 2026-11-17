

import { signHmacSha256, verifyHmacSha256 } from "@windkeel/factory/intake";

export const SIGNATURE_HEADER = "x-hub-signature-256";

const GITHUB_PREFIX = "sha256=";

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  headerValue: string | undefined,
): boolean {
  return verifyHmacSha256({
    secret,
    body: rawBody,
    signature: headerValue,
    prefix: GITHUB_PREFIX,
    encoding: "hex",
  });
}

export function signWebhookBody(secret: string, rawBody: Buffer | string): string {
  return signHmacSha256({ secret, body: rawBody, prefix: GITHUB_PREFIX, encoding: "hex" });
}
