export type InstallationVerdict =
  | { ok: true }
  | { ok: false; reason: "unreachable" | "not_owner"; detail: string };

export interface InstallationVerifier {
  verify(input: { installationId: number; code: string | undefined }): Promise<InstallationVerdict>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface GitHubInstallationVerifierOptions {
  clientId: string;
  clientSecret: string;
  webBase?: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
}

interface InstallationAccount {
  id?: unknown;
  login?: unknown;
  type?: unknown;
}

const unreachable = (detail: string): InstallationVerdict => ({ ok: false, reason: "unreachable", detail });
const notOwner = (detail: string): InstallationVerdict => ({ ok: false, reason: "not_owner", detail });

export function githubInstallationVerifier(options: GitHubInstallationVerifierOptions): InstallationVerifier {
  const webBase = (options.webBase ?? "https://github.com").replace(/\/+$/, "");
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    async verify({ installationId, code }) {
      if (!code) return unreachable("no authorization code");
      const exchanged = await fetchImpl(`${webBase}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret, code }),
      });
      const token = ((await exchanged.json().catch(() => ({}))) as { access_token?: unknown }).access_token;
      if (exchanged.status !== 200 || typeof token !== "string") return unreachable("the authorization code was refused");
      const get = (path: string) =>
        fetchImpl(`${apiBase}${path}`, {
          method: "GET",
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "windkeel" },
        });

      let account: InstallationAccount | null = null;
      for (let page = 1; page <= 10 && account === null; page++) {
        const listed = await get(`/user/installations?per_page=100&page=${page}`);
        if (listed.status !== 200) return unreachable("GitHub did not list the user's installations");
        const body = (await listed.json().catch(() => ({}))) as {
          installations?: Array<{ id?: unknown; account?: InstallationAccount | null }>;
        };
        const installations = body.installations ?? [];
        const found = installations.find((i) => i.id === installationId);
        if (found) account = found.account ?? {};
        else if (installations.length < 100) break;
      }
      if (account === null) return unreachable("the installation is not one the user can reach");

      if (account.type === "User") {
        const me = await get(`/user`);
        if (me.status !== 200) return notOwner("GitHub did not say who the user is");
        const user = (await me.json().catch(() => ({}))) as { id?: unknown };
        if (typeof user.id === "number" && user.id === account.id) return { ok: true };
        return notOwner("the installation is on another user's account");
      }
      if (account.type === "Organization" && typeof account.login === "string" && account.login) {
        const membership = await get(`/user/memberships/orgs/${encodeURIComponent(account.login)}`);
        if (membership.status !== 200) return notOwner("GitHub shows no membership of the installation's organization");
        const m = (await membership.json().catch(() => ({}))) as { state?: unknown; role?: unknown };
        if (m.state === "active" && m.role === "admin") return { ok: true };
        return notOwner("the user is not an admin of the installation's organization");
      }
      return notOwner("the installation's account is neither a user nor an organization");
    },
  };
}

export function fakeInstallationVerifier(
  grants: Record<string, number[]>,
  reachableOnly: Record<string, number[]> = {},
): InstallationVerifier {
  return {
    async verify({ installationId, code }) {
      if (code !== undefined && (grants[code] ?? []).includes(installationId)) return { ok: true };
      if (code !== undefined && (reachableOnly[code] ?? []).includes(installationId)) {
        return notOwner("the user can reach the installation but does not own its account");
      }
      return unreachable("the installation is not one the user can reach");
    },
  };
}
