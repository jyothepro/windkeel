import { join } from "node:path";
import type { FlowSpec } from "../config.js";
import type { ExecutionEnvironment } from "../exec/environment.js";
import type { EvidenceItem, Finding } from "../evidence/format.js";
import { sha256 } from "../evidence/hashes.js";
import { PackagePathError, writeBytes } from "../evidence/package.js";
import { isSafeArtifactPath } from "../evidence/paths.js";
import { withExitTrailer, type ExitTrailer } from "../evidence/transcript.js";

export interface BrowserOutput {
  evidence: EvidenceItem;
  transcript: string;
  transcriptPath: string;
}

const INLINE_LIMIT = 5 * 1024 * 1024;

const CONSOLE_ERROR = /\b(console\.error|Uncaught (?:TypeError|ReferenceError|Error))\b/;

const SAFE_ARTIFACT_PATH = isSafeArtifactPath;

async function collectArtifacts(
  execEnv: ExecutionEnvironment,
  flowDir: string,
  packageDir: string,
  destPrefix: string,
  refused: string[],
): Promise<Array<{ path: string; sha256: string; bytes: number; included: boolean }>> {
  const files = await execEnv.listFiles(flowDir);
  const collected = [];
  for (const file of files) {
    if (!SAFE_ARTIFACT_PATH(file.path)) {
      refused.push(file.path);
      continue;
    }
    const content = await execEnv.readFile(`${flowDir}/${file.path}`);
    const included = file.bytes <= INLINE_LIMIT;
    if (included) {
      try {
        writeBytes(packageDir, `${destPrefix}/${file.path}`, content);
      } catch (error) {
        if (!(error instanceof PackagePathError)) throw error;
        refused.push(file.path);
        continue;
      }
    }
    collected.push({
      path: `${destPrefix}/${file.path}`,
      sha256: sha256(content),
      bytes: file.bytes,
      included,
    });
  }
  return collected;
}

export async function runBrowser(
  execEnv: ExecutionEnvironment,
  id: string,
  repo: string,
  flows: FlowSpec[],
  packageDir: string,
): Promise<BrowserOutput> {
  const transcriptPath = `evidence/${id}-browser.log`;
  if (!flows.length) {
    return {
      evidence: {
        id,
        stage: "browser",
        type: "browser_flow",
        status: "skipped",
        reason:
          "no_flows_declared — add `flows` to windkeel.config.json to have the gate replay UI journeys",
      },
      transcript: withExitTrailer("no browser flows declared", "none"),
      transcriptPath,
    };
  }

  const findings: Finding[] = [];
  const artifacts: Array<{ path: string; sha256: string; bytes: number; included: boolean }> = [];
  const logs: string[] = [];
  const refused: string[] = [];
  let stageExit: ExitTrailer = 0;

  for (const [index, flow] of flows.entries()) {
    const result = await execEnv.exec(flow.command, {
      cwd: repo,
      env: { CI: "1" },
    });
    const output = `${result.stdout}${result.stderr}`;
    logs.push(`# ${flow.name}: ${flow.command} (exit ${result.status ?? "signal"})\n${output}`);

    artifacts.push(
      ...(await collectArtifacts(
        execEnv,
        join(repo, flow.artifacts ?? "test-results"),
        packageDir,
        `evidence/browser/${flow.name}`,
        refused,
      )),
    );
    if (refused.length) {
      findings.push({
        id: `UI-${index + 1}-artifact-path`,
        severity: "blocking",
        category: "browser-flow",
        claim: `"${flow.name}" left artifacts whose paths would escape the evidence package, and they were not copied: ${refused
          .slice(0, 5)
          .map((p) => JSON.stringify(p))
          .join(", ")}`,
        location: flow.command,
        failure_scenario:
          "An artifact path is the candidate's to choose; one that climbs out of the package (or through a symlink) is either a broken flow or an attempt to overwrite the verifier's own files",
      });
      refused.length = 0;
    }

    if (result.status !== 0) {
      if (stageExit === 0) stageExit = result.status ?? "none";
      findings.push({
        id: `UI-${index + 1}`,
        severity: "blocking",
        category: "browser-flow",
        claim: `the declared flow "${flow.name}" does not complete on this head commit`,
        location: flow.command,
        failure_scenario: `A user following "${flow.name}" hits the failure captured in ${transcriptPath} and the attached artifacts`,
      });
    } else if (CONSOLE_ERROR.test(output)) {
      findings.push({
        id: `UI-${index + 1}-console`,
        severity: "non_blocking",
        category: "browser-console",
        claim: `"${flow.name}" completes but logs errors to the console`,
        location: flow.command,
        failure_scenario: "The journey works today while an unhandled error goes unnoticed",
      });
    }
  }

  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const referenced = artifacts.filter((a) => !a.included).length;

  return {
    evidence: {
      id,
      stage: "browser",
      type: "browser_flow",
      status: findings.length ? (blocking ? "failed" : "completed_with_findings") : "passed",
      summary: `${flows.length} flow(s), ${blocking} failing; ${artifacts.length} artifact(s)${
        referenced ? `, ${referenced} referenced by digest only (>5 MB)` : ""
      }`,
      transcript: transcriptPath,
      artifacts,
      ...(findings.length ? { findings } : {}),
    },
    transcript: withExitTrailer(logs.join("\n\n"), stageExit),
    transcriptPath,
  };
}
