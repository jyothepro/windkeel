import {
  incompleteLines,
  pendingSignalLines,
  signatureLines,
  type RunReport,
  type ReportedRepairAttempt,
  type ReportedVerification,
} from "../factory/run-report.js";
import type { CheckRunConclusion, CheckRunOutput, CheckRunStatus } from "./client.js";

export const CHECK_RUN_NAME = "windkeel/verification";

export const COMMENT_LIMIT = 65_536;
const CHECK_OUTPUT_TEXT_LIMIT = 65_535;

export function stickyMarker(engineeringRunId: string): string {
  return `<!-- windkeel:run:${engineeringRunId} -->`;
}

export interface CommentLike {
  id: number;
  body: string;
}

export function findStickyComment<T extends CommentLike>(
  comments: readonly T[],
  engineeringRunId: string,
): T | undefined {
  const marker = stickyMarker(engineeringRunId);
  return comments.find((comment) => comment.body.includes(marker));
}

export function plain(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/<!--/g, "<!‑-")
    .replace(/-->/g, "-‑>")
    .replace(/[`|]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#>-])/, "$1\\$2")
    .trim();
}

export function fenced(text: string, language = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return `${fence}${language}\n${clean}\n${fence}`;
}

const VERDICT_TEXT: Record<string, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

function verdictText(verdict: string | null): string {
  return verdict ? (VERDICT_TEXT[verdict] ?? verdict.toUpperCase()) : "—";
}

function shortSha(sha: string): string {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 12) : plain(sha);
}

export interface SummaryOptions {
  evidenceUrl?: ((verification: ReportedVerification) => string | null) | undefined;
  limit?: number;
}

function resultBlock(report: RunReport): string {
  const row = (label: string, value: string) => `${label.padEnd(26)}${value}`;
  const ofRecord = report.verifications.find((v) => v.verdictOfRecord);
  const risk = report.residualRisk;

  const lines = [
    "WINDKEEL RESULT",
    "",
    `Task: ${plain(report.task.title)}`,
    "",
    row(
      "Acceptance criteria",
      report.criteria.satisfied === null
        ? `—/${report.criteria.total}`
        : `${report.criteria.satisfied}/${report.criteria.total}`,
    ),
    row("Blocking findings", countText(blockingOf(ofRecord))),
    row("Advisory findings", countText(risk.nonBlockingFindings)),
    row("Repair attempts", `${report.repairAttemptsTaken} of ${report.repairCap} allowed`),
    row("Residual risk", residualRiskText(report)),
    row("Verdict of record", verdictText(ofRecord?.verdict ?? null)),
    row("Overall verdict", verdictText(report.finalVerdict)),
    ...incompleteLines(report, row, plain),
    ...signatureLines(report, row),
    ...pendingSignalLines(report, row),
    "",
    row("Run state", `${report.state}${report.terminal ? " (terminal)" : " (in flight)"}`),
  ];
  if (report.stopReason) {
    lines.push(row("Stopped because", `${report.stopReason} — ${report.stopReasonText ?? ""}`));
  }
  lines.push(
    row(
      "Cost",
      `$${report.cost.totalUsd.toFixed(4)}${
        report.cost.spendCapUsd === null ? " (uncapped)" : ` of $${report.cost.spendCapUsd}`
      }`,
    ),
  );
  return fenced(lines.join("\n"), "text");
}

function blockingOf(verification: ReportedVerification | undefined): number | null {
  const summary = verification?.riskSummary as { blocking?: unknown[] } | null | undefined;
  return Array.isArray(summary?.blocking) ? summary.blocking.length : null;
}

function countText(count: number | null): string {
  return count === null ? "not recorded" : `${count}`;
}

function residualRiskText(report: RunReport): string {
  const risk = report.residualRisk;
  const known: string[] = [];
  if (risk.nonBlockingFindings !== null) known.push(`${risk.nonBlockingFindings} advisory`);
  if (risk.unsatisfiedCriteria !== null) known.push(`${risk.unsatisfiedCriteria} unsatisfied`);
  return known.length ? `not scored (${known.join(", ")})` : "not scored";
}

function criteriaSection(report: RunReport): string {
  const provenance =
    report.task.criteriaProvenance === "generated"
      ? `**Generated** by ${plain(report.task.criteriaGeneratedBy ?? "a checker model")}` +
        (report.task.criteriaApprovedBy
          ? `, approved by @${plain(report.task.criteriaApprovedBy)}`
          : ", **not yet approved**") +
        " (ADR-0012)."
      : "**Stated in the issue** by its author, used verbatim.";

  const items = report.task.criteria.length
    ? report.task.criteria.map((c) => `- \`${plain(c.id)}\` — ${plain(c.text)}`).join("\n")
    : "_(none — this run had nothing to verify against)_";

  const playbook = report.playbook?.criteria.length
    ? [
        "",
        `\`PB\`-numbered criteria were added by playbook \`${plain(report.playbook.slug)}\` v${report.playbook.version}, on top of the task's own.`,
      ]
    : [];
  return ["### Acceptance criteria", "", provenance, ...playbook, "", items].join("\n");
}

