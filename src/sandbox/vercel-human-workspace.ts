import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import type { ProcessControl, ProcessSnapshot, ProcInfo } from "../factory/human-push.js";
import {
  HUMAN_WORKSPACE_PORT,
  type HumanWorkspaceCreateOptions,
  type HumanWorkspaceHandle,
  type HumanWorkspaceProvider,
} from "./human-workspace.js";
import { HUMAN_WORKSPACE_SERVER_FILES, type HumanWorkspaceServerFile } from "./human-workspace-server-files.js";
import { installPhasePolicy } from "./network-phase.js";
import { SandboxGoneError, type NetworkPolicy, type ProcessSweep, type SandboxUsage } from "./provider.js";
import { STRAY_PROCESS_SWEEP } from "./vercel.js";

export const PROCESS_ENUMERATION = [
  'self=" "',
  "p=$$",
  'while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; do',
  '  self="$self$p "',
  '  [ "$p" -eq 1 ] && break',
  '  p=$(sed -e "s/^.*) //" "/proc/$p/stat" 2>/dev/null | cut -d" " -f2)',
  "done",
  'echo "self=$self"',
  "for d in /proc/[0-9]*; do",
  '  pid=${d#/proc/}',
  '  st=$(sed -e "s/^.*) //" "$d/stat" 2>/dev/null) || continue',
  '  [ -n "$st" ] || continue',
  "  set -- $st",
  '  uid=$(awk \'/^Uid:/ { print $2 }\' "$d/status" 2>/dev/null)',
  '  [ -n "$uid" ] || continue',
  '  comm=$(tr -d " \\t\\n" < "$d/comm" 2>/dev/null)',
  '  k=0; [ "$(head -c 1 "$d/cmdline" 2>/dev/null | wc -c)" -eq 0 ] && k=1',
  '  echo "p $pid $2 $uid $1 ${20} $k $comm"',
  "done",
].join("\n");

export function parseEnumeration(stdout: string): ProcessSnapshot {
  const self: number[] = [];
  const processes: ProcInfo[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("self=")) {
      self.push(...line.slice(5).split(/\s+/).filter(Boolean).map(Number));
    } else if (line.startsWith("p ")) {
      const [, pid, ppid, uid, state, startTime, kernel, ...comm] = line.split(" ");
      processes.push({
        pid: Number(pid),
        ppid: Number(ppid),
        uid: Number(uid),
        state: state ?? "?",
        startTime: startTime ?? "",
        kernel: kernel === "1",
        comm: comm.join(" "),
      });
    }
  }
  return { self, processes };
}

const CHECKOUT_DISCOVERY = [
  'cd "$HOME" 2>/dev/null || exit 1',
  '[ -d .git ] && { pwd; exit 0; }',
  'for d in */; do [ -d "$d/.git" ] && { cd "$d" && pwd; exit 0; }; done',
  "exit 1",
].join("\n");

export const SERVER_PARENT = "/opt";
const SERVER_PREFIX = "windkeel-ws.";

export function serverManifest(files: readonly HumanWorkspaceServerFile[] = HUMAN_WORKSPACE_SERVER_FILES): string {
  return (
    files
      .map((file) => {
        const sha256 = createHash("sha256").update(file.content, "utf8").digest("hex");
        if (sha256 !== file.sha256) throw new Error(`workspace server file ${file.path}: embedded content does not match its recorded hash`);
        return `${sha256}  ${file.path}`;
      })
      .join("\n") + "\n"
  );
}

export const SERVER_INSTALL_SCRIPT = [
  "set -eu",
  'src="$1"; manifest="$2"; parent="${3:-/opt}"',
  `rm -rf "$parent"/${SERVER_PREFIX}*`,
  `dir=$(mktemp -d "$parent/${SERVER_PREFIX}XXXXXXXX")`,
  'chmod 0755 "$dir"',
  "verify() {",
  '  printf "%s" "$manifest" | while read -r want rel; do',
  '    [ -n "$rel" ] || continue',
  '    [ -f "$dir/$rel" ] && [ ! -L "$dir/$rel" ] || { echo "missing: $rel" >&2; exit 3; }',
  '    got=$(sha256sum "$dir/$rel" | cut -d" " -f1)',
  '    [ "$got" = "$want" ] || { echo "hash mismatch: $rel" >&2; exit 3; }',
  "  done",
  "}",
  'printf "%s" "$manifest" | while read -r want rel; do',
  '  [ -n "$rel" ] || continue',
  '  mkdir -p "$dir/$(dirname "$rel")"',
  '  rm -f "$dir/$rel"',
  '  cat -- "$src/$rel" > "$dir/$rel"',
  "done",
  "verify",
  'mkdir -p "$dir/.npm-home"',
  '(cd "$dir" && HOME="$dir/.npm-home" npm ci --omit=dev --no-audit --no-fund --ignore-scripts --userconfig=/dev/null --globalconfig=/dev/null --cache="$dir/.npm-home/cache" >/dev/null)',
  'rm -rf "$dir/.npm-home"',
  "verify",
  'chmod -R go-w "$dir"',
  'rm -rf -- "$src"',
  'echo "dir=$dir"',
].join("\n");

