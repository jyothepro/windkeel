import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import {
  SandboxGoneError,
  type SandboxAttachOptions,
} from "./provider.js";
import type {
  CredentialBrokerRule,
  NetworkPolicy,
  SandboxGitCredential,
  SandboxCreateOptions,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxRole,
  SandboxSnapshot,
  SandboxUsage,
  ProcessSweep,
} from "./provider.js";

export type SandboxCallRecord =
  | { type: "policy"; policy: NetworkPolicy }
  | { type: "credentialBroker"; rules: CredentialBrokerRule[] }
  | { type: "exec"; command: string; options?: ExecOptions }
  | { type: "terminateStrayProcesses" }
  | { type: "create"; fromSnapshot: string }
  | { type: "snapshot"; snapshotId: string; expirationMs: number };

class FakeSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly role: SandboxRole;
  readonly root: string;
  readonly gitCredential: SandboxGitCredential | undefined;
  get checkoutPath(): string {
    return this.root;
  }
  readonly calls: SandboxCallRecord[] = [];
  private destroyed = false;
  private readonly createdAt = Date.now();
  private destroyedAt: number | null = null;

  constructor(
    id: string,
    role: SandboxRole,
    root: string,
    gitCredential?: SandboxGitCredential | undefined,
  ) {
    this.id = id;
    this.role = role;
    this.root = root;
    this.gitCredential = gitCredential;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ type: "exec", command, options });
    const spawnOptions = {
      cwd: options.cwd ?? this.root,
      encoding: "utf8" as const,
      maxBuffer: options.maxBuffer ?? Infinity,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    };
    const result = options.args
      ? spawnSync(command, options.args, spawnOptions)
      : spawnSync(command, { ...spawnOptions, shell: true });
    return {
      status: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error.message } : {}),
    };
  }

  async readFile(path: string): Promise<Buffer> {
    return readFileSync(this.resolve(path));
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    writeFileSync(this.resolve(path), data);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }

  async listFiles(dir: string): Promise<Array<{ path: string; bytes: number }>> {
    const absDir = this.resolve(dir);
    if (!existsSync(absDir)) return [];
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((name) => {
        const p = join(d, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    return walk(absDir).map((absolute) => ({
      path: relative(absDir, absolute).split(sep).join("/"),
      bytes: statSync(absolute).size,
    }));
  }

  async mkdtemp(prefix: string): Promise<string> {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    this.calls.push({ type: "policy", policy });
  }

  async applyCredentialBrokerRules(rules: CredentialBrokerRule[]): Promise<void> {
    this.calls.push({ type: "credentialBroker", rules });
    for (const rule of rules) {
      if (rule.resolveSecret) await rule.resolveSecret();
    }
  }

  async terminateStrayProcesses(): Promise<ProcessSweep> {
    this.calls.push({ type: "terminateStrayProcesses" });
    return {
      ensured: false,
      noSandbox: true,
      reason: "FakeSandboxProvider runs on the host; it cannot stop every other process without stopping the developer's",
    };
  }

  async usage(): Promise<SandboxUsage> {
    const ran = (this.destroyedAt ?? Date.now()) - this.createdAt;
    return { activeCpuMs: ran, wallClockMs: ran, networkEgressBytes: 0 };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyedAt = Date.now();
    rmSync(this.root, { recursive: true, force: true });
  }

  async snapshot(options: { expirationMs: number }): Promise<SandboxSnapshot> {
    if (this.destroyed) throw new Error(`FakeSandboxProvider: ${this.id} is gone and cannot be snapshotted`);
    const snapshotId = `fakesnap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.calls.push({ type: "snapshot", snapshotId, expirationMs: options.expirationMs });
    const dir = snapshotDirFor(snapshotId);
    mkdirSync(dir, { recursive: true });
    cpSync(this.root, dir, { recursive: true, verbatimSymlinks: true });
    const sizeBytes = directoryBytes(dir);
    await this.destroy();
    return { snapshotId, sizeBytes };
  }

  private resolve(path: string): string {
    return path.startsWith(sep) || path.startsWith("/") ? path : join(this.root, path);
  }
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = "fake";
  readonly capabilities: SandboxProviderCapabilities = {
    credentialBrokering: false,
    phasedEgress: false,
    isolatedFilesystem: false,
    reattachable: true,
    snapshots: true,
  };

  async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
    const id = `fake-${options.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const root = rootFor(id);
    if (options.fromSnapshot) return this.restore(id, root, options.fromSnapshot, options);
    mkdirSync(root, { recursive: true });
    const readOnly = options.gitCredentials?.permission === "read";
    const origin = readOnly ? readOnlyMirrorOf(options.repoUrl) : options.repoUrl;
    const cloneResult = spawnSync("git", ["clone", "-q", origin, root], {
      encoding: "utf8",
      cwd: tmpdir(),
    });
    if (cloneResult.status !== 0) {
      throw new Error(
        `FakeSandboxProvider: git clone failed for ${options.repoUrl}: ${cloneResult.stderr}`,
      );
    }
    if (options.gitRevision) {
      const checkoutResult = spawnSync("git", ["checkout", "-q", options.gitRevision], {
        encoding: "utf8",
        cwd: root,
      });
      if (checkoutResult.status !== 0) {
        throw new Error(
          `FakeSandboxProvider: git checkout ${options.gitRevision} failed: ${checkoutResult.stderr}`,
        );
      }
    }
    return new FakeSandboxHandle(id, options.role, root, options.gitCredentials);
  }

  private async restore(
    id: string,
    root: string,
    snapshotId: string,
    options: SandboxCreateOptions,
  ): Promise<SandboxHandle> {
    const source = snapshotDirFor(snapshotId);
    if (!existsSync(source)) throw new Error(`FakeSandboxProvider: no snapshot ${snapshotId}`);
    mkdirSync(root, { recursive: true });
    cpSync(source, root, { recursive: true, verbatimSymlinks: true });
    const readOnly = options.gitCredentials?.permission === "read";
    const origin = readOnly ? readOnlyMirrorOf(options.repoUrl) : options.repoUrl;
    const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8", cwd: root });
    const must = (what: string, result: ReturnType<typeof git>) => {
      if (result.status !== 0) {
        rmSync(root, { recursive: true, force: true });
        throw new Error(`FakeSandboxProvider: restoring ${snapshotId}: ${what} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    must("set origin", git("remote", "set-url", "origin", origin));
    must("fetch", git("fetch", "-q", "--prune", "origin"));
    const revision = options.gitRevision ?? "HEAD";
    const remoteRef =
      revision === "HEAD"
        ? git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.trim()
        : git("rev-parse", "--verify", "-q", `refs/remotes/origin/${revision}`).status === 0
          ? `origin/${revision}`
          : "";
    if (remoteRef) {
      const branch = remoteRef.replace(/^origin\//, "");
      must(`check out ${remoteRef}`, git("checkout", "-q", "-f", "-B", branch, remoteRef));
    } else {
      must(`check out ${revision}`, git("checkout", "-q", "-f", "--detach", revision));
    }
    const handle = new FakeSandboxHandle(id, options.role, root, options.gitCredentials);
    handle.calls.push({ type: "create", fromSnapshot: snapshotId });
    return handle;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    rmSync(snapshotDirFor(snapshotId), { recursive: true, force: true });
  }

  async attach(options: SandboxAttachOptions): Promise<SandboxHandle> {
    const root = rootFor(options.handleId);
    if (!existsSync(root)) throw new SandboxGoneError(options.handleId);
    return new FakeSandboxHandle(options.handleId, options.role, root, undefined);
  }
}

function rootFor(id: string): string {
  return join(tmpdir(), `windkeel-fake-sandbox-${id}`);
}

export function snapshotDirFor(snapshotId: string): string {
  if (!/^fakesnap-[0-9a-z-]+$/.test(snapshotId)) throw new Error(`FakeSandboxProvider: not a snapshot id: ${snapshotId}`);
  return join(tmpdir(), "windkeel-fake-snapshots", snapshotId);
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    total += stat.isDirectory() ? directoryBytes(path) : stat.size;
  }
  return total;
}

function readOnlyMirrorOf(source: string): string {
  const mirror = mkdtempSync(join(tmpdir(), "windkeel-fake-readonly-remote-"));
  const cloned = spawnSync("git", ["clone", "-q", "--bare", source, mirror], {
    encoding: "utf8",
    cwd: tmpdir(),
  });
  if (cloned.status !== 0) {
    throw new Error(`FakeSandboxProvider: read-only mirror of ${source} failed: ${cloned.stderr}`);
  }
  const hook = join(mirror, "hooks", "pre-receive");
  writeFileSync(
    hook,
    "#!/bin/sh\n" +
      "echo 'remote: Permission to repository denied: the credential is contents:read " +
      "(ADR-0014 §2)' >&2\n" +
      "exit 1\n",
  );
  chmodSync(hook, 0o755);
  return mirror;
}
