import type { InstallationPermissions, InstallationToken, RepositoryRef } from "../github/client.js";
import type { SandboxGitCredential, SandboxHandle, SandboxRole } from "./provider.js";

export const ROLE_PERMISSIONS: Record<SandboxRole, InstallationPermissions> = {
  maker: { contents: "write" },
  verifier: { contents: "read" },
};

const REMINT_MARGIN_MS = 5 * 60 * 1000;

export type { SandboxGitCredential } from "./provider.js";

const GIT_TOKEN_USERNAME = "x-access-token";

export interface GitCredentialMinter {
  mintInstallationToken(input: {
    repository: RepositoryRef;
    permissions: InstallationPermissions;
  }): Promise<InstallationToken>;
}

export interface SandboxGitCredentialsOptions {
  now?: () => number;
  marginMs?: number;
}

export class SandboxGitCredentials {
  private readonly cache = new Map<string, SandboxGitCredential>();
  private readonly now: () => number;
  private readonly marginMs: number;

  constructor(
    private readonly github: GitCredentialMinter,
    options: SandboxGitCredentialsOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.marginMs = options.marginMs ?? REMINT_MARGIN_MS;
  }

  async forWorkspace(
    workspaceId: string,
    role: SandboxRole,
    repository: RepositoryRef,
  ): Promise<SandboxGitCredential> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.parse(cached.expiresAt) - this.marginMs > this.now()) return cached;

    const permissions = ROLE_PERMISSIONS[role];
    const minted = await this.github.mintInstallationToken({ repository, permissions });
    const credential: SandboxGitCredential = {
      username: GIT_TOKEN_USERNAME,
      token: minted.token,
      permission: minted.permissions.contents === "write" ? "write" : "read",
      expiresAt: minted.expiresAt,
    };
    this.cache.set(workspaceId, credential);
    return credential;
  }

  release(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  get size(): number {
    return this.cache.size;
  }
}

const CREDENTIAL_FILE = "windkeel-git-credentials";

const scratchDirs = new WeakMap<SandboxHandle, Promise<string>>();

async function credentialPath(handle: SandboxHandle): Promise<string> {
  let dir = scratchDirs.get(handle);
  if (!dir) {
    dir = handle.mkdtemp("windkeel-git-");
    scratchDirs.set(handle, dir);
  }
  return `${await dir}/${CREDENTIAL_FILE}`;
}

export async function installGitCredential(
  handle: SandboxHandle,
  host: string,
  credential: SandboxGitCredential,
): Promise<string> {
  const path = await credentialPath(handle);
  const line = `https://${credential.username}:${credential.token}@${host}\n`;
  await handle.writeFile(path, line);
  await handle.exec("chmod", { args: ["600", path] });
  return path;
}

export async function removeGitCredential(handle: SandboxHandle): Promise<void> {
  const dir = scratchDirs.get(handle);
  if (!dir) return;
  const path = `${await dir}/${CREDENTIAL_FILE}`;
  const removed = await handle.exec("rm", { args: ["-f", path] });
  if (removed.error || removed.status !== 0 || (await handle.exists(path))) {
    throw new Error(
      `could not confirm the git credential file was removed from the sandbox ` +
        `(${removed.error ?? `rm exited ${removed.status}`}${removed.stderr.trim() ? `: ${removed.stderr.trim()}` : ""}); ` +
        "the sandbox must not be reused with a live token in it",
    );
  }
}

export class CloneCredentialScrubError extends Error {
  constructor(message: string) {
    super(`provisioning: ${message}`);
    this.name = "CloneCredentialScrubError";
  }
}

