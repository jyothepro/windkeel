/**
 * The sealed box, tested for the properties ADR-0023 §9 actually rests on.
 *
 * The one worth stating: **a round trip passing is not the interesting assertion here.** Any
 * encrypt/decrypt pair round-trips. What makes this construction the right answer to §9 is that the
 * *public* key is sufficient to write and insufficient to read, and that a value sealed under one
 * name cannot be opened under another — so those are what is asserted, along with the specific
 * corruptions a stored ciphertext could plausibly suffer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SealedSecretError,
  generateSecretKeyPair,
  keypairIdOf,
  openSecret,
  sealSecret,
  sealSecretV2,
  sealedKeypairId,
} from "../dist/factory/secret-box.js";
import { runAdminCli } from "./helpers.js";

const SECRET = "npm_ZxK9QqRt7vB2mN4pL8sW1yH6jD3fA5gC";

test("a value seals with the public key and opens with the private one", () => {
  const pair = generateSecretKeyPair();
  const sealed = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  assert.equal(openSecret(pair.privateKey, "NPM_TOKEN", sealed), SECRET);
});

test("the public key alone cannot open what it sealed", () => {
  const pair = generateSecretKeyPair();
  const sealed = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  /*
   * This is the property ADR-0023 §9 is built on: the process that accepts a secret holds only this
   * half. Passing it to `openSecret` must be a typed refusal about the key's *shape*, not an attempt
   * that happens to fail — and certainly not a success.
   */
  assert.throws(
    () => openSecret(pair.publicKey, "NPM_TOKEN", sealed),
    (err) => err instanceof SealedSecretError && /private key/.test(err.message),
  );
});

test("another key pair's private key does not open it", () => {
  const mine = generateSecretKeyPair();
  const theirs = generateSecretKeyPair();
  const sealed = sealSecret(mine.publicKey, "NPM_TOKEN", SECRET);
  assert.throws(
    () => openSecret(theirs.privateKey, "NPM_TOKEN", sealed),
    (err) => err instanceof SealedSecretError && /authentication failed/.test(err.message),
  );
});

test("the key name is bound in, so a value cannot be moved to another name", () => {
  const pair = generateSecretKeyPair();
  const sealed = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  // Someone with write access to the table renames the row. Without the AAD binding this would
  // open, and the value would be injected as PATH.
  assert.throws(
    () => openSecret(pair.privateKey, "PATH", sealed),
    (err) => err instanceof SealedSecretError && /"PATH"/.test(err.message),
  );
});

test("two seals of the same value differ", () => {
  const pair = generateSecretKeyPair();
  const a = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  const b = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  assert.notEqual(a, b, "a fresh ephemeral key and IV per seal is what makes rotation observable");
  assert.equal(openSecret(pair.privateKey, "NPM_TOKEN", a), SECRET);
  assert.equal(openSecret(pair.privateKey, "NPM_TOKEN", b), SECRET);
});

test("a flipped bit anywhere in the ciphertext fails authentication", () => {
  const pair = generateSecretKeyPair();
  const sealed = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  const parts = sealed.split(".");
  // Every part in turn: the ephemeral key, the IV, the tag and the body. A construction that
  // authenticated only the body would let the first two be swapped for another seal's.
  for (let i = 1; i < parts.length; i++) {
    const tampered = [...parts];
    const bytes = Buffer.from(tampered[i], "base64url");
    bytes[0] ^= 0x01;
    tampered[i] = bytes.toString("base64url");
    assert.throws(
      () => openSecret(pair.privateKey, "NPM_TOKEN", tampered.join(".")),
      SealedSecretError,
      `part ${i} was tampered with and opened anyway`,
    );
  }
});

test("a malformed envelope is refused by shape before any key is used", () => {
  const pair = generateSecretKeyPair();
  for (const bad of ["", "nonsense", "orqonsealv1.a.b.c", "orqonsealv3.a.b.c.d"]) {
    assert.throws(
      () => openSecret(pair.privateKey, "NPM_TOKEN", bad),
      (err) => err instanceof SealedSecretError && /5 dot-separated parts/.test(err.message),
      JSON.stringify(bad),
    );
  }
  // v2 exists now (ADR-0026 §2), so a v2 prefix is held to v2's shape.
  for (const bad of ["orqonsealv2.a.b.c.d", "orqonsealv2.notahexid0000000.a.b.c.d"]) {
    assert.throws(
      () => openSecret(pair.privateKey, "model_credential:o:c", bad),
      (err) => err instanceof SealedSecretError && /6 dot-separated parts/.test(err.message),
      JSON.stringify(bad),
    );
  }
});

test("a non-X25519 key is refused rather than used", () => {
  assert.throws(
    () => sealSecret("not-base64-der-anything", "NPM_TOKEN", SECRET),
    (err) => err instanceof SealedSecretError && /public key/.test(err.message),
  );
});

