import { randomUUID } from "node:crypto";
import { loadConfig, loadTrustedConfig, withScriptsOverlay } from "../config.js";
import {
  EVIDENCE_FORMAT,
  type Criterion,
  type EvidenceItem,
  type Manifest,
  type ManifestPlaybook,
  type MappingFile,
  type Stage,
} from "../evidence/format.js";
import { applyPlaybookToPolicy, parsePlaybookVerifier, PLAYBOOK_ENTRY_PREFIX, type PlaybookProvenance } from "../playbook-policy.js";
import type { WindkeelConfig } from "../config.js";
import { CosignKeylessSigner } from "../attest/signer.js";
import { preparePackageDir, seal, writeJson, writeText } from "../evidence/package.js";
import { sha256 } from "../evidence/hashes.js";
import { incompleteStages } from "../evidence/incomplete.js";
import { computeVerdict, verdictFile } from "../evidence/verdict.js";
import { NO_CHECKS_SUMMARY, checkConfigEvidence, noChecksDiscovered, runChecks } from "../stages/checks.js";
import { runToolInstalls } from "../stages/environment.js";
import { runSecurity } from "../stages/security.js";
import { scannerAssets } from "../stages/scanner-assets.js";
import { runBrowser } from "../stages/browser.js";
import { collectDiff, runReview } from "../stages/review.js";
import { collectRepositoryContext, renderRepositoryContext } from "../stages/repo-context.js";
import { buildIntent, extractCriteria } from "../stages/intent.js";
import { runMapping } from "../stages/mapping.js";
import { TOOL_VERSION } from "../version.js";
import { buildRepairPacket } from "./repair.js";
import type { VerificationEngine, VerificationRequest, VerificationResult } from "./types.js";

const PIPELINE: Stage[] = ["checks", "review", "intent", "security", "browser"];

