import type { EvidenceItem } from "../evidence/format.js";

export const EXECUTION_CRITERION_REASON = "requires_execution";

const EXECUTION_PHRASES: RegExp[] = [
  /\b(?:tests?|test\s+suite|suite|specs?)\b[^\n]{0,80}\b(?:pass(?:es|ing|ed)?|green)\b/i,
  /\bnpm\s+(?:run\s+)?(?:test|typecheck|lint|build)\b/i,
  /\bexits?\s+(?:with\s+)?(?:a\s+)?(?:non-?zero|zero|\d+)\b/i,
  /\bexit\s+(?:code|status)\b/i,
  /\bfrom\s+a\s+(?:clean|fresh)\s+(?:checkout|clone|install|machine)\b/i,
  /\bworks?\s+as\s+written\b/i,
  /\b(?:the\s+)?(?:documented\s+)?command\s+(?:works|succeeds|runs)\b/i,
  /\bruns?\s+(?:successfully|cleanly|green|to\s+completion|without\s+(?:error|failure))\b/i,
  /\bwhen\s+(?:you|a\s+user|someone|the\s+reader)\s+runs?\b/i,
  /\bcopy[-\s]?paste(?:d|able)?\b/i,
];

export function demandsExecution(text: string): boolean {
  return EXECUTION_PHRASES.some((pattern) => pattern.test(text));
}

export interface ExecutedCommand {
  id: string;
  name: string;
  command: string;
  exitCode?: number | undefined;
  status: string;
}

export function executedCommands(evidence: EvidenceItem[]): ExecutedCommand[] {
  return evidence
    .filter((e) => e.stage === "checks" && e.producer?.command)
    .map((e) => ({
      id: e.id,
      name: e.type.replace(/_result$/, ""),
      command: e.producer!.command,
      exitCode: e.producer!.exit_code,
      status: e.status,
    }));
}

export function executionReason(executed: ExecutedCommand[]): string {
  const ran = executed.length
    ? `This verification ran the checks the repository declares: ${executed
        .map((c) => `\`${c.command}\` (${c.name}, ${c.id}, exit ${c.exitCode ?? "none"})`)
        .join("; ")}. A criterion demonstrated by one of those is settled by naming it.`
    : "This verification ran no commands at all: the repository declares no checks, so there is " +
      "nothing a criterion of this shape could be settled against.";

  return (
    `${EXECUTION_CRITERION_REASON} — this criterion can only be settled by running something, ` +
    `and the verifier executes only the commands the repository declares in its Windkeel config. ` +
    `It never runs a command taken from a criterion's prose: a criterion is author text on an ` +
    `issue, and executing it would let anyone who can file an issue run a command in the ` +
    `verifier sandbox. ${ran} To make this criterion demonstrable, declare the command as a ` +
    `check in windkeel.config.json and restate the criterion in terms of that check — or restate ` +
    `it as an outcome the evidence can show without a new command.`
  );
}

export function explainUnsettledExecution<T extends { status: string; reason: string }>(
  mapping: T,
  criterionText: string,
  executed: ExecutedCommand[],
): T {
  if (mapping.status !== "unknown" || !demandsExecution(criterionText)) return mapping;
  if (mapping.reason.includes(EXECUTION_CRITERION_REASON)) return mapping;
  const mapperSaid = mapping.reason.trim();
  return {
    ...mapping,
    reason: mapperSaid
      ? `${executionReason(executed)} The mapper's own account: ${mapperSaid}`
      : executionReason(executed),
  };
}
