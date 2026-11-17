/**
 * The spike's seams over a real `@vercel/sandbox` `Sandbox`, for the live harness.
 *
 * Two users (ADR-0029 §3, as this spike recommends it):
 *
 * - the sandbox's **default user** runs git and holds the token for the push — Windkeel's;
 * - the **person** is a separate user made with `Sandbox.createUser`, whom the terminal and editor
 *   run as. The sweep runs `STRAY_PROCESS_SWEEP` (the maker's `terminateStrayProcesses` script,
 *   imported, not copied) *as the person*, so it stops every process of the person's uid.
 *
 * With `personUser` unset the person *is* the default user — today's single-user image — and the
 * sweep is exactly `terminateStrayProcesses`.
 */

import type { Sandbox } from "@vercel/sandbox";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import { STRAY_PROCESS_SWEEP } from "../../../src/sandbox/vercel.js";
import type { ProcessSweep } from "../../../src/sandbox/provider.js";
import type { ProcessControl, ProcessSnapshot, WorkspaceExec } from "./sweep-then-push.js";

// Promoted to `src/sandbox/vercel-human-workspace.ts` (#369).
import { PROCESS_ENUMERATION, parseEnumeration } from "../../../src/sandbox/vercel-human-workspace.js";
export { PROCESS_ENUMERATION, parseEnumeration };

export async function run(
  sandbox: Sandbox,
  command: string,
  options: ExecOptions & { sudo?: boolean } = {},
): Promise<ExecResult> {
  const shell = options.args === undefined;
  const finished = await sandbox.runCommand({
    cmd: shell ? "sh" : command,
    args: shell ? ["-c", command] : options.args!,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.sudo ? { sudo: true } : {}),
  });
  const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
  return { status: finished.exitCode, signal: null, stdout, stderr };
}

/** The default user's view: git, the token file, and file API writes. */
export function workspaceExec(sandbox: Sandbox, checkoutPath: string): WorkspaceExec {
  return {
    exec: (command, options = {}) => run(sandbox, command, { cwd: checkoutPath, ...options }),
    writeFile: async (path, data) => {
      await sandbox.fs.writeFile(path, data);
    },
    exists: async (path) => (await run(sandbox, "test", { args: ["-e", path] })).status === 0,
    mkdtemp: async (prefix) => {
      const made = await run(sandbox, "mktemp", { args: ["-d", `/tmp/${prefix}XXXXXX`] });
      if (made.status !== 0) throw new Error(`mkdtemp failed: ${made.stderr}`);
      return made.stdout.trim();
    },
  };
}

export function processControl(sandbox: Sandbox, personUser?: string): ProcessControl {
  return {
    async sweep(): Promise<ProcessSweep> {
      const result = personUser
        ? await run(sandbox, "sudo", { args: ["-n", "-u", personUser, "sh", "-c", STRAY_PROCESS_SWEEP] })
        : await run(sandbox, "sh", { args: ["-c", STRAY_PROCESS_SWEEP] });
      const killed = /killed=(\d+)/.exec(result.stdout)?.[1];
      if (result.status === 0 && killed !== undefined) return { ensured: true, killed: Number(killed) };
      return { ensured: false, reason: `sweep exit ${result.status}: ${result.stdout.trim()} ${result.stderr.trim()}` };
    },
    async snapshot(): Promise<ProcessSnapshot> {
      // Root, so every process's /proc/<pid>/status is readable whatever hidepid says.
      const result = await run(sandbox, "sh", { args: ["-c", PROCESS_ENUMERATION], sudo: true });
      if (result.status !== 0) throw new Error(`process enumeration failed: ${result.stderr}`);
      return parseEnumeration(result.stdout);
    },
  };
}
