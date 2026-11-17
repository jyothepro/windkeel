import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import type { ProcessControl, ProcessSnapshot, ProcInfo, WorkspaceExec } from "../factory/human-push.js";
import { installDependencies, type DependencyInstall } from "./dependencies.js";
import { scrubCloneCredentials } from "./git-credentials.js";
import { HARDENED_GIT_ARGS, HARDENED_GIT_ENV, hardenedGit } from "./git-hardening.js";
import { installPhasePolicy } from "./network-phase.js";
import { SandboxGoneError, type NetworkPolicy, type ProcessSweep, type SandboxGitCredential, type SandboxHandle, type SandboxUsage } from "./provider.js";

export const HUMAN_WORKSPACE_PORT = 3000;
export const HUMAN_WORKSPACE_IDLE_SLEEP_MS = 30 * 60_000;
export const HUMAN_WORKSPACE_MAX_LIFETIME_MS = 24 * 60 * 60_000;
export const HUMAN_INSTALL_NOTE = "Installed without repository secrets — private dependencies may be missing.";

export const WORKSPACE_TOKEN_TTL_MS = 8 * 60 * 60_000;

export function mintWorkspaceToken(): { token: string; tokenSha256: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenSha256: createHash("sha256").update(token).digest("hex") };
}

export interface HumanWorkspaceHandle extends WorkspaceExec {
  readonly name: string;
  readonly checkoutPath: string;
  readonly personUids: number[];
  readonly processes: ProcessControl;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<void>;
  startServer(options: { tokenSha256: string; expiresAt: Date }): Promise<{ origin: string }>;
  stopServer(): Promise<void>;
  usage(): Promise<SandboxUsage>;
  sleep(): Promise<void>;
  destroy(): Promise<void>;
}

export interface HumanWorkspaceCreateOptions {
  repoUrl: string;
  baseSha: string;
  gitCredentials?: SandboxGitCredential | undefined;
  timeoutMs: number;
}

export interface HumanWorkspaceProvider {
  readonly name: string;
  create(options: HumanWorkspaceCreateOptions): Promise<HumanWorkspaceHandle>;
  attach(name: string, options?: { resume?: boolean }): Promise<HumanWorkspaceHandle>;
}

export interface ProvisionHumanWorkspaceInput {
  provider: HumanWorkspaceProvider;
  repoUrl: string;
  baseSha: string;
  seedSha: string;
  readCredential?: (() => Promise<SandboxGitCredential>) | undefined;
  gitHost: string;
  timeoutMs?: number;
}

export interface ProvisionedHumanWorkspace {
  handle: HumanWorkspaceHandle;
  baseline: ProcInfo[];
  install: DependencyInstall;
  installNote: string;
}

class HumanWorkspaceError extends Error {
  override readonly name = "HumanWorkspaceError";
}

export async function provisionHumanWorkspace(input: ProvisionHumanWorkspaceInput): Promise<ProvisionedHumanWorkspace> {
  if (!/^[0-9a-f]{40}$/.test(input.seedSha)) throw new HumanWorkspaceError("seed is not a full sha");
  const credential = input.readCredential ? await input.readCredential() : undefined;
  const handle = await input.provider.create({
    repoUrl: input.repoUrl,
    baseSha: input.baseSha,
    gitCredentials: credential,
    timeoutMs: input.timeoutMs ?? HUMAN_WORKSPACE_MAX_LIFETIME_MS,
  });
  try {
    if (credential) await scrubCloneCredentials(handle as unknown as SandboxHandle, credential.token);
    await handle.updateNetworkPolicy(installPhasePolicy());
    await fetchSeed(handle, input, credential);
    const install = await installDependencies(handle as unknown as SandboxHandle, {
      secrets: {},
      unopenableSecrets: [],
      candidateTree: true,
      trustedBase: input.baseSha,
    });
    const swept = await handle.processes.sweep();
    if (!swept.ensured) {
      throw new HumanWorkspaceError(`the install's processes could not be stopped before hand-off: ${swept.reason}`);
    }
    await handle.updateNetworkPolicy(installPhasePolicy());
    const snapshot = await handle.processes.snapshot();
    const own = new Set(handle.personUids);
    const self = new Set(snapshot.self);
    return {
      handle,
      baseline: snapshot.processes.filter((p) => !own.has(p.uid) && !self.has(p.pid)),
      install,
      installNote: HUMAN_INSTALL_NOTE,
    };
  } catch (error) {
    await handle.destroy().catch(() => undefined);
    throw error;
  }
}

