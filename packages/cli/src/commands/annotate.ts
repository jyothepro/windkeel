import { appendFileSync } from "node:fs";
import type { EvidenceItem, Manifest, MappingFile, VerdictFile } from "@windkeel/verification/evidence/format.js";
import { readEvidence, readJson } from "@windkeel/verification/evidence/package.js";

export function annotations(evidence: EvidenceItem[], mapping: MappingFile): string[] {
  const lines: string[] = [];
  for (const item of evidence) {
    for (const finding of item.findings ?? []) {
      const level = finding.severity === "blocking" ? "error" : "warning";
      const [file, line] = (finding.location ?? "").split(":");
      const position = file ? `file=${file}${line ? `,line=${line}` : ""},` : "";
      const detail = finding.failure_scenario ? ` — ${finding.failure_scenario}` : "";
      lines.push(
        `::${level} ${position}title=windkeel ${finding.id} (${finding.category})::${escape(
          `${finding.claim}${detail}`,
        )}`,
      );
    }
  }
  for (const m of mapping.mappings) {
    if (m.status === "unsatisfied") {
      lines.push(`::error title=windkeel ${m.criterion} unsatisfied::${escape(m.reason)}`);
    }
  }
  return lines;
}

const escape = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function summaryMarkdown(
  manifest: Manifest,
  verdict: VerdictFile,
  evidence: EvidenceItem[],
  mapping: MappingFile,
): string {
  const icon = { pass: "✅", warn: "⚠️", fail: "❌" }[verdict.verdict] ?? "❔";
  const rows = evidence.map(
    (e) => `| ${e.stage} | ${e.status} | ${(e.summary ?? e.reason ?? "").replaceAll("|", "\\|")} |`,
  );
  const criteria = mapping.mappings.map(
    (m) => `| ${m.criterion} | ${m.status} | ${m.reason.replaceAll("|", "\\|")} |`,
  );
  return [
    `## ${icon} Windkeel Gate — ${verdict.verdict.toUpperCase()}`,
    "",
    `${manifest.subject.repo}${manifest.subject.pr ? `#${manifest.subject.pr}` : ""} @ \`${manifest.subject.head_sha.slice(0, 8)}\` — authored by \`${manifest.subject.author.login}\` (${manifest.subject.author.kind}${manifest.subject.author.agent ? `: ${manifest.subject.author.agent}` : ""})`,
    "",
    verdict.summary,
    "",
    "| stage | status | evidence |",
    "| --- | --- | --- |",
    ...rows,
    ...(criteria.length
      ? ["", "| criterion | status | reason |", "| --- | --- | --- |", ...criteria]
      : []),
    "",
  ].join("\n");
}

export function annotate(dir: string, stepSummaryPath?: string): string[] {
  const manifest = readJson<Manifest>(dir, "manifest.json");
  const evidence = readEvidence(dir, manifest);
  const mapping = readJson<MappingFile>(dir, manifest.mapping_ref);
  const verdict = readJson<VerdictFile>(dir, manifest.verdict_ref);

  if (stepSummaryPath) {
    appendFileSync(stepSummaryPath, summaryMarkdown(manifest, verdict, evidence, mapping));
  }
  return annotations(evidence, mapping);
}
