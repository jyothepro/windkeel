import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import type { CredentialBrokerRule, SandboxHandle } from "./provider.js";
import { executionPhasePolicy } from "./network-phase.js";

const GIT_FLAGS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);

export function isGitPush(cmd: string, options?: ExecOptions): boolean {
  const tokens = options?.args ? [cmd, ...options.args] : cmd.trim().split(/\s+/);
  if (tokens[0] !== "git") return false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.startsWith("-")) {
      if (GIT_FLAGS_WITH_VALUE.has(token)) i++;
      continue;
    }
    return token === "push";
  }
  return false;
}

function rejectedResult(error: string): ExecResult {
  return { status: null, signal: null, stdout: "", stderr: "", error };
}

export interface ExecutionPhaseOptions {
  additionalAllowedDomains?: string[];
}

export async function runInExecutionPhase(
  handle: SandboxHandle,
  modelApiDomain: string,
  credentialRules: CredentialBrokerRule[],
  cmd: string,
  options?: ExecOptions,
  phase: ExecutionPhaseOptions = {},
): Promise<ExecResult> {
  if (handle.role === "verifier" && isGitPush(cmd, options)) {
    return rejectedResult(
      "runInExecutionPhase: refusing to run a `git push` in a verifier-role sandbox — " +
        "ADR-0014 §2. The verifier's own credential is `contents: read`, so the remote would " +
        "refuse this anyway; this check is defence in depth that fails fast and locally, and " +
        "the only enforcement on the hermetic local path, which has no credential at all.",
    );
  }

  await handle.updateNetworkPolicy(
    executionPhasePolicy(modelApiDomain, phase.additionalAllowedDomains ?? []),
  );
  await handle.applyCredentialBrokerRules(credentialRules);

  const confirmation = await handle.exec("true");
  if (confirmation.error || confirmation.status !== 0) {
    return rejectedResult(
      "runInExecutionPhase: execution-phase network policy confirmation check failed " +
        `before running the command (${confirmation.error ?? `exit status ${confirmation.status}`}) — refusing to run it under an unconfirmed policy.`,
    );
  }

  return handle.exec(cmd, options);
}
