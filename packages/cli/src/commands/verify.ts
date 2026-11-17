import type { SignResult } from "@windkeel/verification/attest/sigstore.js";
import type { MappingFile, Verdict } from "@windkeel/verification/evidence/format.js";
import { createVerificationEngine } from "@windkeel/verification/engine/engine.js";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { modelPolicyFromEnv } from "@windkeel/verification/providers/index.js";
import { readExplicitIntent } from "@windkeel/verification/stages/intent.js";
import { resolveSubject } from "../subject.js";

export interface VerifyReport {
  verdict: Verdict;
  out: string;
  signature: SignResult;
  mapping: MappingFile;
}

export interface VerifyOptions {
  repo: string;
  out: string;
  prBodyFile?: string | undefined;
  issueBodyFile?: string | undefined;
  intentFile?: string | undefined;
}

export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const execEnv = new LocalExecutionEnvironment();
  const resolved = await resolveSubject(execEnv, {
    repo: options.repo,
    prBodyFile: options.prBodyFile,
    issueBodyFile: options.issueBodyFile,
  });

  const engine = createVerificationEngine();
  const result = await engine.verify({
    execEnv,
    repo: options.repo,
    out: options.out,
    subject: resolved.subject,
    runner: resolved.runner,
    prBody: resolved.prBody,
    issueBody: resolved.issueBody,
    criteria: options.intentFile ? readExplicitIntent(options.intentFile) : undefined,
    models: modelPolicyFromEnv(process.env),
    fakeSecurity: process.env["WINDKEEL_FAKE_SECURITY"],
  });
  return {
    verdict: result.verdict,
    out: result.out,
    signature: result.signature,
    mapping: result.mapping,
  };
}