async function fetchSeed(
  handle: HumanWorkspaceHandle,
  input: ProvisionHumanWorkspaceInput,
  credential: SandboxGitCredential | undefined,
): Promise<void> {
  const git = (args: string[], extraConfig: string[] = []) =>
    hardenedGit(handle.exec.bind(handle), args, { cwd: handle.checkoutPath, extraConfig, env: { GIT_NO_REPLACE_OBJECTS: "1" } });
  let dir: string | null = null;
  try {
    const extra: string[] = [];
    if (credential) {
      dir = await handle.mkdtemp("windkeel-read-");
      const file = `${dir}/read-credential`;
      const host = safeHost(input.repoUrl) ?? input.gitHost;
      await handle.writeFile(file, `https://${credential.username}:${credential.token}@${host}\n`);
      const chmod = await handle.exec("chmod", { args: ["600", file] });
      if (chmod.error || chmod.status !== 0) throw new HumanWorkspaceError("could not protect the read credential file");
      extra.push(`credential.helper=store --file ${file}`);
    }
    const fetched = await git(["fetch", "-q", "--no-tags", input.repoUrl, input.seedSha], extra);
    if (fetched.error || fetched.status !== 0) {
      throw new HumanWorkspaceError(`could not fetch the seed candidate ${input.seedSha}: ${redact(fetched.stderr, credential).trim()}`);
    }
  } finally {
    if (dir) {
      await handle.exec("rm", { args: ["-rf", dir] });
      if (await handle.exists(dir)) throw new HumanWorkspaceError("could not confirm the read credential was removed");
    }
  }
  const checkout = await git(["checkout", "-q", "--detach", input.seedSha]);
  if (checkout.error || checkout.status !== 0) throw new HumanWorkspaceError(`could not check out the seed: ${checkout.stderr.trim()}`);
  const head = await git(["rev-parse", "HEAD"]);
  if (head.stdout.trim() !== input.seedSha) throw new HumanWorkspaceError("the workspace is not at the seed candidate");
  await git(["remote", "set-url", "origin", input.repoUrl]);
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function redact(text: string, credential: SandboxGitCredential | undefined): string {
  return credential?.token ? text.split(credential.token).join("***") : text;
}

export interface FakeHumanWorkspaceOptions {
  survivors?: ProcInfo[];
  sweepFails?: boolean;
  persistCloneCredential?: boolean;
}

class FakeHumanWorkspaceHandle implements HumanWorkspaceHandle {
  readonly personUids = [1001];
  readonly execs: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  readonly writes: string[] = [];
  readonly policies: NetworkPolicy[] = [];
  readonly events: string[] = [];
  server: { tokenSha256: string; expiresAt: Date } | null = null;
  asleep = false;
  destroyed = false;
  readonly processes: ProcessControl;

  constructor(
    readonly name: string,
    readonly root: string,
    readonly checkoutPath: string,
    private readonly options: FakeHumanWorkspaceOptions,
  ) {
    this.processes = {
      sweep: async (): Promise<ProcessSweep> => {
        this.events.push("sweep");
        if (this.options.sweepFails) return { ensured: false, reason: "fake: the sweep could not confirm" };
        this.server = null;
        return { ensured: true, killed: 0 };
      },
      snapshot: async (): Promise<ProcessSnapshot> => {
        this.events.push("snapshot");
        return { self: [], processes: [...(this.options.survivors ?? [])] };
      },
    };
  }

  setSurvivors(survivors: ProcInfo[]): void {
    this.options.survivors = survivors;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();
    this.execs.push({ command, args: options.args ?? [], env: { ...(options.env ?? {}) } });
    const result = options.args
      ? spawnSync(command, options.args, { cwd: options.cwd ?? this.checkoutPath, encoding: "utf8", env: { ...process.env, ...options.env } })
      : spawnSync(command, { cwd: options.cwd ?? this.checkoutPath, encoding: "utf8", shell: true, env: { ...process.env, ...options.env } });
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
    this.writes.push(this.resolve(path));
    writeFileSync(this.resolve(path), data);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }

  async mkdtemp(prefix: string): Promise<string> {
    const tmp = join(this.root, "tmp");
    mkdirSync(tmp, { recursive: true });
    return mkdtempSync(join(tmp, prefix));
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    this.policies.push(policy);
  }

  async startServer(options: { tokenSha256: string; expiresAt: Date }): Promise<{ origin: string }> {
    this.assertAlive();
    this.asleep = false;
    this.server = { ...options };
    this.events.push("server-started");
    return { origin: `https://${this.name}.fake.vercel.run` };
  }

  async stopServer(): Promise<void> {
    this.server = null;
    this.events.push("server-stopped");
  }

  async usage(): Promise<SandboxUsage> {
    return { activeCpuMs: 1_000, wallClockMs: 1_000, networkEgressBytes: 0 };
  }

  async sleep(): Promise<void> {
    this.server = null;
    this.asleep = true;
    this.events.push("slept");
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.push("destroyed");
  }

  allFiles(): string[] {
    const walk = (d: string): string[] =>
      existsSync(d)
        ? readdirSync(d).flatMap((name) => {
            const p = join(d, name);
            return statSync(p).isDirectory() ? walk(p) : [p];
          })
        : [];
    return walk(this.root);
  }

  contains(secret: string, fromExec = 0): { files: string[]; envs: number[] } {
    const files = this.allFiles().filter((f) => readFileSync(f).includes(secret));
    const envs = this.execs
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => i >= fromExec && Object.values(e.env).some((v) => v.includes(secret)))
      .map(({ i }) => i);
    return { files, envs };
  }

  private assertAlive(): void {
    if (this.destroyed) throw new SandboxGoneError(this.name);
  }

  private resolve(path: string): string {
    return path.startsWith("/") ? path : join(this.checkoutPath, path);
  }
}