export interface VercelHumanWorkspaceOptions {
  token: string;
  teamId: string;
  projectId: string;
  serverFiles?: readonly HumanWorkspaceServerFile[];
}

export class VercelHumanWorkspaceHandle implements HumanWorkspaceHandle {
  readonly personUids: number[] = [];
  readonly processes: ProcessControl;

  constructor(
    private readonly sandbox: Sandbox,
    readonly checkoutPath: string,
    uid: number,
    private readonly serverFiles: readonly HumanWorkspaceServerFile[] = HUMAN_WORKSPACE_SERVER_FILES,
  ) {
    this.personUids.push(uid);
    this.processes = {
      sweep: async (): Promise<ProcessSweep> => {
        const result = await this.exec("sh", { args: ["-c", STRAY_PROCESS_SWEEP] });
        const killed = /killed=(\d+)/.exec(result.stdout)?.[1];
        if (result.status === 0 && killed !== undefined) return { ensured: true, killed: Number(killed) };
        return { ensured: false, reason: `sweep exit ${result.status}: ${result.stdout.trim()} ${result.stderr.trim()}` };
      },
      snapshot: async (): Promise<ProcessSnapshot> => {
        const result = await this.run("sh", { args: ["-c", PROCESS_ENUMERATION], sudo: true });
        if (result.status !== 0) throw new Error(`process enumeration failed: ${result.stderr}`);
        return parseEnumeration(result.stdout);
      },
    };
  }

  get name(): string {
    return this.sandbox.name;
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.run(command, options);
  }

