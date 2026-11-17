import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_FORMAT,
  type EvidenceItem,
  type Hashes,
  type Manifest,
  type MappingFile,
  type Verdict,
  type VerdictFile,
} from "@windkeel/verification/evidence/format.js";
import { computeHashes, sha256 } from "@windkeel/verification/evidence/hashes.js";
import { SPINE_FILES, readEvidence, readJson } from "@windkeel/verification/evidence/package.js";
import {
  COMMAND_STAGES,
  TRANSCRIPT_BINDING_VERSION,
  atLeastVersion,
  parseExitTrailer,
  statusIncoherence,
} from "@windkeel/verification/evidence/transcript.js";
import { computeVerdict } from "@windkeel/verification/evidence/verdict.js";
import { verifySignature } from "@windkeel/verification/attest/sigstore.js";

export interface VerifyPackageOptions {
  certificateIdentity?: string | undefined;
  certificateOidcIssuer?: string | undefined;
  requireSignature?: boolean | undefined;
}


export interface PackageReport {
  problems: string[];
  verdict: Verdict;
  storedVerdict: string;
  manifest: Manifest;
  mapping: MappingFile;
  lines: string[];
}

function transcriptProblems(
  dir: string,
  manifest: Manifest,
  evidence: EvidenceItem[],
): string[] {
  const problems: string[] = [];
  const bound = atLeastVersion(manifest.tool.version, TRANSCRIPT_BINDING_VERSION);

  for (const item of evidence) {
    if (!item.transcript) continue;
    const path = join(dir, item.transcript);
    if (!existsSync(path)) {
      problems.push(`missing transcript ${item.transcript}`);
      continue;
    }

    if (item.transcript_sha256) {
      if (sha256(readFileSync(path)) !== item.transcript_sha256) {
        problems.push(`transcript digest mismatch: ${item.id} does not match ${item.transcript}`);
      }
    } else if (bound) {
      problems.push(`evidence ${item.id} does not bind its transcript ${item.transcript}`);
    }

    if (!bound || !COMMAND_STAGES.has(item.stage)) continue;
    const trailer = parseExitTrailer(readFileSync(path, "utf8"));
    if (trailer === null) {
      problems.push(`transcript ${item.transcript} ends with no windkeel exit trailer`);
      continue;
    }
    if (typeof trailer === "number" && item.producer && item.producer.exit_code !== trailer) {
      problems.push(
        `transcript ${item.transcript} records exit ${trailer} but ${item.id} records exit ${item.producer.exit_code}`,
      );
    }
    const incoherent = statusIncoherence(trailer, item.status);
    if (incoherent) problems.push(`${item.id}: ${incoherent}`);
  }

  return problems;
}

function artifactProblems(dir: string, evidence: EvidenceItem[]): string[] {
  const problems: string[] = [];
  for (const item of evidence) {
    for (const artifact of item.artifacts ?? []) {
      const path = join(dir, artifact.path);
      if (!existsSync(path)) {
        if (artifact.included) problems.push(`missing artifact ${artifact.path}`);
        continue;
      }
      if (sha256(readFileSync(path)) !== artifact.sha256) {
        problems.push(`artifact digest mismatch: ${item.id} does not match ${artifact.path}`);
      }
    }
  }
  return problems;
}

