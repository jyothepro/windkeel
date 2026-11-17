export const CANDIDATE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "CI",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

const ALLOWED_PREFIXES = ["LC_"];

export const CHECK_ENV_OPT_IN = "WINDKEEL_CHECK_ENV";

export const NEVER_PASSED: readonly string[] = [
  "ACTIONS_ID_TOKEN_REQUEST_*",
  "ACTIONS_RUNTIME_*",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "GITHUB_TOKEN",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "SIGSTORE_ID_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  CHECK_ENV_OPT_IN,
];

const nameKey = (name: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? name.toUpperCase() : name;

const matches = (name: string, pattern: string, platform: NodeJS.Platform): boolean => {
  const n = nameKey(name, platform);
  const p = nameKey(pattern, platform);
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
};

export const neverPassed = (name: string, platform: NodeJS.Platform = process.platform): boolean =>
  NEVER_PASSED.some((p) => matches(name, p, platform));

function lookup(source: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return source[name];
  const key = Object.keys(source).find((k) => nameKey(k, platform) === nameKey(name, platform));
  return key === undefined ? undefined : source[key];
}

export function optedInNames(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return (lookup(source, CHECK_ENV_OPT_IN, platform) ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && !neverPassed(n, platform));
}

export function candidateEnv(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set(CANDIDATE_ENV_ALLOWLIST.map((n) => nameKey(n, platform)));
  const optIn = new Set(optedInNames(source, platform).map((n) => nameKey(n, platform)));
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = nameKey(name, platform);
    if (
      allowed.has(key) ||
      ALLOWED_PREFIXES.some((p) => key.startsWith(nameKey(p, platform))) ||
      optIn.has(key)
    ) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides };
}
