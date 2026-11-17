import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";

export const HARDENED_GIT_ARGS: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.sshCommand=false",
  "-c", "core.pager=cat",
  "-c", "core.askPass=",
  "-c", "credential.helper=",
  "-c", "credential.useHttpPath=false",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "push.gpgSign=false",
  "-c", "push.recurseSubmodules=no",
  "-c", "submodule.recurse=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=always",
  "-c", "safe.directory=*",
];

export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

const ALLOWED_KEYS: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol|checkstat|trustctime|quotepath|abbrev|compression|loosecompression|bigfilethreshold|preloadindex|untrackedcache|splitindex|commitgraph|multipackindex|sparsecheckout|sparsecheckoutcone|longpaths|protecthfs|protectntfs|warnambiguousrefs)$/,
  /^extensions\.(objectformat|refstorage)$/,
  /^remote\.[^\n]+\.(url|fetch|tagopt|prune|mirror)$/,
  /^branch\.[^\n]+\.(remote|merge|rebase)$/,
  /^user\.(name|email)$/,
  /^(advice|color)\.[^\n]+$/,
  /^init\.defaultbranch$/,
  /^pull\.(rebase|ff)$/,
  /^fetch\.prune$/,
  /^gc\.auto$/,
];

class UnsafeGitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGitConfigError";
  }
}

export type GitExec = (command: string, options?: ExecOptions) => Promise<ExecResult>;

export function hardenedGit(
  exec: GitExec,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; extraConfig?: readonly string[] } = {},
): Promise<ExecResult> {
  const extra = (options.extraConfig ?? []).flatMap((entry) => ["-c", entry]);
  return exec("git", {
    args: [...HARDENED_GIT_ARGS, ...extra, ...args],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: { ...HARDENED_GIT_ENV, ...options.env },
  });
}

export async function assertSafeGitConfig(exec: GitExec, cwd?: string): Promise<void> {
  const at = cwd !== undefined ? { cwd } : {};
  const layout = await hardenedGit(
    exec,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    at,
  );
  const [toplevel, gitDir, commonDir] = layout.stdout.trim().split("\n").map((line) => line.trim());
  if (layout.status !== 0 || !toplevel || !gitDir || !commonDir) {
    throw new UnsafeGitConfigError(
      `could not establish the checkout's git layout (${layout.error ?? `exit ${layout.status}`}` +
        `${layout.stderr.trim() ? `: ${layout.stderr.trim()}` : ""})`,
    );
  }
  const expected = `${toplevel}/.git`;
  if (gitDir !== expected || commonDir !== expected) {
    throw new UnsafeGitConfigError(
      `the checkout's git directory is not its own: expected ${expected}, git resolved ` +
        `--git-dir=${gitDir} --git-common-dir=${commonDir}. A redirected .git means configuration ` +
        "this check cannot see would be in effect.",
    );
  }

  const legacy = await exec("sh", {
    args: ["-c", 'find "$0/remotes" "$0/branches" -type f 2>/dev/null | head -n 1', commonDir],
  });
  if (legacy.error || legacy.stdout.trim()) {
    throw new UnsafeGitConfigError(
      `refusing to run git over this checkout: it defines a legacy remote (${legacy.stdout.trim() || legacy.error}), ` +
        "which could give a remote the same name as the push target",
    );
  }

  const listed = await hardenedGit(exec, ["config", "--file", `${commonDir}/config`, "--list", "--null"], at);
  if (listed.status !== 0) {
    throw new UnsafeGitConfigError(
      `could not read ${commonDir}/config (${listed.error ?? `exit ${listed.status}`}` +
        `${listed.stderr.trim() ? `: ${listed.stderr.trim()}` : ""})`,
    );
  }
  const refused = refusedKeys(listed.stdout);
  if (refused.length) {
    throw new UnsafeGitConfigError(
      `refusing to run git over this checkout: its .git/config sets ${refused.join(", ")}, ` +
        "which the capture does not allow. Keys like these make git run commands (hooks, " +
        "filters, helpers, pagers) or read configuration from elsewhere, and the capture is " +
        "about to hold a write token.",
    );
  }
}

export function refusedKeys(listNullOutput: string): string[] {
  const refused = new Set<string>();
  for (const entry of listNullOutput.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const key = (newline === -1 ? entry : entry.slice(0, newline)).trim();
    const normalized = normalizeKey(key);
    if (!ALLOWED_KEYS.some((pattern) => pattern.test(normalized))) refused.add(key);
    else if (isUrlShapedRemote(normalized)) refused.add(key);
  }
  return [...refused].sort();
}

function isUrlShapedRemote(normalizedKey: string): boolean {
  if (!normalizedKey.startsWith("remote.")) return false;
  const name = normalizedKey.slice("remote.".length, normalizedKey.lastIndexOf("."));
  return /[:/\\]/.test(name) || name === "." || name === "..";
}

function normalizeKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}
