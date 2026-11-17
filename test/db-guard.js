/**
 * Tests create, migrate and drop whole databases on the server `TEST_DATABASE_URL` names. Pointed
 * at `.env`'s `DATABASE_URL`, that server can be production (a Supabase shared with other
 * products). So a test database must be local, unless someone opts in by name for a throwaway
 * remote server. helpers.js imports this first, and every DB test reaches helpers.js.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export const REMOTE_OPT_IN = "WINDKEEL_TEST_DB_ALLOW_REMOTE";

/** Returns why `env` is unsafe for tests, or null when it is fine (or no test DB is set). */
export function unsafeTestDatabase(env) {
  const raw = env.TEST_DATABASE_URL;
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "TEST_DATABASE_URL is not a URL";
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return "TEST_DATABASE_URL is not a postgres:// URL";
  const hosts = url.searchParams.getAll("host");
  if (hosts.length > 1) return "TEST_DATABASE_URL has multiple host parameters";
  let host;
  try {
    host = hosts[0] || decodeURIComponent(url.hostname) || env.PGHOST || "localhost";
  } catch {
    return "TEST_DATABASE_URL has an invalid encoded hostname";
  }
  if (LOCAL_HOSTS.has(host) || host.startsWith("/")) return null;
  if (env[REMOTE_OPT_IN] === "1") return null;
  return (
    `TEST_DATABASE_URL points at ${host}, not a local server. Tests create and drop ` +
    `databases there. Use a local Postgres (AGENTS.md, "Local test DB"), or set ` +
    `${REMOTE_OPT_IN}=1 for a throwaway remote server. Never point tests at .env's DATABASE_URL.`
  );
}

const reason = unsafeTestDatabase(process.env);
if (reason) throw new Error(reason);
