/**
 * The shared signature helpers every signed intake uses (src/intake/hmac.ts, #293).
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  signHmacSha256,
  verifyHmacSha256,
  withinTolerance,
} from "../dist/intake/hmac.js";
import { signWebhookBody, verifyWebhookSignature } from "../apps/ingress/dist/src/signature.js";

const SECRET = "it's a secret to everybody";
const BODY = JSON.stringify({ hello: "world", n: 1 });

test("a valid hex signature verifies", () => {
  const signature = createHmac("sha256", SECRET).update(BODY).digest("hex");
  assert.equal(verifyHmacSha256({ secret: SECRET, body: BODY, signature, encoding: "hex" }), true);
  assert.equal(
    verifyHmacSha256({ secret: SECRET, body: Buffer.from(BODY), signature, encoding: "hex" }),
    true,
    "a Buffer body is the same bytes",
  );
});

test("a valid base64 signature verifies", () => {
  const signature = createHmac("sha256", SECRET).update(BODY).digest("base64");
  assert.equal(verifyHmacSha256({ secret: SECRET, body: BODY, signature, encoding: "base64" }), true);
  assert.equal(verifyHmacSha256({ secret: SECRET, body: BODY, signature, encoding: "hex" }), false);
});

test("a tampered body or a wrong secret does not verify", () => {
  const signature = signHmacSha256({ secret: SECRET, body: BODY, encoding: "hex" });
  assert.equal(verifyHmacSha256({ secret: SECRET, body: `${BODY} `, signature, encoding: "hex" }), false);
  assert.equal(verifyHmacSha256({ secret: "other", body: BODY, signature, encoding: "hex" }), false);
  // One flipped hex digit, same length.
  const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
  assert.equal(verifyHmacSha256({ secret: SECRET, body: BODY, signature: flipped, encoding: "hex" }), false);
});

test("a signature of the wrong length is rejected without throwing", () => {
  const signature = signHmacSha256({ secret: SECRET, body: BODY, encoding: "hex" });
  for (const wrong of [signature.slice(0, 20), `${signature}00`, "", undefined, null]) {
    assert.equal(
      verifyHmacSha256({ secret: SECRET, body: BODY, signature: wrong, encoding: "hex" }),
      false,
      String(wrong),
    );
  }
});

test("a prefix is required when named, and must be the right one", () => {
  const signature = signHmacSha256({ secret: SECRET, body: BODY, prefix: "sha256=", encoding: "hex" });
  assert.ok(signature.startsWith("sha256="));
  assert.equal(
    verifyHmacSha256({ secret: SECRET, body: BODY, signature, prefix: "sha256=", encoding: "hex" }),
    true,
  );
  const bare = signature.slice("sha256=".length);
  assert.equal(
    verifyHmacSha256({ secret: SECRET, body: BODY, signature: bare, prefix: "sha256=", encoding: "hex" }),
    false,
  );
  assert.equal(
    verifyHmacSha256({
      secret: SECRET,
      body: BODY,
      signature: signature.replace("sha256=", "sha1="),
      prefix: "sha256=",
      encoding: "hex",
    }),
    false,
  );
  assert.equal(
    verifyHmacSha256({ secret: SECRET, body: BODY, signature, prefix: "v0=", encoding: "hex" }),
    false,
  );
});

test("GitHub's signature is exactly what it was before the move", () => {
  const expected = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;
  assert.equal(signWebhookBody(SECRET, BODY), expected);
  assert.equal(verifyWebhookSignature(SECRET, BODY, expected), true);
  assert.equal(verifyWebhookSignature(SECRET, BODY, expected.slice(7)), false);
});

test("withinTolerance: five minutes either way, and never for a non-number", () => {
  const now = 1_800_000_000;
  assert.equal(withinTolerance(now, now), true);
  assert.equal(withinTolerance(now - 300, now, 300), true);
  assert.equal(withinTolerance(now + 300, now, 300), true);
  assert.equal(withinTolerance(now - 301, now, 300), false);
  assert.equal(withinTolerance(now + 301, now, 300), false);
  assert.equal(withinTolerance(now - 299, now), true, "300 is the default");
  assert.equal(withinTolerance(Number.NaN, now, 300), false);
  assert.equal(withinTolerance(Number("abc"), now, 300), false);
});
