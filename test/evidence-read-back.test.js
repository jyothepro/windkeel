import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MalformedEvidenceRefError,
  parseEvidenceRef,
} from "../dist/factory/evidence-storage.js";

test("an evidence ref splits at the first slash — the bucket is one segment, the key is the rest", () => {
  // sealEvidenceReference writes `${bucket}/${key}`, and evidenceObjectKey builds the key as
  // `${engineeringRunId}/${verificationRunId}`. So a real ref has three segments and splitting
  // on the last slash, or treating the whole ref as a key, both produce a prefix that matches
  // no object — and an intact package reads as an empty one.
  assert.deepEqual(parseEvidenceRef("windkeel-evidence/run-abc/verify-def"), {
    bucket: "windkeel-evidence",
    key: "run-abc/verify-def",
  });
});

test("a ref with no key, no bucket, or no separator is named rather than guessed at", () => {
  for (const bad of ["", "bucket", "/key", "bucket/", "/"]) {
    assert.throws(
      () => parseEvidenceRef(bad),
      MalformedEvidenceRefError,
      `${JSON.stringify(bad)} is not bucket/key`,
    );
  }
});

test("the storage seam can read back, not only write and list", async () => {
  const { S3EvidenceStorage } = await import("../dist/factory/evidence-storage.js");
  const storage = Object.create(S3EvidenceStorage.prototype);
  assert.equal(
    typeof storage.getPackageFile,
    "function",
    "#276: a bucket that accepts writes and serves nothing is indistinguishable from a working one",
  );
});
