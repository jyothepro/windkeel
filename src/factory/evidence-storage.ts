import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import { updateVerificationRun, type VerificationRun } from "./repositories.js";

export interface EvidenceStorage {
  putPackage(localDir: string, bucket: string, key: string): Promise<void>;
  deletePackage(bucket: string, key: string): Promise<void>;
  listPackage(bucket: string, key: string): Promise<string[]>;
  getPackageFile(bucket: string, key: string, path: string): Promise<Buffer>;
  presignPackageFile(bucket: string, key: string, path: string, ttlSeconds: number): Promise<string>;
}

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function allPackageFiles(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      if (statSync(p).isDirectory()) return walk(p);
      return [relative(dir, p).split(sep).join("/")];
    });
  return walk(dir).sort();
}

export function evidenceManifestDigest(packageDir: string): string {
  return createHash("sha256").update(readFileSync(join(packageDir, "hashes.json"))).digest("hex");
}

export function evidenceObjectKey(engineeringRunId: string, verificationRunId: string): string {
  return `${engineeringRunId}/${verificationRunId}`;
}

export function parseEvidenceRef(ref: string): { bucket: string; key: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new MalformedEvidenceRefError(ref);
  }
  return { bucket: ref.slice(0, slash), key: ref.slice(slash + 1) };
}

export class MalformedEvidenceRefError extends Error {
  constructor(readonly ref: string) {
    super(`evidence_package_ref must be "bucket/key", got ${JSON.stringify(ref)}`);
    this.name = "MalformedEvidenceRefError";
  }
}

export class EvidenceFileNotFoundError extends Error {
  constructor(
    readonly bucket: string,
    readonly key: string,
    readonly path: string,
  ) {
    super(`no object at ${bucket}/${key}/${path}`);
    this.name = "EvidenceFileNotFoundError";
  }
}

export class S3EvidenceStorage implements EvidenceStorage {
  private readonly client: S3Client;

  constructor(config: S3StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
    });
  }

  async putPackage(localDir: string, bucket: string, key: string): Promise<void> {
    for (const rel of allPackageFiles(localDir)) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${key}/${rel}`,
          Body: readFileSync(join(localDir, rel)),
        }),
      );
    }
  }

  async listPackage(bucket: string, key: string): Promise<string[]> {
    const keys: string[] = [];
    const prefix = `${key}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const object of listed.Contents ?? []) if (object.Key) keys.push(object.Key);
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async getPackageFile(bucket: string, key: string, path: string): Promise<Buffer> {
    let body: unknown;
    try {
      const got = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: `${key}/${path}` }),
      );
      body = got.Body;
    } catch (err) {
      if (isNotFound(err)) throw new EvidenceFileNotFoundError(bucket, key, path);
      throw err;
    }
    if (body === undefined || body === null) throw new EvidenceFileNotFoundError(bucket, key, path);
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async presignPackageFile(
    bucket: string,
    key: string,
    path: string,
    ttlSeconds: number,
  ): Promise<string> {
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: `${key}/${path}` }), {
      expiresIn: ttlSeconds,
    });
  }

  async deletePackage(bucket: string, key: string): Promise<void> {
    const prefix = `${key}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      const objects = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

export async function sealEvidenceReference(
  pool: Pool,
  storage: EvidenceStorage,
  verificationRunId: string,
  engineeringRunId: string,
  localPackageDir: string,
  bucket: string,
): Promise<VerificationRun> {
  const digest = evidenceManifestDigest(localPackageDir);
  const key = evidenceObjectKey(engineeringRunId, verificationRunId);
  await storage.putPackage(localPackageDir, bucket, key);
  return updateVerificationRun(pool, verificationRunId, {
    evidencePackageRef: `${bucket}/${key}`,
    evidenceManifestDigest: digest,
  });
}