export async function scrubCloneCredentials(handle: SandboxHandle, token?: string): Promise<void> {
  const remotes = must(await handle.exec("git", { args: ["remote"] }), "list the checkout's remotes");
  for (const remote of remotes.stdout.split("\n").map((r) => r.trim()).filter(Boolean)) {
    const url = must(
      await handle.exec("git", { args: ["remote", "get-url", "--all", remote] }),
      `read remote ${remote}'s URL`,
    ).stdout.trim();
    for (const line of url.split("\n").map((u) => u.trim()).filter(Boolean)) {
      const stripped = stripUserinfo(line);
      if (stripped === line) continue;
      must(
        await handle.exec("git", { args: ["remote", "set-url", remote, stripped] }),
        `strip the credential from remote ${remote}`,
      );
    }
  }
  const headers = await handle.exec("git", {
    args: ["config", "--local", "--name-only", "--get-regexp", "^http\\..*extraheader$"],
  });
  if (headers.status !== 0 && headers.status !== 1) must(headers, "look for http extraheaders");
  const keys = headers.status === 0 ? headers.stdout.split("\n").map((k) => k.trim()).filter(Boolean) : [];
  for (const key of new Set(keys)) {
    must(await handle.exec("git", { args: ["config", "--local", "--unset-all", key] }), `unset ${key}`);
  }

  const helpers = await handle.exec("git", { args: ["config", "--local", "--get-regexp", "^credential\\."] });
  if (helpers.status !== 0 && helpers.status !== 1) must(helpers, "look for credential helpers");
  const helperLines = helpers.status === 0 ? helpers.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const helperValues = helperLines.map((line) => line.slice(line.indexOf(" ") + 1));
  for (const file of new Set(helperValues.flatMap(storeFilesOf))) {
    must(await handle.exec("rm", { args: ["-f", "--", file] }), `remove the credential store ${file}`);
  }
  if (helperValues.some(usesDefaultStore)) {
    must(
      await handle.exec("sh", {
        args: ["-c", 'rm -f -- "$HOME/.git-credentials" "${XDG_CONFIG_HOME:-$HOME/.config}/git/credentials"'],
      }),
      "remove the default credential stores",
    );
  }
  for (const key of new Set(helperLines.map((line) => line.split(" ")[0] as string))) {
    must(await handle.exec("git", { args: ["config", "--local", "--unset-all", key] }), `unset ${key}`);
  }

  for (const remote of remotes.stdout.split("\n").map((r) => r.trim()).filter(Boolean)) {
    const url = must(
      await handle.exec("git", { args: ["remote", "get-url", "--all", remote] }),
      `re-read remote ${remote}'s URL`,
    ).stdout;
    if (url.split("\n").some((line) => stripUserinfo(line.trim()) !== line.trim())) {
      throw new CloneCredentialScrubError(`remote ${remote} still carries a credential after scrubbing`);
    }
  }
  const after = await handle.exec("git", {
    args: ["config", "--local", "--name-only", "--get-regexp", "^http\\..*extraheader$"],
  });
  if (after.status !== 1) {
    throw new CloneCredentialScrubError(
      after.status === 0
        ? "an http extraheader is still configured after scrubbing"
        : `could not confirm no http extraheader remains (exit ${after.status})`,
    );
  }
  const helpersAfter = await handle.exec("git", {
    args: ["config", "--local", "--name-only", "--get-regexp", "^credential\\."],
  });
  if (helpersAfter.status !== 1) {
    throw new CloneCredentialScrubError(
      helpersAfter.status === 0
        ? `a credential helper is still configured after scrubbing (${helpersAfter.stdout.trim().split("\n").join(", ")})`
        : `could not confirm no credential helper remains (exit ${helpersAfter.status})`,
    );
  }
  if (token) {
    const found = await handle.exec("sh", {
      args: ["-c", 'grep -rlF -e "$WINDKEEL_CLONE_TOKEN" .git'],
      env: { WINDKEEL_CLONE_TOKEN: token },
    });
    if (found.status !== 1) {
      throw new CloneCredentialScrubError(
        found.status === 0
          ? `the clone token is still present in ${found.stdout.trim().split("\n").join(", ")}`
          : `could not search the checkout's .git for the clone token (exit ${found.status ?? found.error})`,
      );
    }
  }
}

function must(
  result: { status: number | null; error?: string; stderr: string; stdout: string },
  what: string,
): { stdout: string } {
  if (result.error || result.status !== 0) {
    throw new CloneCredentialScrubError(
      `could not ${what} while scrubbing the clone credential ` +
        `(${result.error ?? `exit ${result.status}`}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""})`,
    );
  }
  return result;
}

export function stripUserinfo(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
}

export function storeFilesOf(helper: string): string[] {
  const words = helper.trim().split(/\s+/);
  if (words[0] !== "store" && words[0] !== "git-credential-store") return [];
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    if (word === "--file" && words[i + 1]) files.push(words[++i] as string);
    else if (word.startsWith("--file=")) files.push(word.slice("--file=".length));
  }
  return files;
}

export function usesDefaultStore(helper: string): boolean {
  const words = helper.trim().split(/\s+/);
  return (words[0] === "store" || words[0] === "git-credential-store") && storeFilesOf(helper).length === 0;
}