test("no error message ever quotes the plaintext or the key material", () => {
  const pair = generateSecretKeyPair();
  const other = generateSecretKeyPair();
  const sealed = sealSecret(pair.publicKey, "NPM_TOKEN", SECRET);
  /*
   * This runs in the deployment whose logs get pasted into issues, so a message that quoted any of
   * its inputs would be the one place a secret escapes. Checked against the actual values rather
   * than against a list of substrings somebody thought to avoid.
   */
  const messages = [];
  for (const attempt of [
    () => openSecret(other.privateKey, "NPM_TOKEN", sealed),
    () => openSecret(pair.privateKey, "OTHER_NAME", sealed),
    () => openSecret("garbage", "NPM_TOKEN", sealed),
    () => sealSecret("garbage", "NPM_TOKEN", SECRET),
  ]) {
    try {
      attempt();
      assert.fail("expected a refusal");
    } catch (err) {
      messages.push(err.message);
    }
  }
  const all = messages.join("\n");
  for (const forbidden of [SECRET, pair.privateKey, other.privateKey, sealed]) {
    assert.ok(!all.includes(forbidden), "an error message carried something it must not");
  }
});

test("the key pair is base64 on one line, so an env var cannot mangle it", () => {
  const pair = generateSecretKeyPair();
  for (const half of [pair.publicKey, pair.privateKey]) {
    assert.doesNotMatch(half, /\s/, "a multi-line PEM breaks when pasted into an env var");
    assert.match(half, /^[A-Za-z0-9+/]+=*$/);
  }
});

// --- secrets keygen (ADR-0023 §9) ------------------------------------------