export class FakeHumanWorkspaceProvider implements HumanWorkspaceProvider {
  readonly name = "fake-human";
  readonly created: FakeHumanWorkspaceHandle[] = [];
  readonly createOptions: HumanWorkspaceCreateOptions[] = [];
  private counter = 0;

  constructor(private readonly options: FakeHumanWorkspaceOptions = {}) {}

  async create(options: HumanWorkspaceCreateOptions): Promise<HumanWorkspaceHandle> {
    this.createOptions.push(options);
    const root = mkdtempSync(join(tmpdir(), "windkeel-human-ws-"));
    const checkout = join(root, "repo");
    const source = options.repoUrl.startsWith("/") ? options.repoUrl : options.repoUrl.replace(/^file:\/\//, "");
    const clone = spawnSync("git", [...HARDENED_GIT_ARGS, "clone", "-q", source, checkout], {
      encoding: "utf8",
      env: { ...process.env, ...HARDENED_GIT_ENV },
    });
    if (clone.status !== 0) throw new Error(`fake human workspace: clone failed: ${clone.stderr}`);
    const at = spawnSync("git", [...HARDENED_GIT_ARGS, "checkout", "-q", "--detach", options.baseSha], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, ...HARDENED_GIT_ENV },
    });
    if (at.status !== 0) throw new Error(`fake human workspace: base checkout failed: ${at.stderr}`);
    const credential = options.gitCredentials;
    if (this.options.persistCloneCredential && credential) {
      const config = (...args: string[]) =>
        spawnSync("git", [...HARDENED_GIT_ARGS, ...args], { cwd: checkout, encoding: "utf8", env: { ...process.env, ...HARDENED_GIT_ENV } });
      config("remote", "set-url", "origin", `https://${credential.username}:${credential.token}@github.com/acme/widgets.git`);
      config("config", "--local", "http.https://github.com/.extraheader", `AUTHORIZATION: bearer ${credential.token}`);
    }
    const handle = new FakeHumanWorkspaceHandle(`windkeel-human-fake-${++this.counter}`, root, checkout, { ...this.options });
    this.created.push(handle);
    return handle;
  }

  async attach(name: string, options: { resume?: boolean } = {}): Promise<HumanWorkspaceHandle> {
    const handle = this.created.find((h) => h.name === name);
    if (!handle || handle.destroyed) throw new SandboxGoneError(name);
    if (options.resume) {
      handle.asleep = false;
      handle.events.push("woke");
    }
    return handle;
  }

  cleanup(): void {
    for (const handle of this.created) rmSync(handle.root, { recursive: true, force: true });
  }
}

