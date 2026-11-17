import type { EvidenceItem, Finding } from "../evidence/format.js";
import { withExitTrailer } from "../evidence/transcript.js";

export interface SystemToolInstall {
  tool: string;
  source: "repository" | "engine";
  status: "installed" | "failed" | "rejected";
  detail: string;
  durationMs: number;
}

export function runToolInstalls(id: string, installs: SystemToolInstall[]): {
  evidence: EvidenceItem;
  transcript: string;
  transcriptPath: string;
} {
  const transcriptPath = `evidence/${id}-tools.log`;
  const declaredProblems = installs.filter((i) => i.source === "repository" && i.status !== "installed");
  const engineProblems = installs.filter((i) => i.source === "engine" && i.status !== "installed");

  const findings: Finding[] = [
    ...declaredProblems.map((i) => ({
      id: `F-tool-${i.tool}`,
      severity: "blocking" as const,
      category: "environment",
      claim: `this repo declares the system tool \`${i.tool}\`, which was ${i.status === "rejected" ? "refused" : "not installed"}: ${i.detail}`,
      failure_scenario:
        "Any check that shells out to the tool fails for a reason that is not the candidate's; the gate has no evidence either way about the code, so it blocks rather than passing on an unknown",
    })),
    ...engineProblems.map((i) => ({
      id: `F-scanner-${i.tool}`,
      severity: "non_blocking" as const,
      category: "environment",
      claim: `the verifier could not install its own \`${i.tool}\`: ${i.detail}`,
      failure_scenario: `The stage that uses ${i.tool} reports nothing, and an empty section in this package would otherwise read as "nothing was found" rather than "nothing looked"`,
    })),
  ];

  const status = declaredProblems.length ? "failed" : engineProblems.length ? "warning" : "passed";
  const summary = [
    `${installs.filter((i) => i.status === "installed").length}/${installs.length} tool(s) installed`,
    declaredProblems.length ? `repo-declared missing: ${declaredProblems.map((i) => i.tool).join(", ")}` : "",
    engineProblems.length ? `verifier's own missing: ${engineProblems.map((i) => i.tool).join(", ")}` : "",
    `${Math.round(installs.reduce((ms, i) => ms + i.durationMs, 0) / 1000)}s spent installing`,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    evidence: {
      id,
      stage: "checks",
      type: "tool_install",
      status,
      summary,
      tools: installs.map((i) => ({
        tool: i.tool,
        source: i.source,
        status: i.status,
        detail: i.detail,
        duration_ms: i.durationMs,
      })),
      transcript: transcriptPath,
      ...(findings.length ? { findings } : {}),
    },
    transcript: withExitTrailer(
      installs
        .map((i) => `# ${i.source}: ${i.tool} — ${i.status} (${i.durationMs}ms)\n${i.detail}`)
        .join("\n\n"),
      "none",
    ),
    transcriptPath,
  };
}
