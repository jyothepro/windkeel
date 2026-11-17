/**
 * Fakes for the sequencing tests. Git is **real** (a temp checkout and a bare `file://` remote,
 * through the verification package's `LocalExecutionEnvironment`), because author lines, hooks,
 * config refusal and what actually landed on the remote are exactly what a fake git would get
 * wrong. Processes and tokens are fake, and everything writes to one shared log so a test can
 * assert *order*.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import type { ProcessSweep } from "../../../src/sandbox/provider.js";
import type { ProcInfo, ProcessControl, ProcessSnapshot, PushToken, PushTokenIssuer, WorkspaceExec } from "./sweep-then-push.js";

export const BRANCH = "windkeel/run-r1";
export const WINDKEEL = { name: "Windkeel", email: "factory@windkeel.invalid" };
export const PERSON = { githubId: 583231, login: "octocat", name: "The Octocat" };
export const TOKEN_VALUE = "ghs_FAKE_TOKEN_VALUE_0123456789";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

export interface Fixture {
  root: string;
  checkout: string;
  remote: string;
  remoteUrl: string;
  seedSha: string;
}

/** A bare remote whose run branch holds the seed candidate, and a checkout of it. */
export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "spike-368-"));
  const remote = join(root, "remote.git");
  const checkout = join(root, "work");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", checkout);
  writeFileSync(join(checkout, ".gitignore"), ".env\nnode_modules\n");
  writeFileSync(join(checkout, "a.ts"), "export const a = 1;\n");
  git(checkout, "add", "-A");
  git(checkout, "-c", "user.name=Windkeel", "-c", `user.email=${WINDKEEL.email}`, "commit", "-q", "-m", "candidate");
  const seedSha = git(checkout, "rev-parse", "HEAD");
  git(checkout, "push", "-q", remote, `HEAD:refs/heads/${BRANCH}`);
  return { root, checkout, remote, remoteUrl: `file://${remote}`, seedSha };
}

/** The person's session: staged, unstaged-on-top, untracked, ignored, and a nested directory. */
export function personEdits(f: Fixture): void {
  writeFileSync(join(f.checkout, "a.ts"), "export const a = 2;\n");
  git(f.checkout, "add", "a.ts");
  writeFileSync(join(f.checkout, "a.ts"), "export const a = 3;\n");
  mkdirSync(join(f.checkout, "src"), { recursive: true });
  writeFileSync(join(f.checkout, "src", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(f.checkout, ".env"), "SECRET=hunter2\n");
}

export function plantHooks(f: Fixture): string[] {
  const markers: string[] = [];
  for (const hook of ["pre-commit", "commit-msg", "post-commit", "pre-push", "reference-transaction", "post-index-change"]) {
    const marker = join(f.root, `hook-ran-${hook}`);
    markers.push(marker);
    writeFileSync(join(f.checkout, ".git", "hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }
  return markers;
}

/** Real git on this machine, with every call logged and optional fault injection. */
export class RecordingWorkspace implements WorkspaceExec {
  private readonly local = new LocalExecutionEnvironment();
  readonly argv: string[][] = [];
  failRm = false;
  failChmod = false;
  constructor(private readonly log: string[]) {}

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.argv.push([command, ...(options.args ?? [])]);
    const sub = command === "git" ? (options.args ?? []).find((a, i, all) => all[i - 1] !== "-c" && a !== "-c") : undefined;
    this.log.push(`exec:${command}${sub ? ` ${sub}` : ""}`);
    if (command === "chmod" && this.failChmod) return { status: 1, signal: null, stdout: "", stderr: "chmod: Operation not permitted" };
    if (command === "rm" && this.failRm) return { status: 1, signal: null, stdout: "", stderr: "rm: Operation not permitted" };
    return this.local.exec(command, options);
  }
  writeFile(path: string, data: Buffer | string) {
    this.log.push(`write:${path}`);
    return this.local.writeFile(path, data);
  }
  exists(path: string) {
    return this.local.exists(path);
  }
  mkdtemp(prefix: string) {
    return this.local.mkdtemp(prefix);
  }
}

export const PERSON_UID = 1001;
export const BASELINE: ProcInfo[] = [
  { pid: 1, ppid: 0, uid: 0, state: "S", startTime: "1", comm: "init" },
  { pid: 40, ppid: 1, uid: 0, state: "S", startTime: "90", comm: "sandbox-agent" },
];

export function proc(p: Partial<ProcInfo> & { pid: number }): ProcInfo {
  return { ppid: 1, uid: PERSON_UID, state: "S", startTime: String(1000 + p.pid), comm: "node", ...p };
}

/**
 * Scripted sweeps and snapshots. `sweeps[i]` / `snapshots[i]` answer the i-th call (the last one
 * repeats); `onSnapshot(i)` runs before the i-th snapshot is returned, for "something happened
 * between the sweep and the check".
 */
export class FakeProcessControl implements ProcessControl {
  sweepCalls = 0;
  snapshotCalls = 0;
  constructor(
    private readonly log: string[],
    private readonly script: {
      sweeps?: ProcessSweep[];
      snapshots?: ProcessSnapshot[];
      onSnapshot?: (i: number) => void;
    } = {},
  ) {}

  async sweep(): Promise<ProcessSweep> {
    const sweeps = this.script.sweeps ?? [{ ensured: true, killed: 3 }];
    const answer = sweeps[Math.min(this.sweepCalls++, sweeps.length - 1)]!;
    this.log.push(`sweep:${answer.ensured ? "ok" : "unconfirmed"}`);
    return answer;
  }

  async snapshot(): Promise<ProcessSnapshot> {
    const i = this.snapshotCalls++;
    this.script.onSnapshot?.(i);
    const snapshots = this.script.snapshots ?? [{ self: [900, 40, 1], processes: [...BASELINE, proc({ pid: 900, uid: 0, comm: "sh" })] }];
    const answer = snapshots[Math.min(i, snapshots.length - 1)]!;
    this.log.push(`snapshot:${answer.processes.length}`);
    return answer;
  }
}

export class FakeIssuer implements PushTokenIssuer {
  minted: PushToken[] = [];
  revoked: PushToken[] = [];
  purposes: string[] = [];
  failMint = false;
  failRevoke = false;
  constructor(private readonly log: string[]) {}

  async mint(request: { repositoryUrl: string; branch: string; purpose: string }): Promise<PushToken> {
    this.log.push("mint");
    if (this.failMint) throw new Error("GitHub said no");
    const token = { username: "x-access-token", token: TOKEN_VALUE, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    this.minted.push(token);
    this.purposes.push(request.purpose);
    return token;
  }

  async revoke(token: PushToken): Promise<void> {
    this.log.push("revoke");
    if (this.failRevoke) throw new Error("revoke failed");
    this.revoked.push(token);
  }
}
