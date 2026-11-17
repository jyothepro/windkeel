import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const VERSION = "orqonsealv1";

const KDF_INFO = "windkeel repository secret v1";

const VERSION_V2 = "orqonsealv2";

const KDF_INFO_V2 = "windkeel sealed secret v2";

const KEYPAIR_ID_SHAPE = /^[0-9a-f]{16}$/;

export class SealedSecretError extends Error {
  constructor(problem: string) {
    super(`sealed secret: ${problem}`);
    this.name = "SealedSecretError";
  }
}

export interface SecretKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSecretKeyPair(): SecretKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: publicKey.toString("base64"),
    privateKey: privateKey.toString("base64"),
  };
}

export function sealSecret(publicKeyBase64: string, keyName: string, plaintext: string): string {
  const recipient = parsePublicKey(publicKeyBase64);
  const ephemeral = generateKeyPairSync("x25519");

  const ephemeralPublicDer = ephemeral.publicKey.export({ type: "spki", format: "der" });
  const recipientPublicDer = recipient.export({ type: "spki", format: "der" });
  const key = deriveKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    ephemeralPublicDer,
    recipientPublicDer,
  );

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${VERSION}:${keyName}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [
    VERSION,
    ephemeralPublicDer.toString("base64url"),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openSecret(
  privateKeys: string | readonly string[],
  context: string,
  sealed: string,
): string {
  const keys = (typeof privateKeys === "string" ? [privateKeys] : [...privateKeys]).filter(
    (key) => key.trim() !== "",
  );
  if (keys.length === 0) throw new SealedSecretError("no private key was supplied");
  if (sealed.startsWith(`${VERSION_V2}.`)) return openV2(keys, context, sealed);

  let failure: unknown;
  for (const key of keys) {
    try {
      return openV1(key, context, sealed);
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

export function keypairIdOf(keyBase64: string): string {
  let spki: Buffer;
  try {
    spki = parsePublicKey(keyBase64).export({ type: "spki", format: "der" });
  } catch {
    spki = createPublicKey(parsePrivateKey(keyBase64)).export({ type: "spki", format: "der" });
  }
  return keypairIdOfSpki(spki);
}

function keypairIdOfSpki(spki: Buffer): string {
  return createHash("sha256").update(spki).digest("hex").slice(0, 16);
}

export function publicKeyFromPrivate(privateKeyBase64: string): string {
  return createPublicKey(parsePrivateKey(privateKeyBase64)).export({ type: "spki", format: "der" }).toString("base64");
}

export function sealedKeypairId(sealed: string): string | null {
  const parts = sealed.split(".");
  return parts[0] === VERSION_V2 && KEYPAIR_ID_SHAPE.test(parts[1] ?? "") ? parts[1]! : null;
}

export function sealSecretV2(
  publicKeyBase64: string,
  context: string,
  plaintext: string,
): { sealed: string; keypairId: string } {
  assertContext(context);
  const recipient = parsePublicKey(publicKeyBase64);
  const recipientPublicDer = recipient.export({ type: "spki", format: "der" });
  const keypairId = keypairIdOfSpki(recipientPublicDer);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublicDer = ephemeral.publicKey.export({ type: "spki", format: "der" });
  const key = deriveKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    ephemeralPublicDer,
    recipientPublicDer,
    KDF_INFO_V2,
  );

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aadV2(keypairId, context), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  const sealed = [
    VERSION_V2,
    keypairId,
    ephemeralPublicDer.toString("base64url"),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
  return { sealed, keypairId };
}

function openV2(privateKeys: readonly string[], context: string, sealed: string): string {
  assertContext(context);
  const parts = sealed.split(".");
  if (parts.length !== 6 || !KEYPAIR_ID_SHAPE.test(parts[1] ?? "")) {
    throw new SealedSecretError(
      `expected 6 dot-separated parts beginning "${VERSION_V2}.<keypair id>" and got ${parts.length}`,
    );
  }
  const [, keypairId, ephemeralB64, ivB64, tagB64, ciphertextB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const held = privateKeys.map((key) => {
    const recipientPrivate = parsePrivateKey(key);
    const spki = createPublicKey(recipientPrivate).export({ type: "spki", format: "der" });
    return { recipientPrivate, id: keypairIdOfSpki(spki) };
  });
  const match = held.find((key) => key.id === keypairId);
  if (!match) {
    throw new SealedSecretError(
      `sealed to key pair ${keypairId}, which this deployment does not hold (it holds ` +
        `${held.map((key) => key.id).join(", ")}); set WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY to the ` +
        "pair it was sealed to, or store the value again",
    );
  }
  return decrypt({
    recipientPrivate: match.recipientPrivate,
    ephemeralB64,
    ivB64,
    tagB64,
    ciphertextB64,
    kdfInfo: KDF_INFO_V2,
    aad: aadV2(keypairId, context),
    failure: () =>
      new SealedSecretError(
        `authentication failed for ${context}: the value was sealed under a different context ` +
          "(it was moved from another row) or the stored value was altered",
      ),
  });
}

function aadV2(keypairId: string, context: string): string {
  return `${VERSION_V2}:${keypairId}:${context}`;
}

function assertContext(context: string): void {
  if (!/^[A-Za-z0-9_:.-]{1,200}$/.test(context)) {
    throw new SealedSecretError("a context must be 1-200 characters of [A-Za-z0-9_:.-]");
  }
}

function openV1(privateKeyBase64: string, keyName: string, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new SealedSecretError(
      `expected 5 dot-separated parts beginning "${VERSION}" and got ${parts.length} beginning ` +
        `"${parts[0] ?? ""}"`,
    );
  }
  const [, ephemeralB64, ivB64, tagB64, ciphertextB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  return decrypt({
    recipientPrivate: parsePrivateKey(privateKeyBase64),
    ephemeralB64,
    ivB64,
    tagB64,
    ciphertextB64,
    kdfInfo: KDF_INFO,
    aad: `${VERSION}:${keyName}`,
    failure: () =>
      new SealedSecretError(
        `authentication failed for "${keyName}": the private key does not match the one it was ` +
          "sealed to, the key name differs, or the stored value was altered",
      ),
  });
}

function decrypt(input: {
  recipientPrivate: KeyObject;
  ephemeralB64: string;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
  kdfInfo: string;
  aad: string;
  failure: () => SealedSecretError;
}): string {
  const ephemeralPublicDer = Buffer.from(input.ephemeralB64, "base64url");
  let ephemeralPublic: KeyObject;
  try {
    ephemeralPublic = createPublicKey({ key: ephemeralPublicDer, format: "der", type: "spki" });
  } catch {
    throw new SealedSecretError("the ephemeral public key is not a valid X25519 SPKI key");
  }

  let key: Buffer;
  try {
    key = deriveKey(
      diffieHellman({ privateKey: input.recipientPrivate, publicKey: ephemeralPublic }),
      ephemeralPublicDer,
      createPublicKey(input.recipientPrivate).export({ type: "spki", format: "der" }),
      input.kdfInfo,
    );
  } catch {
    throw new SealedSecretError("the ephemeral public key is not a valid X25519 SPKI key");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(input.ivB64, "base64url"));
    decipher.setAAD(Buffer.from(input.aad, "utf8"));
    decipher.setAuthTag(Buffer.from(input.tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertextB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw input.failure();
  }
}

function deriveKey(
  shared: Buffer,
  ephemeralPublicDer: Buffer,
  recipientPublicDer: Buffer,
  info: string = KDF_INFO,
): Buffer {
  const salt = Buffer.concat([ephemeralPublicDer, recipientPublicDer]);
  return Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(info, "utf8"), 32));
}

function parsePublicKey(base64: string): KeyObject {
  try {
    const key = createPublicKey({
      key: Buffer.from(base64.trim(), "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "x25519") {
      throw new Error(`not X25519 (got ${key.asymmetricKeyType ?? "unknown"})`);
    }
    return key;
  } catch (err) {
    throw new SealedSecretError(
      `not a valid base64 DER X25519 public key — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parsePrivateKey(base64: string): KeyObject {
  try {
    const key = createPrivateKey({
      key: Buffer.from(base64.trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "x25519") {
      throw new Error(`not X25519 (got ${key.asymmetricKeyType ?? "unknown"})`);
    }
    return key;
  } catch (err) {
    throw new SealedSecretError(
      `not a valid base64 DER X25519 private key — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