  private async run(command: string, options: ExecOptions & { sudo?: boolean } = {}): Promise<ExecResult> {
    const shell = options.args === undefined;
    try {
      const finished = await this.sandbox.runCommand({
        cmd: shell ? "sh" : command,
        args: shell ? ["-c", command] : options.args!,
        cwd: options.cwd ?? this.checkoutPath,
        ...(options.env ? { env: options.env } : {}),
        ...(options.sudo ? { sudo: true } : {}),
      });
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
      return { status: finished.exitCode, signal: null, stdout, stderr };
    } catch (error) {
      return { status: null, signal: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async readFile(path: string): Promise<Buffer> {
    return this.sandbox.fs.readFile(path);
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    await this.sandbox.fs.writeFile(path, data);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.exec("test", { args: ["-e", path] })).status === 0;
  }

  async mkdtemp(prefix: string): Promise<string> {
    const made = await this.exec("mktemp", { args: ["-d", `/tmp/${prefix}XXXXXX`] });
    if (made.status !== 0) throw new Error(`mkdtemp failed: ${made.stderr}`);
    return made.stdout.trim();
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    const allow = policy.mode === "allow-all" ? ["*"] : policy.mode === "deny-all" ? [] : [...(policy.allowedDomains ?? [])];
    await this.sandbox.update({ networkPolicy: { allow } });
  }

  async startServer(options: { tokenSha256: string; expiresAt: Date }): Promise<{ origin: string }> {
    await this.stopServer();
    const manifest = serverManifest(this.serverFiles);
    const staging = await this.mkdtemp("windkeel-ws-src-");
    for (const file of this.serverFiles) {
      const slash = file.path.lastIndexOf("/");
      if (slash > 0) await this.exec("mkdir", { args: ["-p", `${staging}/${file.path.slice(0, slash)}`] });
      await this.writeFile(`${staging}/${file.path}`, Buffer.from(file.content, "utf8"));
    }
    const installed = await this.run("sh", {
      args: ["-c", SERVER_INSTALL_SCRIPT, "windkeel-ws", staging, manifest, SERVER_PARENT],
      cwd: "/",
      sudo: true,
    });
    const dir = /^dir=(\S+)$/m.exec(installed.stdout)?.[1];
    if (installed.status !== 0 || !dir || !dir.startsWith(`${SERVER_PARENT}/${SERVER_PREFIX}`)) {
      throw new Error(`workspace server setup failed: ${(installed.error ?? installed.stderr).trim().slice(-500)}`);
    }
    const origin = new URL(this.sandbox.domain(HUMAN_WORKSPACE_PORT)).origin;
    await this.sandbox.runCommand({
      cmd: "node",
      args: [`${dir}/server/server.mjs`],
      cwd: this.checkoutPath,
      detached: true,
      env: {
        WINDKEEL_WS_TOKEN_SHA256: options.tokenSha256,
        WINDKEEL_WS_EXPIRES_AT: String(options.expiresAt.getTime()),
        WINDKEEL_WS_PUBLIC_ORIGIN: origin,
        WINDKEEL_WS_PORT: String(HUMAN_WORKSPACE_PORT),
        WINDKEEL_WS_CWD: this.checkoutPath,
      },
    });
    return { origin };
  }

  async stopServer(): Promise<void> {
    await this.exec("sh", {
      args: [
        "-c",
        `for d in /proc/[0-9]*; do grep -q "${SERVER_PARENT}/${SERVER_PREFIX}[^/]*/server/server.mjs" "$d/cmdline" 2>/dev/null && kill -KILL "\${d#/proc/}" 2>/dev/null; done; true`,
      ],
    });
  }

  async usage(): Promise<SandboxUsage> {
    return {
      activeCpuMs: this.sandbox.activeCpuUsageMs ?? 0,
      wallClockMs: this.sandbox.totalDurationMs ?? 0,
      networkEgressBytes: this.sandbox.networkTransfer?.egress ?? 0,
    };
  }

  async sleep(): Promise<void> {
    await this.sandbox.stop();
  }

  async destroy(): Promise<void> {
    await this.sandbox.stop().catch(() => undefined);
    await this.sandbox.delete();
  }
}

export class VercelHumanWorkspaceProvider implements HumanWorkspaceProvider {
  readonly name = "vercel";

  constructor(private readonly options: VercelHumanWorkspaceOptions) {}

  private get credentials() {
    return { token: this.options.token, teamId: this.options.teamId, projectId: this.options.projectId };
  }

  async create(options: HumanWorkspaceCreateOptions): Promise<HumanWorkspaceHandle> {
    const credential = options.gitCredentials;
    const sandbox = await Sandbox.create({
      name: `windkeel-human-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      source: {
        type: "git",
        url: options.repoUrl,
        revision: options.baseSha,
        ...(credential ? { username: credential.username, password: credential.token } : {}),
      },
      resources: { vcpus: 2 },
      timeout: options.timeoutMs,
      ports: [HUMAN_WORKSPACE_PORT],
      persistent: true,
      networkPolicy: { allow: [...(installPhasePolicy().allowedDomains ?? [])] },
      ...this.credentials,
    });
    return this.handleFor(sandbox);
  }

  async attach(name: string, options: { resume?: boolean } = {}): Promise<HumanWorkspaceHandle> {
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.get({ name, ...(options.resume ? { resume: true } : {}), ...this.credentials });
    } catch (error) {
      throw new SandboxGoneError(name, error);
    }
    if (!sandbox) throw new SandboxGoneError(name);
    return this.handleFor(sandbox);
  }

  private async handleFor(sandbox: Sandbox): Promise<HumanWorkspaceHandle> {
    const probe = await sandbox.runCommand({ cmd: "sh", args: ["-c", CHECKOUT_DISCOVERY] });
    const checkout = (await probe.stdout()).trim();
    if (probe.exitCode !== 0 || !checkout) throw new Error("human workspace: no checkout found under $HOME");
    const id = await sandbox.runCommand({ cmd: "id", args: ["-u"] });
    const uid = Number((await id.stdout()).trim());
    return new VercelHumanWorkspaceHandle(sandbox, checkout, Number.isInteger(uid) ? uid : 1000, this.options.serverFiles ?? HUMAN_WORKSPACE_SERVER_FILES);
  }
}
