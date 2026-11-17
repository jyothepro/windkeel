import { Sandbox, Snapshot } from "@vercel/sandbox";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import {
  buildCredentialBrokerAllowMap,
  buildPhaseAllowMap,
  CODEX_API_KEY_PLACEHOLDER,
  makerModelKeyRule,
} from "./credential-broker.js";
import { installPhasePolicy } from "./network-phase.js";
import { hardenedGit } from "./git-hardening.js";
import { installGitCredential, removeGitCredential } from "./git-credentials.js";
import { SandboxGoneError, type SandboxAttachOptions } from "./provider.js";
import type {
  CredentialBrokerRule,
  NetworkPolicy,
  SandboxCreateOptions,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxRole,
  SandboxSnapshot,
  SandboxUsage,
  ProcessSweep,
} from "./provider.js";

const GIT_TOKEN_USERNAME = "x-access-token";

export interface VercelSandboxProviderOptions {
  token: string;
  teamId: string;
  projectId: string;
  makerModelApiDomain?: string;
  makerModelKeyEnvVar?: string;
  environmentSnapshots?: boolean;
}

const CHECKOUT_DISCOVERY = [
  'cd "$HOME" 2>/dev/null || exit 1',
  '[ -d .git ] && { pwd; exit 0; }',
  'for d in */; do [ -d "$d/.git" ] && { cd "$d" && pwd; exit 0; }; done',
  "exit 1",
].join("\n");

async function discoverCheckoutPath(sandbox: Sandbox, context: string): Promise<string> {
  const finished = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", CHECKOUT_DISCOVERY],
    detached: false,
  });
  const path = (await finished.stdout()).trim();
  if (finished.exitCode !== 0 || !path) {
    throw new Error(
      `could not find the repository checkout inside the sandbox (${context}). The platform ` +
        "clones into $HOME; neither $HOME nor any directory directly below it holds a `.git`. " +
        "Nothing downstream can run without it — a worker session would start outside the " +
        "repository and an agent would refuse or, worse, edit the wrong tree.",
    );
  }
  return path;
}

