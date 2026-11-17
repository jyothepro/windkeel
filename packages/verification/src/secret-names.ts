export const SECRET_KEY_SHAPE = /^[A-Z][A-Z0-9_]{0,62}$/;

export const RESERVED_SECRET_KEYS: ReadonlySet<string> = new Set([
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "VERCEL_TOKEN",
  "VERCEL_OIDC_TOKEN",
  "DATABASE_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "PATH",
  "HOME",
  "SHELL",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "BASH_ENV",
]);

export const RESERVED_SECRET_PREFIX = "WINDKEEL_";
const LEGACY_RESERVED_SECRET_PREFIX = "ORQON_";

export function secretKeyProblem(key: string): string | null {
  if (!SECRET_KEY_SHAPE.test(key)) {
    return (
      "an environment variable name is expected: upper case, digits and underscores, starting " +
      "with a letter, at most 63 characters"
    );
  }
  if (key.startsWith(RESERVED_SECRET_PREFIX) || key.startsWith(LEGACY_RESERVED_SECRET_PREFIX)) {
    return `the ${key.startsWith(RESERVED_SECRET_PREFIX) ? RESERVED_SECRET_PREFIX : LEGACY_RESERVED_SECRET_PREFIX} prefix is the factory's own configuration and is reserved`;
  }
  if (RESERVED_SECRET_KEYS.has(key)) {
    return (
      "it would shadow a credential the factory brokers or an interpreter's own configuration " +
      "(ADR-0014 §1 and §5)"
    );
  }
  return null;
}
