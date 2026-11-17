const GITHUB = "https://github.com";

export function githubWebBase(apiBase: string | undefined | null): string {
  const raw = (apiBase ?? "").trim().replace(/\/+$/, "");
  if (raw === "") return GITHUB;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return GITHUB;
  }
  if (/^\/api\/v3$/.test(url.pathname)) return url.origin;
  if (url.hostname.startsWith("api.")) return `${url.protocol}//${url.host.slice(4)}`;
  return url.origin;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export function redact(text: unknown, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out.replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "[redacted]").replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted]");
}

async function form(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body: body ?? {} };
}

export interface UserTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  scope: string;
  tokenType?: string;
}

function tokenSet(b: Record<string, any>): UserTokenSet {
  return {
    accessToken: b["access_token"],
    refreshToken: b["refresh_token"],
    expiresIn: b["expires_in"],
    refreshTokenExpiresIn: b["refresh_token_expires_in"],
    scope: b["scope"] ?? "",
    tokenType: b["token_type"],
  };
}

export async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri,
  webBase = GITHUB,
  fetchImpl = fetch,
}: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri?: string | undefined;
  webBase?: string | undefined;
  fetchImpl?: FetchLike;
}): Promise<UserTokenSet> {
  const params: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
  };
  if (redirectUri) params["redirect_uri"] = redirectUri;
  const r = await form(fetchImpl, `${webBase}/login/oauth/access_token`, params);
  if (!r.body["access_token"]) {
    throw new UserAuthorizationError(redact(`code exchange failed: ${r.status} ${r.body["error"] ?? ""}`, [code, codeVerifier, clientSecret]));
  }
  return tokenSet(r.body);
}

export async function refreshUserToken({
  clientId,
  clientSecret,
  refreshToken,
  webBase = GITHUB,
  fetchImpl = fetch,
}: {
  clientId: string;
  clientSecret?: string | undefined;
  refreshToken: string;
  webBase?: string | undefined;
  fetchImpl?: FetchLike;
}): Promise<UserTokenSet> {
  const params: Record<string, string> = { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken };
  if (clientSecret) params["client_secret"] = clientSecret;
  const r = await form(fetchImpl, `${webBase}/login/oauth/access_token`, params);
  if (!r.body["access_token"]) {
    throw new UserAuthorizationError(redact(`refresh failed: ${r.status} ${r.body["error"] ?? ""}`, [refreshToken, clientSecret]));
  }
  return tokenSet(r.body);
}

export async function revokeUserToken({
  clientId,
  clientSecret,
  accessToken,
  apiBase = "https://api.github.com",
  fetchImpl = fetch,
}: {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  try {
    const res = await fetchImpl(`${apiBase}/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

export class UserAuthorizationError extends Error {
  override name = "UserAuthorizationError";
}

export interface UserClient {
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  graphql(query: string, variables: Record<string, unknown>): Promise<{ ok: true; data: any } | { ok: false; status: number; errors: unknown }>;
}

export function userClient({
  token,
  apiBase = "https://api.github.com",
  fetchImpl = fetch,
}: {
  token: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
}): UserClient {
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: redact(text.slice(0, 500), [token]) };
    }
    return { status: res.status, body: json };
  }
  async function graphql(query: string, variables: Record<string, unknown>) {
    const r = await call("POST", "/graphql", { query, variables });
    if (r.status !== 200 || r.body?.errors) {
      return { ok: false as const, status: r.status, errors: r.body?.errors ?? r.body };
    }
    return { ok: true as const, data: r.body.data };
  }
  return { call, graphql };
}

const PR_STATE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id state isDraft headRefOid baseRefName mergeStateStatus mergeable reviewDecision viewerCanMergeAsAdmin
      author{login} mergedBy{login} mergeCommit{oid}
    }
  }
}`;

export const MARK_READY_MUTATION = `mutation($id:ID!){
  markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ isDraft } }
}`;

export interface LivePullRequest {
  id: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefOid: string;
  baseRefName?: string;
  mergeStateStatus: string;
  mergeable?: string;
  reviewDecision?: string | null;
  viewerCanMergeAsAdmin: boolean;
  author?: { login: string } | null;
  mergedBy?: { login: string } | null;
  mergeCommit?: { oid: string } | null;
}

export async function readPullRequest(
  client: UserClient,
  { owner, name, number }: { owner: string; name: string; number: number },
): Promise<{ ok: true; pr: LivePullRequest } | { ok: false; status: number; errors: unknown }> {
  const g = await client.graphql(PR_STATE_QUERY, { owner, name, number });
  if (!g.ok) return { ok: false, status: g.status, errors: g.errors };
  const pr = g.data?.repository?.pullRequest;
  if (!pr) return { ok: false, status: 404, errors: "pull request not visible to this token" };
  return { ok: true, pr };
}

export async function changedPaths(
  client: UserClient,
  { owner, name, number }: { owner: string; name: string; number: number },
): Promise<{ ok: true; paths: string[]; complete: boolean } | { ok: false; status: number; body: unknown }> {
  const paths: string[] = [];
  let fetched = 0;
  for (let page = 1; page <= 30; page++) {
    const r = await client.call("GET", `/repos/${owner}/${name}/pulls/${number}/files?per_page=100&page=${page}`);
    if (r.status !== 200) return { ok: false, status: r.status, body: r.body };
    for (const f of r.body as Array<{ filename: string; previous_filename?: string }>) {
      paths.push(f.filename);
      if (f.previous_filename) paths.push(f.previous_filename);
    }
    fetched += r.body.length;
    if (r.body.length < 100) return { ok: true, paths, complete: true };
  }
  return { ok: true, paths, complete: fetched < 3000 };
}

const BYPASSING_MODES = new Set(["always", "pull_requests_only", "exempt"]);

export async function rulesetBypass(
  client: UserClient,
  { owner, name, branch }: { owner: string; name: string; branch: string | undefined | null },
): Promise<{ ok: true; known: boolean; rulesets: string[] } | { ok: false; status: number }> {
  if (!branch) return { ok: true, known: false, rulesets: [] };
  const path = branch.split("/").map(encodeURIComponent).join("/");
  const ids = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const r = await client.call("GET", `/repos/${owner}/${name}/rules/branches/${path}?per_page=100&page=${page}`);
    if (r.status === 404 && page === 1) return { ok: true, known: true, rulesets: [] };
    if (r.status !== 200 || !Array.isArray(r.body)) return { ok: false, status: r.status };
    for (const rule of r.body as Array<{ ruleset_id?: unknown }>) {
      if (typeof rule.ruleset_id === "number") ids.add(rule.ruleset_id);
    }
    if (r.body.length < 100) break;
  }
  let known = true;
  const rulesets: string[] = [];
  for (const id of ids) {
    const r = await client.call("GET", `/repos/${owner}/${name}/rulesets/${id}`);
    if (r.status !== 200) return { ok: false, status: r.status };
    const mode = r.body?.current_user_can_bypass;
    if (typeof mode !== "string") known = false;
    else if (BYPASSING_MODES.has(mode)) rulesets.push(typeof r.body?.name === "string" ? r.body.name : `#${id}`);
  }
  return { ok: true, known, rulesets };
}

export function rulesetBypassFacts(r: { known: boolean; rulesets: string[] }): { viewerCanBypassRulesets?: boolean; bypassRulesets: string[] } {
  if (r.rulesets.length > 0) return { viewerCanBypassRulesets: true, bypassRulesets: r.rulesets };
  return r.known ? { viewerCanBypassRulesets: false, bypassRulesets: [] } : { bypassRulesets: [] };
}
