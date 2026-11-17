import type { ExecutionEnvironment } from "@windkeel/verification/exec/environment.js";

export type SandboxRole = "maker" | "verifier";

export interface NetworkPolicy {
  mode: "allow-all" | "deny-all" | "allowlist";
  allowedDomains?: string[];
}

export type CredentialBrokerRule =
  | { domain: string; header: string; secretEnvVar: string; resolveSecret?: undefined; label?: string }
  | {
      domain: string;
      header: string;
      resolveSecret: () => Promise<string>;
      secretEnvVar?: undefined;
      label?: string;
    };

export interface SandboxGitCredential {
  username: string;
  token: string;
  permission: "read" | "write";
  expiresAt: string;
}

export interface SandboxCreateOptions {
  role: SandboxRole;
  repoUrl: string;
  gitRevision?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  gitCredentials?: SandboxGitCredential;
  operatorModelKey?: boolean;
  fromSnapshot?: string;
}

export interface SandboxSnapshot {
  snapshotId: string;
  sizeBytes?: number;
}

export interface SandboxUsage {
  activeCpuMs: number;
  wallClockMs: number;
  networkEgressBytes: number;
}

export interface SandboxHandle extends ExecutionEnvironment {
  readonly id: string;
  readonly role: SandboxRole;
  readonly checkoutPath: string;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<void>;
  applyCredentialBrokerRules(rules: CredentialBrokerRule[]): Promise<void>;
  terminateStrayProcesses(): Promise<ProcessSweep>;
  usage(): Promise<SandboxUsage>;
  destroy(): Promise<void>;
  snapshot?(options: { expirationMs: number }): Promise<SandboxSnapshot>;
}

export type ProcessSweep =
  | {
      ensured: true;
      killed: number;
    }
  | {
      ensured: false;
      reason: string;
      noSandbox?: true;
    };

export interface SandboxProviderCapabilities {
  credentialBrokering: boolean;
  phasedEgress: boolean;
  reattachable: boolean;
  isolatedFilesystem: boolean;
  snapshots?: boolean;
}

export class SandboxNotReattachableError extends Error {
  constructor(providerName: string) {
    super(`sandbox: the "${providerName}" provider cannot reattach (capabilities.reattachable is false)`);
    this.name = "SandboxNotReattachableError";
  }
}

export class SandboxGoneError extends Error {
  constructor(handleId: string, cause?: unknown) {
    super(
      `sandbox: no sandbox named ${handleId} — it expired, was destroyed, or never existed`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "SandboxGoneError";
  }
}

export interface SandboxAttachOptions {
  role: SandboxRole;
  handleId: string;
}

export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxProviderCapabilities;
  create(options: SandboxCreateOptions): Promise<SandboxHandle>;
  attach(options: SandboxAttachOptions): Promise<SandboxHandle>;
  deleteSnapshot?(snapshotId: string): Promise<void>;
}
