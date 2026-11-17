import { toolInstalled, type ExecOptions, type ExecResult, type ExecutionEnvironment } from "@windkeel/verification/exec/environment.js";
import { runInExecutionPhase } from "../sandbox/lifecycle.js";
import type { CredentialBrokerRule, SandboxHandle } from "../sandbox/provider.js";
import type { WorkerUsage } from "./adapter.js";

export interface Egress {
  domain: string;
  rules: CredentialBrokerRule[];
}

export interface TurnPaths {
  stdoutPath: string;
  stderrPath: string;
  donePath: string;
  pidPath: string;
}

export function turnPaths(scratchDir: string, turn: number): TurnPaths {
  return {
    stdoutPath: `${scratchDir}/turn-${turn}.events.jsonl`,
    stderrPath: `${scratchDir}/turn-${turn}.stderr.log`,
    donePath: `${scratchDir}/turn-${turn}.exit-status`,
    pidPath: `${scratchDir}/turn-${turn}.pgid`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function phasedEnv(handle: SandboxHandle, egress: Egress): ExecutionEnvironment {
  return {
    exec: (command: string, options?: ExecOptions): Promise<ExecResult> =>
      runInExecutionPhase(handle, egress.domain, egress.rules, command, options),
    readFile: handle.readFile.bind(handle),
    writeFile: handle.writeFile.bind(handle),
    exists: handle.exists.bind(handle),
    listFiles: handle.listFiles.bind(handle),
    mkdtemp: handle.mkdtemp.bind(handle),
  };
}

export interface VersionCheck {
  binary: string;
  expected: string;
  allowDrift: boolean;
  adapterName: string;
  toolName: string;
  pinName: string;
  adr: string;
  onDrift?: (detail: string) => void;
}

export async function verifyHarnessVersion(handle: SandboxHandle, egress: Egress, check: VersionCheck): Promise<string> {
  const env = phasedEnv(handle, egress);
  if (!(await toolInstalled(env, check.binary))) {
    throw new Error(
      `${check.adapterName}: \`${check.binary}\` is not available in this sandbox. It ships ` +
        `preinstalled in Vercel Sandbox's default \`universal\` image (${check.adr}); a missing binary ` +
        "means the wrong image, not a missing install step this adapter should perform.",
    );
  }
  const probe = await env.exec(check.binary, { args: ["--version"] });
  const observed = /(\d+\.\d+\.\d+(?:[-\w.]*)?)/.exec(probe.stdout.trim())?.[1] ?? probe.stdout.trim();
  if (observed !== check.expected) {
    const detail = `${check.toolName} reports version ${observed}, adapter is pinned to ${check.expected}`;
    if (!check.allowDrift) {
      throw new Error(
        `${check.adapterName}: ${detail}. ${check.adr} pins a known-good CLI version per run rather ` +
          "than tracking latest; set `allowVersionDrift` to proceed anyway, or update " +
          `${check.pinName} once the new release has been exercised.`,
      );
    }
    check.onDrift?.(detail);
  }
  return observed;
}

export async function readBaseRevision(
  handle: SandboxHandle,
  egress: Egress,
  workdir: string | undefined,
): Promise<string | undefined> {
  const result = await runInExecutionPhase(handle, egress.domain, egress.rules, "git", {
    args: ["rev-parse", "HEAD"],
    ...(workdir !== undefined ? { cwd: workdir } : {}),
  });
  const revision = result.stdout.trim();
  return result.status === 0 && revision !== "" ? revision : undefined;
}

export interface DetachedLaunch {
  scratchDir: string;
  paths: TurnPaths;
  workdir: string | undefined;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  stdinPath?: string;
  mkdirs?: readonly string[];
  label: string;
  adapterName: string;
}

export async function launchDetached(handle: SandboxHandle, egress: Egress, launch: DetachedLaunch): Promise<void> {
  const runnerPath = `${launch.scratchDir}/run.sh`;
  const command = launch.command.map(shellQuote).join(" ");
  const stdin = launch.stdinPath ? shellQuote(launch.stdinPath) : "/dev/null";
  const runner = [
    "#!/bin/sh",
    `# Windkeel ${launch.label} session runner. Backgrounded by start(); tailed by events().`,
    'echo $$ > "$WINDKEEL_PGID_FILE"',
    ...(launch.mkdirs ?? []).map((dir) => `mkdir -p ${shellQuote(dir)} || exit 126`),
    ...(launch.workdir ? [`cd ${shellQuote(launch.workdir)} || exit 127`] : []),
    `${command} < ${stdin} > "$WINDKEEL_STDOUT" 2> "$WINDKEEL_STDERR"`,
    'echo $? > "$WINDKEEL_DONE"',
    "",
  ].join("\n");
  await handle.writeFile(runnerPath, runner);

  const env = {
    ...launch.env,
    WINDKEEL_PGID_FILE: launch.paths.pidPath,
    WINDKEEL_STDOUT: launch.paths.stdoutPath,
    WINDKEEL_STDERR: launch.paths.stderrPath,
    WINDKEEL_DONE: launch.paths.donePath,
    WINDKEEL_RUNNER: runnerPath,
  };
  const launcher = [
    "set -m 2>/dev/null || true",
    "if command -v setsid >/dev/null 2>&1; then",
    '  setsid sh "$WINDKEEL_RUNNER" < /dev/null > /dev/null 2>&1 &',
    "else",
    '  sh "$WINDKEEL_RUNNER" < /dev/null > /dev/null 2>&1 &',
    "fi",
    "exit 0",
  ].join("\n");

  const result = await runInExecutionPhase(handle, egress.domain, egress.rules, "sh", {
    args: ["-c", launcher],
    env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${launch.adapterName}: could not start the ${launch.label} session: ${result.error ?? `launcher exited ${result.status}`}${result.stderr ? ` — ${result.stderr}` : ""}`,
    );
  }
}

export async function cancelProcessGroup(handle: SandboxHandle, egress: Egress, pidPath: string): Promise<void> {
  const script = [
    'pgid=$(cat "$WINDKEEL_PGID_FILE" 2>/dev/null || true)',
    '[ -n "$pgid" ] || exit 0',
    'kill -TERM -"$pgid" 2>/dev/null || true',
    "i=0; while [ $i -lt 20 ] && kill -0 -\"$pgid\" 2>/dev/null; do sleep 0.1; i=$((i+1)); done",
    'kill -KILL -"$pgid" 2>/dev/null || true',
    "exit 0",
  ].join("\n");
  await runInExecutionPhase(handle, egress.domain, egress.rules, "sh", {
    args: ["-c", script],
    env: { WINDKEEL_PGID_FILE: pidPath },
  });
}

const STDERR_TAIL_BYTES = 2000;

export async function stderrTail(handle: SandboxHandle, stderrPath: string): Promise<string> {
  try {
    const raw = await handle.readFile(stderrPath);
    const text = String(raw).trimEnd();
    if (!text) return "";
    const tail = text.length > STDERR_TAIL_BYTES ? `…${text.slice(-STDERR_TAIL_BYTES)}` : text;
    return `. Its stderr ended with: ${tail}`;
  } catch {
    return "";
  }
}

const USAGE_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "cacheWriteInputTokens",
] as const;

export function sumUsage(turns: WorkerUsage[]): WorkerUsage {
  const total: WorkerUsage = {};
  for (const key of USAGE_KEYS) {
    const present = turns.filter((turn) => turn[key] !== undefined);
    if (present.length > 0) total[key] = present.reduce((sum, turn) => sum + (turn[key] ?? 0), 0);
  }
  return total;
}

export function conservativeUsage(a: WorkerUsage, b: WorkerUsage): WorkerUsage {
  const merged: WorkerUsage = {};
  for (const key of ["inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "cacheWriteInputTokens"] as const) {
    if (a[key] !== undefined || b[key] !== undefined) merged[key] = Math.max(a[key] ?? 0, b[key] ?? 0);
  }
  if (a.cachedInputTokens !== undefined && b.cachedInputTokens !== undefined) {
    merged.cachedInputTokens = Math.min(a.cachedInputTokens, b.cachedInputTokens);
  }
  return merged;
}