async function verify(request: VerificationRequest): Promise<VerificationResult> {
  const { execEnv, repo, out, subject, runner } = request;
  const trusted = request.policy
    ? null
    : subject.base_sha && subject.base_sha !== subject.head_sha
      ? await loadTrustedConfig(execEnv, repo, subject.base_sha)
      : null;
  const resolved = request.policy ?? trusted?.config ?? (await loadConfig(execEnv, repo));
  const config = request.playbook ? applyPlaybookToPolicy(resolved, request.playbook.verifier) : resolved;

  preparePackageDir(out, repo);

  const bindTranscript = (item: EvidenceItem, path: string, text: string): void => {
    writeText(out, path, text);
    if (item.transcript === path) item.transcript_sha256 = sha256(text);
  };

  const overlay = trusted?.scriptsOverlay;
  const runs = await withScriptsOverlay(execEnv, repo, overlay, () =>
    runChecks(execEnv, repo, config.checks, runner, config.checksRequired),
  );
  if (resolved.checks.length === 0 && config.checks.length > 0) {
    runs.push(noChecksDiscovered(runner, config.checksRequired, `ev-${String(runs.length + 1).padStart(2, "0")}`));
  }
  const evidence: EvidenceItem[] = runs.map((r) => r.evidence);
  for (const run of runs) bindTranscript(run.evidence, run.transcriptPath, run.transcript);

  const configRun = checkConfigEvidence(`ev-${String(evidence.length + 1).padStart(2, "0")}`, runner, {
    source: request.policy ? "policy" : (trusted?.source ?? "head"),
    ...(trusted ? { baseSha: trusted.baseSha } : {}),
    changes: trusted?.drift.changes ?? [],
    weakening: trusted?.drift.weakening ?? [],
    pinnedScripts: trusted?.pinnedScripts ?? [],
    baseUnavailable: trusted?.baseUnavailable,
    rejected: config.rejectedEntries ?? [],
  });
  if (configRun) {
    evidence.push(configRun.evidence);
    bindTranscript(configRun.evidence, configRun.transcriptPath, configRun.transcript);
  }

  if (request.toolInstalls?.length) {
    const tools = runToolInstalls(`ev-${String(evidence.length + 1).padStart(2, "0")}`, request.toolInstalls);
    evidence.push(tools.evidence);
    bindTranscript(tools.evidence, tools.transcriptPath, tools.transcript);
  }

  const prRef = subject.pr ? `${subject.repo}/pull/${subject.pr}` : subject.repo;
  const fromPr = extractCriteria(request.prBody, { kind: "pr_description", ref: prRef });
  const criteria: Criterion[] = request.criteria ?? [
    ...fromPr,
    ...extractCriteria(request.issueBody, { kind: "linked_issue", ref: prRef }, fromPr.length + 1),
  ];
  writeJson(out, "intent.json", buildIntent(criteria));

  const review = await runReview(`ev-${String(evidence.length + 1).padStart(2, "0")}`, {
    execEnv,
    repo,
    baseSha: subject.base_sha,
    headSha: subject.head_sha,
    title: subject.title,
    author: subject.author,
    criteria,
    models: request.models,
  });
  evidence.push(review.evidence);
  if (review.transcriptPath && review.transcript) {
    bindTranscript(review.evidence, review.transcriptPath, review.transcript);
  }

  const security = await runSecurity(
    execEnv,
    `ev-${String(evidence.length + 1).padStart(2, "0")}`,
    repo,
    request.fakeSecurity,
    request.scannerAssetDir ? scannerAssets(request.scannerAssetDir) : undefined,
    subject.base_sha,
  );
  evidence.push(security.evidence);
  bindTranscript(security.evidence, security.transcriptPath, security.transcript);

  const browserId = `ev-${String(evidence.length + 1).padStart(2, "0")}`;
  const browser = await withScriptsOverlay(execEnv, repo, overlay, () =>
    runBrowser(execEnv, browserId, repo, config.flows, out),
  );
  evidence.push(browser.evidence);
  bindTranscript(browser.evidence, browser.transcriptPath, browser.transcript);

  requireStage(security.evidence, config.requiredStages);
  requireStage(browser.evidence, config.requiredStages);

  for (const item of evidence) writeJson(out, `evidence/${item.id}.json`, item);

  const mappingContext = renderRepositoryContext(
    await collectRepositoryContext(execEnv, repo, subject.base_sha, subject.head_sha),
  );
  const mapped = await runMapping({
    criteria,
    evidence,
    diff: await collectDiff(execEnv, repo, subject.base_sha, subject.head_sha),
    author: subject.author,
    models: request.models,
    repositoryContext: mappingContext,
  });
  const mapping: MappingFile = mapped.mapping;
  writeJson(out, "mapping.json", mapping);

  const computation = computeVerdict(evidence, mapping);
  const summary = [
    config.checks.length ? "" : NO_CHECKS_SUMMARY,
    computation.blocking.length
      ? `${computation.blocking.length} blocking finding(s): ${computation.blocking.join(", ")}`
      : "",
    computation.unsatisfied.length
      ? `${computation.unsatisfied.length} criterion(s) without satisfying evidence: ${computation.unsatisfied.join(", ")}`
      : "",
    computation.unknown.length
      ? `${computation.unknown.length} criterion(s) the evidence could not settle: ${computation.unknown.join(", ")}`
      : "",
    computation.nonBlocking.length
      ? `${computation.nonBlocking.length} non-blocking finding(s): ${computation.nonBlocking.join(", ")}`
      : "",
    config.checks.length
      ? `${config.checks.length} repo check(s) re-run; ${computation.satisfied.length}/${criteria.length} criteria demonstrated.`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  writeJson(out, "verdict.json", verdictFile(computation, summary));

  const repair = buildRepairPacket(evidence, mapping, criteria, computation);
  if (repair) writeJson(out, "repair.json", repair);

  const manifest: Manifest = {
    format: EVIDENCE_FORMAT,
    package_id: `epk_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    created_at: new Date().toISOString(),
    tool: { name: "windkeel", version: TOOL_VERSION },
    subject,
    pipeline: PIPELINE,
    intent_ref: "intent.json",
    mapping_ref: "mapping.json",
    verdict_ref: "verdict.json",
    hashes_ref: "hashes.json",
    evidence_dir: "evidence/",
    ...(request.playbook ? { playbook: manifestPlaybook(request.playbook, resolved, config) } : {}),
  };
  writeJson(out, "manifest.json", manifest);

  seal(out);
  const signature = await (request.signer ?? new CosignKeylessSigner()).sign(out);
  const usages = [review.usage, mapped.usage];
  const checker =
    usages.every((u) => u !== undefined)
      ? {
          inputTokens: usages.reduce((n, u) => n + (u?.inputTokens ?? 0), 0),
          outputTokens: usages.reduce((n, u) => n + (u?.outputTokens ?? 0), 0),
        }
      : undefined;

  return {
    verdict: computation.verdict,
    out,
    signature,
    computation,
    mapping,
    criteria,
    repair,
    incomplete: incompleteStages(evidence),
    ...(checker ? { checkerUsage: checker } : {}),
  };
}

function requireStage(item: EvidenceItem, required: WindkeelConfig["requiredStages"]): void {
  if (item.status !== "skipped" || !(required ?? []).includes(item.stage as "browser" | "security")) return;
  const why = item.reason ?? item.summary ?? "skipped";
  item.status = "failed";
  item.findings = [
    ...(item.findings ?? []),
    {
      id: `F-${item.stage}-required`,
      severity: "blocking",
      category: "required-stage",
      claim: `the ${item.stage} stage is required by this task's playbook but did not run: ${why}`,
    },
  ];
}

function manifestPlaybook(playbook: PlaybookProvenance, base: WindkeelConfig, merged: WindkeelConfig): ManifestPlaybook {
  const req = parsePlaybookVerifier(playbook.verifier);
  const baseChecks = new Set(base.checks.map((c) => c.name));
  const baseFlows = new Set(base.flows.map((f) => f.name));
  const baseTools = new Set(base.tools.map((t) => t.package));
  return {
    slug: playbook.slug,
    version: playbook.version,
    builtin: playbook.builtin,
    added_checks: merged.checks.filter((c) => !baseChecks.has(c.name) && c.name.startsWith(PLAYBOOK_ENTRY_PREFIX)).map((c) => c.name),
    added_flows: merged.flows.filter((f) => !baseFlows.has(f.name) && f.name.startsWith(PLAYBOOK_ENTRY_PREFIX)).map((f) => f.name),
    added_tools: merged.tools.filter((t) => !baseTools.has(t.package)).map((t) => t.package),
    checks_required: req.checksRequired === true,
    required_stages: req.requireStages ?? [],
    added_criteria: playbook.criteria ?? [],
  };
}

export function createVerificationEngine(): VerificationEngine {
  return { verify };
}