function playbookSection(report: RunReport): string {
  const p = report.playbook!;
  const adds = [
    ...p.criteria.map((c) => `- criterion \`${plain(c.id)}\` — ${plain(c.text)}`),
    ...p.verifierAdds.map((line) => `- ${plain(line)}`),
  ];
  return [
    "### Playbook",
    "",
    `\`${plain(p.slug)}\` v${p.version}${p.builtin ? " (built-in)" : ""}. A playbook can only add to verification, never remove from it.`,
    "",
    adds.length ? adds.join("\n") : "_(it adds nothing to verification)_",
  ].join("\n");
}

function verificationSection(report: RunReport, options: SummaryOptions): string {
  if (report.verifications.length === 0) {
    return ["### Verification cycles", "", "_(none yet)_"].join("\n");
  }
  const rows = report.verifications.map((v) => {
    const flags = [
      v.verdictOfRecord ? "verdict of record" : null,
      v.superseded ? "superseded" : null,
    ].filter(Boolean);
    return (
      `| ${v.cycle} | \`${shortSha(v.candidateSha)}\` | ${verdictText(v.verdict)} | ` +
      `${evidenceCell(v, options)} | ${flags.join(", ") || "—"} |`
    );
  });
  return [
    "### Verification cycles",
    "",
    "| # | candidate | verdict | evidence | |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function evidenceCell(verification: ReportedVerification, options: SummaryOptions): string {
  const digest = verification.evidence.manifestDigest;
  const digestText = digest ? ` \`${plain(digest).slice(0, 19)}\`` : "";
  switch (verification.evidence.state) {
    case "stored": {
      const url = options.evidenceUrl?.(verification) ?? null;
      return url ? `[package](${encodeURI(url)})${digestText}` : `stored${digestText}`;
    }
    case "pruned":
      return `pruned by policy${digestText}`;
    case "none":
      return "not sealed";
  }
}

function repairSection(report: RunReport): string {
  if (report.repairAttempts.length === 0) {
    return ["### Repair history", "", "_(none)_"].join("\n");
  }
  const lines = report.repairAttempts.map((attempt) => {
    const header = `**Attempt ${attempt.attemptNumber}**${
      attempt.taken ? "" : " — not taken; the run stopped first"
    }`;
    return `- ${header}\n  - asked to fix: ${plain(describeDemand(attempt))}`;
  });
  return ["### Repair history", "", ...lines].join("\n");
}

function describeDemand(attempt: ReportedRepairAttempt): string {
  const parts: string[] = [];
  if (attempt.failedCriteria.length) parts.push(`criteria ${attempt.failedCriteria.join(", ")}`);
  if (attempt.failedChecks.length) parts.push(`checks ${attempt.failedChecks.join(", ")}`);
  if (attempt.blockingFindings.length) {
    parts.push(`findings ${attempt.blockingFindings.join(", ")}`);
  }
  return parts.join("; ") || "nothing recorded";
}

function provenanceSection(report: RunReport): string {
  if (report.agentRuns.length === 0) {
    return ["### Agent and model provenance", "", "_(none)_"].join("\n");
  }
  const rows = report.agentRuns.map(
    (a) =>
      `| ${plain(a.role)} | \`${plain(a.workerType)}/${plain(a.model)}\` | ` +
      `${a.candidateSha ? `\`${shortSha(a.candidateSha)}\`` : "—"} | ` +
      `${a.modelCostUsd === null ? "—" : `$${a.modelCostUsd.toFixed(4)}`} |`,
  );
  return [
    "### Agent and model provenance",
    "",
    "| role | worker/model | candidate | model cost |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function costSection(report: RunReport): string {
  const lines = [
    "### Cost",
    "",
    `| model | sandbox | total |`,
    `|---|---|---|`,
    `| $${report.cost.modelUsd.toFixed(4)} | $${report.cost.sandboxUsd.toFixed(4)} | ` +
      `$${report.cost.totalUsd.toFixed(4)} |`,
  ];
  if (!report.cost.reconciles) {
    lines.push(
      "",
      `> **The ledger and the run row disagree** — $${report.cost.totalUsd.toFixed(4)} vs ` +
        `$${report.cost.runCostUsd.toFixed(4)}. They are written in one transaction and must agree.`,
    );
  }
  return lines.join("\n");
}

function details(title: string, body: string): string {
  return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
}

export function renderEvidenceSummary(report: RunReport, options: SummaryOptions = {}): string {
  const marker = stickyMarker(report.engineeringRunId);
  const head = [
    marker,
    "",
    `## Windkeel verification`,
    "",
    resultBlock(report),
    "",
    `Per-stage results (tests, security, independent review, browser QA) are in the evidence ` +
      `package — this summary reports only what the run's own rows record, so that it stays ` +
      `true after a package is pruned (ADR-0015).`,
  ].join("\n");

  const sections = [
    details("Acceptance criteria", criteriaSection(report)),
    ...(report.playbook ? [details("Playbook", playbookSection(report))] : []),
    details("Verification cycles", verificationSection(report, options)),
    details("Repair history", repairSection(report)),
    details("Agent and model provenance", provenanceSection(report)),
    details("Cost", costSection(report)),
  ];

  const limit = options.limit ?? COMMENT_LIMIT;
  const footer = `\n\n<sub>Run \`${plain(report.engineeringRunId)}\` — windkeel</sub>`;

  let body = [head, ...sections].join("\n\n") + footer;
  if (body.length <= limit) return body;

  const kept: string[] = [];
  for (const section of sections) {
    const candidate =
      [head, ...kept, section].join("\n\n") + TRUNCATION_NOTICE + footer;
    if (candidate.length > limit) break;
    kept.push(section);
  }
  body = [head, ...kept].join("\n\n") + TRUNCATION_NOTICE + footer;
  return body.length <= limit ? body : head + TRUNCATION_NOTICE + footer;
}

