import { CHECK_DISCOVERY_SOURCES, validEntryName, type CheckSpec, type RejectedEntry } from "../config.js";
import type { ExecResult, ExecutionEnvironment } from "../exec/environment.js";
import { couldNotRunReason, isCouldNotRunExit } from "../exec/exit.js";
import type { EvidenceItem, Finding } from "../evidence/format.js";
import { withExitTrailer } from "../evidence/transcript.js";

export interface CheckRun {
  evidence: EvidenceItem;
  transcript: string;
  transcriptPath: string;
}

const MAX_SUMMARY_LINE = 200;

function lastMeaningfulLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return line ? line.slice(0, MAX_SUMMARY_LINE) : "no output";
}

export const NO_CHECKS_SUMMARY =
  "no repo checks were discovered — nothing was verified by the checks stage";

export function noChecksDiscovered(runner: string, required: boolean, id = "ev-01"): CheckRun {
  const transcriptPath = `evidence/${id}-checks-discovery.log`;
  const reason = `no_checks_discovered — discovery looked at ${CHECK_DISCOVERY_SOURCES} and found none; declare \`checks\` in windkeel.config.json to have the gate re-run them`;
  return {
    evidence: {
      id,
      stage: "checks",
      type: "no_checks_discovered",
      status: required ? "failed" : "warning",
      summary: `${NO_CHECKS_SUMMARY}. ${reason}`,
      reason,
      environment: { runner, node: process.versions.node, clean_checkout: runner !== "local" },
      transcript: transcriptPath,
      ...(required
        ? {
            findings: [
              {
                id: "F-checks-required",
                severity: "blocking" as const,
                category: "repo-checks",
                claim:
                  "this repo requires checks (`checks.required` in windkeel.config.json) but declares none",
                failure_scenario:
                  "The gate would report a clean run having executed nothing; with checks required it blocks instead",
              },
            ],
          }
        : {}),
    },
    transcript: withExitTrailer(
      `[windkeel] check discovery\nlooked at: ${CHECK_DISCOVERY_SOURCES}\nfound: 0 checks\nrequired: ${required}`,
      "none",
    ),
    transcriptPath,
  };
}

export const CHECK_COULD_NOT_RUN_REASON = "check_could_not_run";

export const checkCouldNotRun = (evidence: EvidenceItem): boolean =>
  evidence.stage === "checks" && (evidence.reason?.startsWith(CHECK_COULD_NOT_RUN_REASON) ?? false);

function couldNotRun(
  id: string,
  check: CheckSpec,
  cause: string,
  result: ExecResult,
  runner: string,
  duration: number,
): CheckRun {
  const transcriptPath = `evidence/${id}-${check.name}.log`;
  const reason = `${CHECK_COULD_NOT_RUN_REASON} — \`${check.command}\` ${cause}; this is the verifier's environment, not the repository's source`;
  return {
    evidence: {
      id,
      stage: "checks",
      type: `${check.name}_result`,
      status: "failed",
      summary: `${check.command} could not be run: ${cause}`,
      reason,
      ...(result.status === null
        ? {}
        : { producer: { command: check.command, exit_code: result.status, duration_ms: duration } }),
      environment: { runner, node: process.versions.node, clean_checkout: runner !== "local" },
      transcript: transcriptPath,
      findings: [
        {
          id: `F-${check.name}-could-not-run`,
          severity: "blocking",
          category: "verifier-environment",
          claim: `The \`${check.name}\` check never executed: \`${check.command}\` ${cause}`,
          failure_scenario:
            `The gate has no evidence either way for \`${check.command}\`, so it blocks rather ` +
            `than passing on an unknown. Repairing the repository cannot help — the command was ` +
            `never run against it. Install or declare the command, then re-verify.`,
        },
      ],
    },
    transcript: withExitTrailer(
      `$ ${check.command}\n${result.stdout}${result.stderr}\n[windkeel] check did not run: ${cause}`,
      result.status ?? "none",
    ),
    transcriptPath,
  };
}

