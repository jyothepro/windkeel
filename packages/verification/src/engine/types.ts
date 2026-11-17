import type { Signer } from "../attest/signer.js";
import type { SignResult } from "../attest/sigstore.js";
import type { WindkeelConfig } from "../config.js";
import type { IncompleteStage } from "../evidence/incomplete.js";
import type { VerdictComputation } from "../evidence/verdict.js";
import type { Criterion, Manifest, MappingFile, Verdict } from "../evidence/format.js";
import type { ExecutionEnvironment } from "../exec/environment.js";
import type { ModelPolicy } from "../providers/types.js";
import type { PlaybookProvenance } from "../playbook-policy.js";
import type { SystemToolInstall } from "../stages/environment.js";
import type { RepairPacket } from "./repair.js";

export type Subject = Manifest["subject"];

export type VerificationPolicy = WindkeelConfig;

export interface VerificationRequest {
  execEnv: ExecutionEnvironment;
  repo: string;
  out: string;
  subject: Subject;
  runner: string;
  prBody: string;
  issueBody: string;
  criteria?: Criterion[] | undefined;
  policy?: VerificationPolicy | undefined;
  playbook?: PlaybookProvenance | undefined;
  models: ModelPolicy;
  toolInstalls?: SystemToolInstall[] | undefined;
  scannerAssetDir?: string | undefined;
  fakeSecurity?: string | undefined;
  signer?: Signer | undefined;
}

export interface VerificationResult {
  verdict: Verdict;
  checkerUsage?: { inputTokens: number; outputTokens: number };
  out: string;
  signature: SignResult;
  computation: VerdictComputation;
  mapping: MappingFile;
  criteria: Criterion[];
  repair: RepairPacket | null;
  incomplete: IncompleteStage[];
}

export interface VerificationEngine {
  verify(request: VerificationRequest): Promise<VerificationResult>;
}