const TRUNCATION_NOTICE =
  "\n\n> Some detail was omitted to fit GitHub's comment limit. The full record is in the " +
  "evidence package and in `windkeel run report <run-id>`.";

export interface CheckRunPayload {
  name: string;
  headSha: string;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  detailsUrl?: string;
  output: CheckRunOutput;
}

export interface CheckRunOptions {
  detailsUrl?: string | undefined;
  headSha?: string | undefined;
}

const VERDICT_CONCLUSION: Record<string, CheckRunConclusion> = {
  pass: "success",
  warn: "neutral",
  fail: "failure",
};

export function checkRunFor(report: RunReport, options: CheckRunOptions = {}): CheckRunPayload {
  const ofRecord = report.verifications.find((v) => v.verdictOfRecord);
  const latest = report.verifications[report.verifications.length - 1];
  const headSha = options.headSha ?? ofRecord?.candidateSha ?? latest?.candidateSha ?? "";
  const verdict = ofRecord?.verdict ?? report.finalVerdict ?? null;

  const criteria =
    report.criteria.satisfied === null
      ? `—/${report.criteria.total} criteria`
      : `${report.criteria.satisfied}/${report.criteria.total} criteria`;

  if (!verdict || (!report.terminal && !ofRecord)) {
    return {
      name: CHECK_RUN_NAME,
      headSha,
      status: "in_progress",
      ...(options.detailsUrl ? { detailsUrl: options.detailsUrl } : {}),
      output: {
        title: "Verification in progress",
        summary: `Run is at ${report.state}. ${criteria} verified so far.`,
      },
    };
  }

  const conclusion = VERDICT_CONCLUSION[verdict] ?? "neutral";
  const stopped = report.stopReason
    ? ` Stopped: ${report.stopReason} — ${report.stopReasonText ?? ""}.`
    : "";
  return {
    name: CHECK_RUN_NAME,
    headSha,
    status: "completed",
    conclusion,
    ...(options.detailsUrl ? { detailsUrl: options.detailsUrl } : {}),
    output: {
      title: `${verdictText(verdict)} — ${criteria}`,
      summary:
        `${criteria}, ${report.repairAttemptsTaken} repair attempt(s), ` +
        `${residualRiskText(report)}.${stopped}`,
      text: truncate(
        [
          `Verdict of record: ${verdictText(verdict)}`,
          `Candidate: ${shortSha(headSha)}`,
          `Cost: $${report.cost.totalUsd.toFixed(4)}`,
          "",
          "The full evidence summary is in the pull request comment.",
        ].join("\n"),
        CHECK_OUTPUT_TEXT_LIMIT,
      ),
    },
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