export function verifyPackage(dir: string, options: VerifyPackageOptions = {}): PackageReport {
  const missing = SPINE_FILES.filter((file) => !existsSync(join(dir, file)));
  if (missing.length) {
    throw new Error(`evidence package is incomplete: missing ${missing.join(", ")}`);
  }

  const manifest = readJson<Manifest>(dir, "manifest.json");
  const problems: string[] = [];

  if (manifest.format !== EVIDENCE_FORMAT) {
    problems.push(`unsupported format "${manifest.format}" (expected ${EVIDENCE_FORMAT})`);
  }

  const stored = readJson<Hashes>(dir, "hashes.json");
  const actual = computeHashes(dir).files;
  for (const [file, hash] of Object.entries(stored.files)) {
    if (!(file in actual)) problems.push(`missing file: ${file}`);
    else if (actual[file] !== hash) problems.push(`hash mismatch: ${file}`);
  }
  for (const file of Object.keys(actual)) {
    if (!(file in stored.files)) problems.push(`unhashed file present: ${file}`);
  }

  const evidence = readEvidence(dir, manifest);
  const mapping = readJson<MappingFile>(dir, manifest.mapping_ref);
  const ids = new Set(evidence.map((e) => e.id));
  for (const m of mapping.mappings) {
    for (const id of m.evidence) {
      if (!ids.has(id)) problems.push(`mapping ${m.criterion} references unknown evidence ${id}`);
    }
  }
  problems.push(...transcriptProblems(dir, manifest, evidence));
  problems.push(...artifactProblems(dir, evidence));

  const computation = computeVerdict(evidence, mapping);
  const storedVerdict = readJson<VerdictFile>(dir, manifest.verdict_ref);
  if (storedVerdict.verdict !== computation.verdict) {
    problems.push(
      `stored verdict "${storedVerdict.verdict}" != recomputed "${computation.verdict}"`,
    );
  }

  const statement = readJson<{ subject: Array<{ name: string; digest: { sha256?: string } }> }>(
    dir,
    "attestation/statement.json",
  );
  const dsse = readJson<{ payload: string; signatures: Array<{ keyid: string }> }>(
    dir,
    "attestation/statement.dsse.json",
  );
  if (Buffer.from(dsse.payload, "base64").toString() !== JSON.stringify(statement)) {
    problems.push("DSSE payload != statement.json");
  }
  const subject = statement.subject.find((s) => s.name === "orqon-evidence-package");
  if (subject?.digest.sha256 !== sha256(readFileSync(join(dir, "hashes.json")))) {
    problems.push("attestation subject digest != sha256(hashes.json)");
  }
  const signature = verifySignature(dir, options.certificateIdentity, options.certificateOidcIssuer);
  if (!signature.ok) problems.push(signature.detail);
  if (options.requireSignature && signature.inconclusive) {
    problems.push(`--require-signature: ${signature.detail}`);
  }

  const lines = [
    `Windkeel evidence package — ${manifest.subject.repo}${
      manifest.subject.pr ? `#${manifest.subject.pr}` : ""
    } @ ${manifest.subject.head_sha.slice(0, 8)}`,
    `author: ${manifest.subject.author.login} (${manifest.subject.author.kind}: ${
      manifest.subject.author.agent ?? "n/a"
    })`,
    "",
    "evidence:",
    ...evidence.map(
      (e) =>
        `  ${e.id ?? "?"}  ${String(e.type ?? "unknown").padEnd(20)} ${String(
          e.status ?? "unknown",
        ).padEnd(24)} ${e.summary ?? e.reason ?? ""}`,
    ),
    "",
    `intent mapping: ${mapping.status}${mapping.reason ? ` — ${mapping.reason}` : ""}`,
    ...mapping.mappings.map(
      (m) => `  ${m.criterion}  ${m.status.padEnd(12)} evidence: ${m.evidence.join(", ")}`,
    ),
    "",
    `integrity: ${problems.length ? "FAILED" : "ok"} | signature: ${signature.detail} | verdict: ${computation.verdict.toUpperCase()}`,
    ...(computation.blocking.length ? [`blocking findings: ${computation.blocking.join(", ")}`] : []),
    ...(computation.unsatisfied.length
      ? [`unsatisfied criteria: ${computation.unsatisfied.join(", ")}`]
      : []),
    ...(computation.unknown.length
      ? [`criteria the evidence could not settle: ${computation.unknown.join(", ")}`]
      : []),
    ...problems.map((p) => `  ! ${p}`),
  ];

  return {
    problems,
    verdict: computation.verdict,
    storedVerdict: storedVerdict.verdict,
    manifest,
    mapping,
    lines,
  };
}
