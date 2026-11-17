
import { createHash } from "node:crypto";
import { type WorkerConfig } from "../../factory/worker-config.js";
import { type CheckResult, type DoctorEnvironment, fail, pass, skip } from "./report.js";

export const STORAGE_CHECK = { id: "storage", title: "Evidence object store" };

export async function checkObjectStore(
  environment: DoctorEnvironment,
  config: WorkerConfig,
  writeTempPackage: () => Promise<string>,
): Promise<CheckResult> {
  if (!config.evidence) {
    return skip(
      STORAGE_CHECK.id,
      STORAGE_CHECK.title,
      "S3_BUCKET is unset, so no object store is configured",
      [
        "Consequence: verifications will run and record a verdict, but no evidence package " +
          "will be stored and VerificationRun.evidence_package_ref will stay null — a verdict " +
          "nobody can later reconstruct.",
      ],
    );
  }

  const storage = environment.storage(config.evidence);
  const key = `windkeel-doctor/${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16)}`;
  const dir = await writeTempPackage();
  try {
    await storage.putPackage(dir, config.evidence.bucket, key);
    const listed = await storage.listPackage(config.evidence.bucket, key);
    if (listed.length === 0) {
      return fail(
        STORAGE_CHECK.id,
        STORAGE_CHECK.title,
        "the object store accepted a write and returned nothing on read-back",
        [
          "A bucket that writes and does not serve looks identical to a working one until " +
            "someone tries to verify a stored package months later.",
        ],
      );
    }
    return pass(
      STORAGE_CHECK.id,
      STORAGE_CHECK.title,
      `wrote, read back, and deleted one object in bucket ${config.evidence.bucket}`,
    );
  } finally {
    await storage.deletePackage(config.evidence.bucket, key).catch(() => {});
  }
}