function sandboxName(role: SandboxRole): string {
  return `windkeel-${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}


function isCommandStartFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /executable file not found/i.test(message);
}

export const STRAY_PROCESS_SWEEP = [
  "me=$(id -u)",
  'keep=" "',
  "p=$$",
  'while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; do',
  '  keep="$keep$p "',
  '  [ "$p" -eq 1 ] && break',
  '  p=$(sed -e "s/^.*) //" "/proc/$p/stat" 2>/dev/null | cut -d" " -f2)',
  "done",
  "collect() {",
  '  t=""',
  "  for d in /proc/[0-9]*; do",
  '    pid=${d#/proc/}',
  '    case "$keep" in *" $pid "*) continue ;; esac',
  '    u=$(awk \'/^State:/ { s = $2 } /^Uid:/ { u = $2 } END { if (s != "Z" && s != "X") print u }\' "$d/status" 2>/dev/null)',
  '    [ "$u" = "$me" ] && t="$t $pid"',
  "  done",
  "}",
  "killed=0",
  "i=0",
  "while [ $i -lt 10 ]; do",
  "  collect",
  '  if [ -z "$t" ]; then echo "killed=$killed"; exit 0; fi',
  '  for pid in $t; do kill -STOP "$pid" 2>/dev/null; done',
  '  for pid in $t; do kill -KILL "$pid" 2>/dev/null && killed=$((killed + 1)); done',
  "  i=$((i + 1))",
  "done",
  "collect",
  'if [ -z "$t" ]; then echo "killed=$killed"; exit 0; fi',
  'echo "still running after ten passes:$t"',
  "exit 3",
].join("\n");

class VercelSandboxHandle implements SandboxHandle {
  readonly role: SandboxRole;
  readonly checkoutPath: string;
  private readonly sandbox: Sandbox;
  private destroyed = false;
  private cachedUsage: SandboxUsage | null = null;
  private narrowedDomains: string[] | undefined;
  private credentialRules: CredentialBrokerRule[] = [];

  constructor(sandbox: Sandbox, role: SandboxRole, checkoutPath: string, narrowedDomains?: string[]) {
    this.sandbox = sandbox;
    this.role = role;
    this.checkoutPath = checkoutPath;
    this.narrowedDomains = narrowedDomains;
  }

  get id(): string {
    return this.sandbox.name;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const shellCommand = options.args === undefined;
    let finished;
    try {
      finished = await this.sandbox.runCommand({
        cmd: shellCommand ? "sh" : command,
        ...(shellCommand ? { args: ["-c", command] } : { args: options.args! }),
        cwd: options.cwd ?? this.checkoutPath,
        ...(options.env ? { env: options.env } : {}),
        detached: false,
      });
    } catch (err) {
      if (!isCommandStartFailure(err)) throw err;
      return {
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
    return {
      status: finished.exitCode,
      signal: null,
      stdout,
      stderr,
    };
  }

  async readFile(path: string): Promise<Buffer> {
    return this.sandbox.fs.readFile(path);
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    await this.sandbox.fs.writeFile(path, data);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec("test", { args: ["-e", path] });
    return result.status === 0;
  }

  async listFiles(dir: string): Promise<Array<{ path: string; bytes: number }>> {
    const result = await this.exec("sh", {
      args: [
        "-c",
        'test -d "$TARGET_DIR" && find "$TARGET_DIR" -type f -printf "%s %p\\n" || true',
      ],
      env: { TARGET_DIR: dir },
    });
    if (result.status !== 0 || result.stdout.trim() === "") return [];

    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const spaceIndex = line.indexOf(" ");
        const bytes = Number.parseInt(line.slice(0, spaceIndex), 10);
        const absolutePath = line.slice(spaceIndex + 1);
        const relativePath = absolutePath.startsWith(prefix)
          ? absolutePath.slice(prefix.length)
          : absolutePath;
        return { path: relativePath, bytes };
      });
  }

  async mkdtemp(prefix: string): Promise<string> {
    const result = await this.exec("mktemp", { args: ["-d", `/tmp/${prefix}XXXXXX`] });
    if (result.status !== 0) {
      throw new Error(`mkdtemp failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    this.narrowedDomains = policy.allowedDomains ?? [];
    await this.syncNetworkPolicy();
  }

  async applyCredentialBrokerRules(rules: CredentialBrokerRule[]): Promise<void> {
    this.credentialRules = rules;
    await this.syncNetworkPolicy();
  }

  private async syncNetworkPolicy(): Promise<void> {
    const allow =
      this.narrowedDomains === undefined
        ? await buildCredentialBrokerAllowMap(this.credentialRules)
        : await buildPhaseAllowMap({ mode: "allowlist", allowedDomains: this.narrowedDomains }, this.credentialRules);
    await this.sandbox.update({ networkPolicy: { allow } });
  }

  async terminateStrayProcesses(): Promise<ProcessSweep> {
    const result = await this.exec("sh", { args: ["-c", STRAY_PROCESS_SWEEP] });
    const killed = /killed=(\d+)/.exec(result.stdout)?.[1];
    if (result.status === 0 && killed !== undefined) return { ensured: true, killed: Number(killed) };
    return {
      ensured: false,
      reason:
        `the process sweep could not confirm the sandbox was quiet ` +
        `(${result.error ?? `exit ${result.status}`}${result.stdout.trim() ? `: ${result.stdout.trim()}` : ""})`,
    };
  }

  private currentUsage(until: number): SandboxUsage {
    return {
      activeCpuMs: this.sandbox.activeCpuUsageMs ?? 0,
      wallClockMs: Math.max(0, until - this.sandbox.createdAt.getTime()),
      networkEgressBytes: this.sandbox.networkTransfer?.egress ?? 0,
    };
  }

  async usage(): Promise<SandboxUsage> {
    return this.cachedUsage ?? this.currentUsage(Date.now());
  }

  async snapshot(options: { expirationMs: number }): Promise<SandboxSnapshot> {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is gone and cannot be snapshotted`);
    this.destroyed = true;
    const snap = await this.sandbox.snapshot({ expiration: options.expirationMs });
    this.cachedUsage = this.currentUsage(Date.now());
    return {
      snapshotId: snap.snapshotId,
      ...(Number.isFinite(snap.sizeBytes) ? { sizeBytes: snap.sizeBytes } : {}),
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.sandbox.stop();
    this.cachedUsage = this.currentUsage(Date.now());
    await this.sandbox.delete();
  }
}

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown; response?: { status?: unknown } } | null)?.status ??
    (err as { response?: { status?: unknown } } | null)?.response?.status;
  if (status === 404) return true;
  return /not[ _-]?found/i.test(err instanceof Error ? err.message : String(err));
}

async function checkoutFromRemote(handle: SandboxHandle, options: SandboxCreateOptions): Promise<void> {
  const exec = (cmd: string, opts?: Parameters<SandboxHandle["exec"]>[1]) => handle.exec(cmd, opts);
  const at = { cwd: handle.checkoutPath };
  const must = async (what: string, result: Promise<{ status: number | null; stderr: string; error?: string; stdout: string }>) => {
    const r = await result;
    if (r.error || r.status !== 0) {
      throw new Error(`restoring a snapshot: ${what} failed: ${r.error ?? (r.stderr.trim() || `exit ${r.status}`)}`);
    }
    return r.stdout.trim();
  };
  await must("set origin", hardenedGit(exec, ["remote", "set-url", "origin", options.repoUrl], at));
  let credentialFile: string | undefined;
  try {
    if (options.gitCredentials) {
      credentialFile = await installGitCredential(handle, new URL(options.repoUrl).hostname, options.gitCredentials);
    }
    await must(
      "fetch",
      hardenedGit(exec, ["fetch", "-q", "--prune", "origin"], {
        ...at,
        ...(credentialFile ? { extraConfig: [`credential.helper=store --file ${credentialFile}`] } : {}),
      }),
    );
  } finally {
    if (credentialFile) await removeGitCredential(handle);
  }
  const revision = options.gitRevision ?? "HEAD";
  let remoteRef = "";
  if (revision === "HEAD") {
    const head = await hardenedGit(exec, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], at);
    remoteRef = head.status === 0 ? head.stdout.trim() : "";
  } else {
    const branch = await hardenedGit(exec, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${revision}`], at);
    remoteRef = branch.status === 0 ? `origin/${revision}` : "";
  }
  if (remoteRef) {
    await must(`check out ${remoteRef}`, hardenedGit(exec, ["checkout", "-q", "-f", "-B", remoteRef.replace(/^origin\//, ""), remoteRef], at));
  } else {
    await must(`check out ${revision}`, hardenedGit(exec, ["checkout", "-q", "-f", "--detach", revision], at));
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  readonly capabilities: SandboxProviderCapabilities = {
    credentialBrokering: true,
    phasedEgress: true,
    isolatedFilesystem: true,
    reattachable: true,
    snapshots: false,
  };

  private readonly credentials: VercelSandboxProviderOptions;

  constructor(options: VercelSandboxProviderOptions) {
    this.credentials = options;
    this.capabilities.snapshots = options.environmentSnapshots === true;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    let snap: Snapshot;
    try {
      snap = await Snapshot.get({
        snapshotId,
        token: this.credentials.token,
        teamId: this.credentials.teamId,
        projectId: this.credentials.projectId,
      });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    try {
      await snap.delete();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async attach(options: SandboxAttachOptions): Promise<SandboxHandle> {
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.get({
        name: options.handleId,
        token: this.credentials.token,
        teamId: this.credentials.teamId,
        projectId: this.credentials.projectId,
      });
    } catch (err) {
      throw new SandboxGoneError(options.handleId, err);
    }
    if (!sandbox) throw new SandboxGoneError(options.handleId);
    return new VercelSandboxHandle(
      sandbox,
      options.role,
      await discoverCheckoutPath(sandbox, `reattaching ${options.handleId}`),
      [],
    );
  }

  async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
    const gitCredential = options.gitCredentials;
    const gitToken = gitCredential?.token ?? options.env?.SANDBOX_GIT_TOKEN;
    const gitUsername = gitCredential?.username ?? GIT_TOKEN_USERNAME;
    const env =
      options.role === "maker"
        ? { ...options.env, CODEX_API_KEY: CODEX_API_KEY_PLACEHOLDER }
        : options.env;
    if (options.fromSnapshot && !this.capabilities.snapshots) {
      throw new Error("sandbox: environment snapshots are not enabled on this provider (WINDKEEL_ENVIRONMENT_SNAPSHOTS)");
    }
    const common = {
      resources: { vcpus: 2 },
      timeout: options.timeoutMs ?? 300_000,
      name: sandboxName(options.role),
      persistent: true,
      ...(env ? { env } : {}),
      token: this.credentials.token,
      teamId: this.credentials.teamId,
      projectId: this.credentials.projectId,
    };
    const sandbox = options.fromSnapshot
      ? await Sandbox.create({ ...common, source: { type: "snapshot", snapshotId: options.fromSnapshot } })
      : await Sandbox.create({
      source: gitToken
        ? {
            type: "git",
            url: options.repoUrl,
            username: gitUsername,
            password: gitToken,
            ...(options.gitRevision ? { revision: options.gitRevision } : {}),
          }
        : {
            type: "git",
            url: options.repoUrl,
            ...(options.gitRevision ? { revision: options.gitRevision } : {}),
          },
      resources: { vcpus: 2 },
      timeout: options.timeoutMs ?? 300_000,
      name: sandboxName(options.role),
      persistent: true,
      ...(env ? { env } : {}),
      token: this.credentials.token,
      teamId: this.credentials.teamId,
      projectId: this.credentials.projectId,
    });
    const handle = new VercelSandboxHandle(
      sandbox,
      options.role,
      await discoverCheckoutPath(
        sandbox,
        options.fromSnapshot ? `restoring snapshot ${options.fromSnapshot}` : `cloning ${options.repoUrl}`,
      ),
    );

    await handle.updateNetworkPolicy(installPhasePolicy());

    if (options.fromSnapshot) {
      try {
        await checkoutFromRemote(handle, options);
      } catch (err) {
        await handle.destroy().catch(() => {});
        throw err;
      }
    }

    if (
      options.role === "maker" &&
      options.operatorModelKey !== false &&
      this.credentials.makerModelApiDomain &&
      this.credentials.makerModelKeyEnvVar
    ) {
      await handle.applyCredentialBrokerRules([
        makerModelKeyRule(this.credentials.makerModelApiDomain, this.credentials.makerModelKeyEnvVar),
      ]);
    }

    return handle;
  }
}