test("`secrets keygen` needs no database and prints a usable pair once", () => {
  /*
   * No `DATABASE_URL` in the environment, deliberately. This is the first command an operator runs
   * on the way to configuring a deployment, and a key generator that required a configured database
   * would be a setup step that depends on the setup.
   */
  const result = runAdminCli(["secrets", "keygen"], { env: { DATABASE_URL: "" } });
  assert.equal(result.code, 0, result.stderr);

  const publicKey = result.stdout.match(/^WINDKEEL_SECRET_PUBLIC_KEY=(.+)$/m)?.[1];
  const privateKey = result.stdout.match(/^WINDKEEL_SECRET_PRIVATE_KEY=(.+)$/m)?.[1];
  assert.ok(publicKey && privateKey, result.stdout);

  // Usable, not merely printed: the halves have to actually be a pair.
  const sealed = sealSecret(publicKey, "NPM_TOKEN", "value");
  assert.equal(openSecret(privateKey, "NPM_TOKEN", sealed), "value");

  /*
   * Which half does what is the thing an operator pastes by, so the output says it next to each
   * line. Since #213 both halves sit in one deployment's environment (ADR-0026, Consequences), so
   * the label is what each half is for, not which process it belongs on.
   */
  assert.match(result.stdout, /# Seals secrets and model credentials \(the API routes\); cannot open them\./);
  assert.match(result.stdout, /# Opens them \(the workflow steps only\)\. Mark it a sensitive variable\./);
});

test("`secrets` with no subcommand prints usage rather than doing something", () => {
  const result = runAdminCli(["secrets"], { env: { DATABASE_URL: "" } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /secrets keygen/);
});

test("the admin usage says the private key must not go to ingress", () => {
  const result = runAdminCli(["help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /secrets keygen/);
  // A rotation that silently orphans every stored secret is the surprise worth pre-empting.
  assert.match(result.stdout, /does not re-seal what is already stored/);
});

// --- v2: a context bound in, and which key pair sealed it (ADR-0026 §2) -----------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CRED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MODEL_KEY = "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";
const context = (org, id = CRED) => `model_credential:${org}:${id}`;

test("v2 round-trips under its context and records which key pair sealed it", () => {
  const pair = generateSecretKeyPair();
  const { sealed, keypairId } = sealSecretV2(pair.publicKey, context(ORG_A), MODEL_KEY);
  assert.match(sealed, /^orqonsealv2\.[0-9a-f]{16}\./);
  assert.equal(keypairId, keypairIdOf(pair.publicKey));
  assert.equal(keypairIdOf(pair.privateKey), keypairId, "either half names the same pair");
  assert.equal(sealedKeypairId(sealed), keypairId);
  assert.equal(openSecret(pair.privateKey, context(ORG_A), sealed), MODEL_KEY);
  assert.equal(openSecret([pair.privateKey], context(ORG_A), sealed), MODEL_KEY);
});

test("a v2 ciphertext moved to another organization's context fails to open", () => {
  /*
   * #320's pass criterion. Someone with write access to the table copies org A's sealed value into a
   * row of org B. The stage deployment opens B's row under B's context — and the AEAD refuses.
   */
  const pair = generateSecretKeyPair();
  const { sealed } = sealSecretV2(pair.publicKey, context(ORG_A), MODEL_KEY);
  assert.throws(
    () => openSecret(pair.privateKey, context(ORG_B), sealed),
    (err) => err instanceof SealedSecretError && /authentication failed/.test(err.message),
  );
  // And to another credential id in the same organization.
  assert.throws(
    () => openSecret(pair.privateKey, context(ORG_A, ORG_B), sealed),
    (err) => err instanceof SealedSecretError && /authentication failed/.test(err.message),
  );
});

test("the recorded keypair id is authenticated: rewriting it does not redirect the open", () => {
  const current = generateSecretKeyPair();
  const previous = generateSecretKeyPair();
  const { sealed } = sealSecretV2(current.publicKey, context(ORG_A), MODEL_KEY);
  const parts = sealed.split(".");
  parts[1] = keypairIdOf(previous.publicKey);
  assert.throws(
    () => openSecret([current.privateKey, previous.privateKey], context(ORG_A), parts.join(".")),
    SealedSecretError,
  );
});

test("keypair rotation: the current and the previous key each open what was sealed to them", () => {
  const previous = generateSecretKeyPair();
  const current = generateSecretKeyPair();
  const old = sealSecretV2(previous.publicKey, context(ORG_A), "old-value-1234").sealed;
  const fresh = sealSecretV2(current.publicKey, context(ORG_A), "new-value-5678").sealed;
  const held = [current.privateKey, previous.privateKey];
  assert.equal(openSecret(held, context(ORG_A), old), "old-value-1234");
  assert.equal(openSecret(held, context(ORG_A), fresh), "new-value-5678");

  // Once the previous key is dropped, the old value says which pair it needs — by id, not a guess.
  assert.throws(
    () => openSecret([current.privateKey], context(ORG_A), old),
    (err) =>
      err instanceof SealedSecretError &&
      err.message.includes(keypairIdOf(previous.publicKey)) &&
      /does not hold/.test(err.message),
  );
});

test("v1 values keep opening exactly as before, including with a list of keys", () => {
  const previous = generateSecretKeyPair();
  const current = generateSecretKeyPair();
  const sealed = sealSecret(previous.publicKey, "NPM_TOKEN", SECRET);
  assert.equal(sealedKeypairId(sealed), null, "v1 records no key pair");
  assert.equal(openSecret(previous.privateKey, "NPM_TOKEN", sealed), SECRET);
  assert.equal(openSecret([current.privateKey, previous.privateKey], "NPM_TOKEN", sealed), SECRET);
  assert.throws(
    () => openSecret([current.privateKey], "NPM_TOKEN", sealed),
    (err) => err instanceof SealedSecretError && /authentication failed for "NPM_TOKEN"/.test(err.message),
  );
});

test("a v1 value is not a v2 value: the formats cannot be confused for each other", () => {
  const pair = generateSecretKeyPair();
  const v1 = sealSecret(pair.publicKey, context(ORG_A), "value-abcdefgh");
  const { sealed: v2 } = sealSecretV2(pair.publicKey, context(ORG_A), "value-abcdefgh");
  // Same key, same context string: rewriting either envelope as the other must not open.
  const v1AsV2 = ["orqonsealv2", keypairIdOf(pair.publicKey), ...v1.split(".").slice(1)].join(".");
  const v2AsV1 = ["orqonsealv1", ...v2.split(".").slice(2)].join(".");
  assert.throws(() => openSecret(pair.privateKey, context(ORG_A), v1AsV2), SealedSecretError);
  assert.throws(() => openSecret(pair.privateKey, context(ORG_A), v2AsV1), SealedSecretError);
});

test("a flipped bit in any v2 part fails, and no v2 error quotes the value or a key", () => {
  const pair = generateSecretKeyPair();
  const other = generateSecretKeyPair();
  const { sealed } = sealSecretV2(pair.publicKey, context(ORG_A), MODEL_KEY);
  const parts = sealed.split(".");
  const messages = [];
  for (let i = 2; i < parts.length; i++) {
    const tampered = [...parts];
    const bytes = Buffer.from(tampered[i], "base64url");
    bytes[0] ^= 0x01;
    tampered[i] = bytes.toString("base64url");
    assert.throws(
      () => openSecret(pair.privateKey, context(ORG_A), tampered.join(".")),
      (err) => {
        messages.push(err.message);
        return err instanceof SealedSecretError;
      },
      `part ${i} was tampered with and opened anyway`,
    );
  }
  for (const attempt of [
    () => openSecret(other.privateKey, context(ORG_A), sealed),
    () => openSecret(pair.privateKey, context(ORG_B), sealed),
    () => openSecret([], context(ORG_A), sealed),
    // A value passed as the context by mistake is refused by shape and not quoted back.
    () => sealSecretV2(pair.publicKey, `${MODEL_KEY} oops`, MODEL_KEY),
  ]) {
    try {
      attempt();
      assert.fail("expected a refusal");
    } catch (err) {
      messages.push(err.message);
    }
  }
  const all = messages.join("\n");
  for (const forbidden of [MODEL_KEY, pair.privateKey, other.privateKey, sealed]) {
    assert.ok(!all.includes(forbidden), "an error message carried something it must not");
  }
});
