import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FactoryBenchTask, HiddenTestResult } from "./bench-factory.js";

export const DEFAULT_HIDDEN_TIMEOUT_SECONDS = 600;
const OUTPUT_TAIL_BYTES = 4000;

const KEPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "USER"];

export function hiddenTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of KEPT_ENV) {
    if (env[key] !== undefined) kept[key] = env[key];
  }
  return kept;
}

export interface HiddenTestOptions {
  workRoot?: string;
  timeoutSeconds?: number;
  keep?: boolean;
  applyPatch?: string;
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...hiddenTestEnv(), GIT_TERMINAL_PROMPT: "0" },
    timeout: 300_000,
  });
}

const tail = (text: string): string =>
  text.length <= OUTPUT_TAIL_BYTES ? text : `… ${text.slice(text.length - OUTPUT_TAIL_BYTES)}`;

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  home: string,
): Promise<{ exitCode: number | null; timedOut: boolean; output: string; spawnError?: string }> {
  return new Promise((resolvePromise) => {
    let output = "";
    let timedOut = false;
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...hiddenTestEnv(), HOME: home, TMPDIR: home },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString("utf8"));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, timedOut, output, spawnError: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut, output });
    });
  });
}

export async function runHiddenTests(
  task: FactoryBenchTask,
  head: { sha: string; prNumber?: number | null },
  options: HiddenTestOptions = {},
): Promise<HiddenTestResult> {
  const command = task.hidden_tests?.command?.trim();
  if (!command) return { outcome: "not_run", reason: "no hidden test command" };
  if (!/^[0-9a-f]{7,64}$/i.test(head.sha)) return { outcome: "not_run", reason: `not a commit sha: ${head.sha}` };

  const work = mkdtempSync(join(options.workRoot ?? tmpdir(), "windkeel-bench-hidden-"));
  const repo = join(work, "repo");
  const started = Date.now();
  try {
    const cloned = spawnSync("git", ["clone", "--quiet", "--no-checkout", task.repository, repo], {
      encoding: "utf8",
      env: { ...hiddenTestEnv(), GIT_TERMINAL_PROMPT: "0" },
      timeout: 300_000,
    });
    if (cloned.status !== 0) {
      return { outcome: "not_run", reason: `clone failed: ${(cloned.stderr || cloned.error?.message || "").trim()}` };
    }
    if (git(repo, "cat-file", "-e", `${head.sha}^{commit}`).status !== 0) {
      if (head.prNumber) git(repo, "fetch", "--quiet", "origin", `+refs/pull/${head.prNumber}/head:refs/remotes/origin/pr-head`);
      if (git(repo, "cat-file", "-e", `${head.sha}^{commit}`).status !== 0) git(repo, "fetch", "--quiet", "origin", head.sha);
    }
    const checkout = git(repo, "checkout", "--quiet", "--detach", head.sha);
    if (checkout.status !== 0) {
      return { outcome: "not_run", reason: `head ${head.sha} not found in ${task.repository}: ${checkout.stderr.trim()}` };
    }
    if (git(repo, "cat-file", "-e", `${task.base_ref}^{commit}`).status !== 0) git(repo, "fetch", "--quiet", "origin", task.base_ref);
    const ancestor = git(repo, "merge-base", "--is-ancestor", task.base_ref, head.sha);
    if (ancestor.status !== 0) {
      return { outcome: "not_run", reason: `head ${head.sha.slice(0, 12)} does not descend from base_ref ${task.base_ref}` };
    }

    if (options.applyPatch) {
      const applied = git(repo, "apply", options.applyPatch);
      if (applied.status !== 0) return { outcome: "not_run", reason: `patch does not apply: ${applied.stderr.trim()}` };
    }

    for (const file of task.hidden_tests.files) {
      const target = join(repo, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(task.dir, "hidden", file), target);
    }

    const timeoutSeconds = options.timeoutSeconds ?? task.hidden_tests.timeout_seconds ?? DEFAULT_HIDDEN_TIMEOUT_SECONDS;
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const ran = await runCommand(command, repo, timeoutSeconds * 1000, home);
    const durationMs = Date.now() - started;
    if (ran.spawnError) return { outcome: "not_run", reason: `could not start: ${ran.spawnError}`, durationMs };
    if (ran.timedOut) {
      return { outcome: "not_run", reason: `timeout: still running after ${timeoutSeconds}s`, durationMs, outputTail: ran.output };
    }
    if (ran.exitCode === 127) {
      return { outcome: "not_run", reason: "command not found (exit 127)", exitCode: 127, durationMs, outputTail: ran.output };
    }
    return {
      outcome: ran.exitCode === 0 ? "pass" : "fail",
      reason: `exit ${ran.exitCode}`,
      exitCode: ran.exitCode,
      durationMs,
      outputTail: ran.output,
    };
  } catch (error) {
    return { outcome: "not_run", reason: `hidden test runner failed: ${(error as Error).message}` };
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true });
  }
}

export interface HiddenCheckResult {
  id: string;
  base: HiddenTestResult;
  reference: HiddenTestResult | null;
  ok: boolean;
  problem?: string;
}

export async function checkHiddenTests(
  task: FactoryBenchTask,
  run: typeof runHiddenTests = runHiddenTests,
): Promise<HiddenCheckResult> {
  const base = await run(task, { sha: task.base_ref });
  let reference: HiddenTestResult | null = null;
  if (task.reference_patch) {
    reference = await run(task, { sha: task.base_ref }, { applyPatch: join(task.dir, task.reference_patch) });
  } else if (task.upstream?.repo && task.upstream.fix_commit) {
    reference = await run({ ...task, repository: task.upstream.repo }, { sha: task.upstream.fix_commit });
  }
  const problems = [
    base.outcome === "fail"
      ? null
      : `on base_ref the hidden tests ${base.outcome === "pass" ? "already pass" : `did not run (${base.reason ?? "?"})`}`,
    reference === null
      ? "no reference_patch or upstream.fix_commit to check a solution against"
      : reference.outcome === "pass"
        ? null
        : `the reference solution ${reference.outcome === "fail" ? "fails them" : `could not be tested (${reference.reason ?? "?"})`}`,
  ].filter((p): p is string => p !== null);
  return { id: task.id, base, reference, ok: problems.length === 0, ...(problems.length ? { problem: problems.join("; ") } : {}) };
}