export function checkConfigEvidence(
  id: string,
  runner: string,
  input: {
    source: "base" | "head" | "policy";
    baseSha?: string;
    changes: string[];
    weakening: string[];
    pinnedScripts: string[];
    baseUnavailable?: string | undefined;
    rejected: RejectedEntry[];
  },
): CheckRun | null {
  const { changes, weakening, rejected, baseUnavailable } = input;
  if (!changes.length && !weakening.length && !rejected.length && !baseUnavailable) return null;

  const transcriptPath = `evidence/${id}-check-config.log`;
  const findings: Finding[] = [
    ...(baseUnavailable
      ? [
          {
            id: "F-check-config-base",
            severity: "blocking" as const,
            category: "check-configuration",
            claim: `checks were defined by the change under review: ${baseUnavailable}`,
            failure_scenario:
              "A change can declare its own checks (`\"command\": \"true\"`) and pass them; the gate only trusts the base revision's configuration, and could not read it",
          },
        ]
      : []),
    ...weakening.map((w, i) => ({
      id: `F-check-config-weakened-${i + 1}`,
      severity: "blocking" as const,
      category: "check-configuration",
      claim: `the change under review weakens the gate's check configuration: ${w}`,
      failure_scenario:
        "This run used the base revision's checks, so the verdict is unaffected — but once merged every later change is verified against the weaker configuration. A person (or trusted policy) has to ratify that",
    })),
    ...(changes.length
      ? [
          {
            id: "F-check-config-changed",
            severity: "non_blocking" as const,
            category: "check-configuration",
            claim: `check configuration changed by the change under review; checks ran from base: ${changes.join("; ")}`,
            failure_scenario:
              "The new configuration has not been exercised by any gate run; it takes effect for the next change after this one merges",
          },
        ]
      : []),
    ...rejected.map((r, i) => ({
      id: `F-${r.kind}-rejected-${i + 1}`,
      severity: "blocking" as const,
      category: "check-configuration",
      claim: `a declared ${r.kind} was refused and did not run: ${r.value} — ${r.reason}`,
      failure_scenario: `The gate cannot report on a ${r.kind} it refused to run, so it blocks rather than passing without it`,
    })),
  ];
  const blocking = findings.some((f) => f.severity === "blocking");
  const lines = [
    `[windkeel] check configuration`,
    `source: ${input.source}${input.baseSha ? ` (${input.baseSha})` : ""}`,
    ...(baseUnavailable ? [`base unavailable: ${baseUnavailable}`] : []),
    ...weakening.map((w) => `weakened: ${w}`),
    ...changes.map((c) => `changed: ${c}`),
    ...(input.pinnedScripts.length ? [`package.json scripts that ran from base: ${input.pinnedScripts.join(", ")}`] : []),
    ...rejected.map((r) => `refused ${r.kind}: ${r.value} — ${r.reason}`),
  ];
  return {
    evidence: {
      id,
      stage: "checks",
      type: "check_config",
      status: blocking ? "failed" : "warning",
      summary: findings.map((f) => f.claim).join(" | ").slice(0, 500),
      reason: `check configuration read from ${input.source}`,
      environment: { runner, node: process.versions.node, clean_checkout: runner !== "local" },
      transcript: transcriptPath,
      findings,
    },
    transcript: withExitTrailer(lines.join("\n"), "none"),
    transcriptPath,
  };
}

export async function runChecks(
  execEnv: ExecutionEnvironment,
  repo: string,
  checks: CheckSpec[],
  runner: string,
  checksRequired = false,
): Promise<CheckRun[]> {
  if (!checks.length) return [noChecksDiscovered(runner, checksRequired)];

  const runs: CheckRun[] = [];
  for (const [index, check] of checks.entries()) {
    const id = `ev-${String(index + 1).padStart(2, "0")}`;
    if (!validEntryName(check.name)) {
      runs.push(
        couldNotRun(
          id,
          { name: "invalid-name", command: check.command },
          `has a name that is not a safe filename (${JSON.stringify(String(check.name)).slice(0, 80)})`,
          { status: null, signal: null, stdout: "", stderr: "" },
          runner,
          0,
        ),
      );
      continue;
    }
    const started = Date.now();
    const result = await execEnv.exec(check.command, {
      cwd: repo,
      env: { CI: "1", FORCE_COLOR: "0" },
    });
    const duration = Date.now() - started;
    const transcriptPath = `evidence/${id}-${check.name}.log`;

    if (result.error || result.status === null) {
      const cause = result.error
        ? `could not be started: ${result.error}`
        : `was terminated by signal ${result.signal}`;
      runs.push(couldNotRun(id, check, cause, result, runner, duration));
      continue;
    }

    if (isCouldNotRunExit(result.status)) {
      const cause = `exited ${result.status} (${couldNotRunReason(result.status)})`;
      runs.push(couldNotRun(id, check, cause, result, runner, duration));
      continue;
    }

    const exitCode = result.status;
    const output = `$ ${check.command}\n${result.stdout}${result.stderr}`;
    const transcript = withExitTrailer(output, exitCode);
    const passed = exitCode === 0;

    const evidence: EvidenceItem = {
      id,
      stage: "checks",
      type: `${check.name}_result`,
      status: passed ? "passed" : "failed",
      summary: `${check.command} exited ${exitCode}: ${lastMeaningfulLine(output)}`,
      producer: { command: check.command, exit_code: exitCode, duration_ms: duration },
      environment: { runner, node: process.versions.node, clean_checkout: runner !== "local" },
      transcript: transcriptPath,
      ...(passed
        ? {}
        : {
            findings: [
              {
                id: `F-${check.name}`,
                severity: "blocking" as const,
                category: "repo-checks",
                claim: `The repo's own \`${check.name}\` check fails on this head commit`,
                failure_scenario: `\`${check.command}\` exits ${exitCode}; see ${transcriptPath}`,
              },
            ],
          }),
    };

    runs.push({ evidence, transcript, transcriptPath });
  }
  return runs;
}
