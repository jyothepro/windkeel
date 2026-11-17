import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { ApiTokenView, CreatedToken, DeviceAuthorization, SelfView } from "../client/api.js";
import { ApiError, WindkeelApi, PERMISSIONS, PRESETS } from "../client/api.js";
import type { StoredCredentials } from "../client/credentials.js";
import {
  CredentialsFileError,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../client/credentials.js";
import type { RemoteIo } from "./remote.js";
import { describeSelf, printRefusal } from "./remote.js";

export interface AuthDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openBrowser?: (url: string) => boolean;
  machineName?: string;
  readStdin?: () => Promise<string>;
  stdinIsTty?: boolean;
}

const ROLES = ["admin", "member", "viewer"] as const;

export type ScopeSpec = { preset: string } | { permissions: string[] };

export function parseScope(options: { scope?: string; permissions?: string; admin?: boolean }): ScopeSpec | string {
  const given = [options.scope !== undefined, options.permissions !== undefined, options.admin === true].filter(Boolean);
  if (given.length > 1) return "choose one of --scope, --permissions and --admin";
  if (options.admin) return { preset: "admin" };
  if (options.permissions !== undefined) {
    const permissions = options.permissions
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const unknown = permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (permissions.length === 0) return "--permissions needs at least one permission";
    if (unknown.length) return `not a permission: ${unknown.join(", ")}. Permissions: ${PERMISSIONS.join(", ")}`;
    return { permissions };
  }
  const preset = options.scope ?? "execute";
  if (!PRESETS[preset]) return `--scope must be one of ${Object.keys(PRESETS).join(", ")}, not ${preset}`;
  return { preset };
}

export interface LoginOptions {
  url?: string;
  scope?: string;
  permissions?: string;
  admin?: boolean;
  noBrowser?: boolean;
  org?: string;
}

export async function loginCommand(io: RemoteIo, options: LoginOptions, deps: AuthDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const scope = parseScope(options);
  if (typeof scope === "string") {
    io.err(scope);
    return 2;
  }
  const existing = readExisting(io, env);
  const apiUrl = options.url ?? (env["WINDKEEL_API_URL"]?.trim() || undefined) ?? existing?.apiUrl;
  if (!apiUrl) {
    io.err("windkeel login needs the deployment: --url https://your-ingress.example, or WINDKEEL_API_URL");
    return 2;
  }

  const anonymous = new WindkeelApi({ baseUrl: apiUrl, token: "", ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  let authorization: DeviceAuthorization;
  try {
    authorization = await anonymous.startDeviceLogin({
      machineName: deps.machineName ?? hostname(),
      ...scope,
      ...("preset" in scope && scope.preset === "admin" ? { admin: true } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      printRefusal(io, err);
      return 1;
    }
    throw err;
  }

  const link = authorization.verificationUriComplete ?? authorization.verificationUri;
  io.out(`First copy your one-time code: ${authorization.userCode}`);
  io.out(`Then approve this machine at:  ${link}`);
  if (!options.noBrowser) {
    const opened = (deps.openBrowser ?? openInBrowser)(link);
    io.out(opened ? "(Opening it in your browser.)" : "(Could not open a browser; open the link yourself.)");
  }
  io.out("Waiting for approval…");

  const outcome = await pollForDeviceToken(anonymous, authorization, deps);
  if (outcome.status === "denied") {
    io.err("The login was denied in the console. Nothing was saved.");
    return 1;
  }
  if (outcome.status === "expired") {
    io.err("The code expired before it was approved. Run `windkeel login` again for a new one.");
    return 1;
  }
  return saveAndDescribe(io, apiUrl, outcome.created.secret, options.org ?? outcome.created.token.organizationId ?? undefined, existing, deps);
}

export type DeviceOutcome = { status: "approved"; created: CreatedToken } | { status: "denied" } | { status: "expired" };

export async function pollForDeviceToken(
  api: WindkeelApi,
  authorization: DeviceAuthorization,
  deps: Pick<AuthDeps, "sleep" | "now"> = {},
): Promise<DeviceOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let intervalMs = Math.max(1, authorization.interval || 5) * 1000;
  const deadline = now() + authorization.expiresIn * 1000;

  for (;;) {
    await sleep(intervalMs);
    try {
      return { status: "approved", created: await api.pollDeviceToken(authorization.deviceCode) };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "access_denied") return { status: "denied" };
        if (err.code === "expired_token") return { status: "expired" };
        if (err.code === "slow_down") intervalMs += 5_000;
        else if (err.code !== "authorization_pending" && !err.transient) throw err;
      } else if (!(err instanceof TypeError)) {
        throw err;
      }
    }
    if (now() >= deadline) return { status: "expired" };
  }
}

export async function loginWithTokenCommand(
  io: RemoteIo,
  options: Pick<LoginOptions, "url" | "org">,
  deps: AuthDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  if (deps.stdinIsTty ?? process.stdin.isTTY) {
    io.err("windkeel login --with-token reads the token from stdin:  windkeel login --with-token < token.txt");
    return 2;
  }
  const token = (await (deps.readStdin ?? readAllStdin)()).trim();
  if (token === "") {
    io.err("windkeel login --with-token read nothing from stdin");
    return 2;
  }
  const existing = readExisting(io, env);
  const apiUrl = options.url ?? (env["WINDKEEL_API_URL"]?.trim() || undefined) ?? existing?.apiUrl;
  if (!apiUrl) {
    io.err("windkeel login needs the deployment: --url https://your-ingress.example, or WINDKEEL_API_URL");
    return 2;
  }
  try {
    await new WindkeelApi({ baseUrl: apiUrl, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).self();
  } catch (err) {
    if (err instanceof ApiError) {
      io.err(`${apiUrl} did not accept that token (${err.code}). Nothing was saved.`);
      return 1;
    }
    throw err;
  }
  return saveAndDescribe(io, apiUrl, token, options.org, existing, deps);
}

async function saveAndDescribe(
  io: RemoteIo,
  apiUrl: string,
  token: string,
  org: string | undefined,
  existing: StoredCredentials | null,
  deps: AuthDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  if (existing) await announceReplacement(io, existing, deps);

  const path = writeCredentials({ apiUrl, token, ...(org ? { org } : {}) }, env);
  io.out(`Logged in to ${apiUrl}. Saved to ${path} (readable by you only).`);

  const api = new WindkeelApi({ baseUrl: apiUrl, token, ...(org ? { org } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  try {
    for (const line of describeSelf(await api.self())) io.out(line);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    io.err(`Saved, but could not read back who this is: ${err.message} [${err.code}]`);
  }
  if (env["WINDKEEL_API_TOKEN"]?.trim()) {
    io.err("Note: WINDKEEL_API_TOKEN is set in this environment, and it takes precedence over this login until you unset it.");
  }
  return 0;
}

async function announceReplacement(io: RemoteIo, existing: StoredCredentials, deps: AuthDeps): Promise<void> {
  let who: SelfView | undefined;
  try {
    who = await new WindkeelApi({
      baseUrl: existing.apiUrl,
      token: existing.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }).self();
  } catch {
  }
  const account = who?.principal?.githubLogin ? `@${who.principal.githubLogin}` : (who?.account?.name ?? who?.subject);
  const tokenName = who?.token ? `token "${who.token.name}"` : "a token";
  io.out(
    `Replacing the stored login${account ? ` for ${account}` : ""} on ${existing.apiUrl} ` +
      `(${tokenName} beginning ${tokenPrefix(existing.token)}).`,
  );
  io.out(
    who?.token
      ? `That token is not revoked and still works; revoke it with \`windkeel token revoke ${who.token.id}\` if nothing else uses it.`
      : "That token was not revoked; if it still works, revoke it in the console.",
  );
}

export async function logoutCommand(io: RemoteIo, deps: AuthDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const path = credentialsPath(env);
  let existing: StoredCredentials | null;
  try {
    existing = readCredentials(env);
  } catch (err) {
    if (!(err instanceof CredentialsFileError)) throw err;
    deleteCredentials(env);
    io.out(`Deleted ${path}, which could not be read; any token it held was not revoked.`);
    return 1;
  }
  if (!existing) {
    io.out(`Not logged in: there is no ${path}.`);
    warnEnvToken(io, env);
    return 0;
  }

  const api = new WindkeelApi({ baseUrl: existing.apiUrl, token: existing.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  let revoked: { id: string; name: string } | undefined;
  let failure: string | undefined;
  let knownId: string | undefined;
  let bootstrap = false;
  try {
    const self = await api.self();
    if (self.via === "bootstrap") {
      bootstrap = true;
      throw new Error("this is the deployment's bootstrap WINDKEEL_API_TOKEN, which lives in the server's configuration");
    }
    if (!self.token) throw new Error("the server did not say which token this is");
    knownId = self.token.id;
    await api.revokeToken(self.token.id);
    revoked = { id: self.token.id, name: self.token.name };
  } catch (err) {
    failure = err instanceof ApiError ? `${err.message} [${err.code}]` : err instanceof Error ? err.message : String(err);
  }

  deleteCredentials(env);
  if (revoked) {
    io.out(`Revoked token "${revoked.name}" on ${existing.apiUrl} and deleted ${path}.`);
    warnEnvToken(io, env);
    return 0;
  }
  io.err(`Deleted ${path}, but the token was NOT revoked: ${failure}`);
  if (bootstrap) {
    io.err("To retire it, unset WINDKEEL_API_TOKEN on the deployment once everyone has a personal token.");
    warnEnvToken(io, env);
    return 1;
  }
  io.err(
    `It is still live on ${existing.apiUrl}. It begins ${tokenPrefix(existing.token)}` +
      (knownId ? ` (id ${knownId})` : "") +
      "; revoke it in the console, or with `windkeel token revoke <id>` after signing in again.",
  );
  warnEnvToken(io, env);
  return 1;
}

function warnEnvToken(io: RemoteIo, env: NodeJS.ProcessEnv): void {
  if (env["WINDKEEL_API_TOKEN"]?.trim()) {
    io.err("WINDKEEL_API_TOKEN is still set in this environment, and the CLI will keep using it.");
  }
}

export interface TokenCreateOptions {
  name?: string;
  scope?: string;
  permissions?: string;
  org?: string;
  expiresInDays?: string;
  json?: boolean;
}

export async function tokenCreateCommand(api: WindkeelApi, io: RemoteIo, options: TokenCreateOptions): Promise<number> {
  if (!options.name) {
    io.err("windkeel token create needs --name (say what will hold it: claude-code, ci, …)");
    return 2;
  }
  const scope = parseScope({
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
  });
  if (typeof scope === "string") {
    io.err(scope);
    return 2;
  }
  let expiresInDays: number | undefined;
  if (options.expiresInDays !== undefined) {
    expiresInDays = Number(options.expiresInDays);
    if (!Number.isInteger(expiresInDays) || expiresInDays <= 0) {
      io.err("--expires-in-days must be a whole number of days");
      return 2;
    }
  }
  const created = await api.createToken({
    name: options.name,
    ...scope,
    ...(options.org ? { organizationId: options.org } : {}),
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
  });
  if (options.json) {
    io.out(JSON.stringify(created, null, 2));
    return 0;
  }
  const t = created.token;
  io.out(`Created token "${t.name}"  (id ${t.id})`);
  io.out(`  can:      ${t.permissions.join(", ")}`);
  io.out(`  org:      ${t.organizationId ?? "every organization you are in"}`);
  io.out(`  expires:  ${t.expiresAt ?? "never"}`);
  io.out("");
  io.out(created.secret);
  io.out("");
  io.out("This is the only time the secret is shown; it will not be shown again. Store it now.");
  io.out("Give it to an agent as WINDKEEL_API_TOKEN in its MCP settings (docs/agent-integration.md).");
  return 0;
}

export async function tokenListCommand(api: WindkeelApi, io: RemoteIo, json?: boolean): Promise<number> {
  const { items } = await api.listTokens();
  if (json) {
    io.out(JSON.stringify({ items }, null, 2));
    return 0;
  }
  if (items.length === 0) {
    io.out("No tokens.");
    return 0;
  }
  io.out(`${pad("ID", 38)}${pad("NAME", 20)}${pad("PREFIX", 14)}${pad("STATE", 9)}${pad("LAST USED", 26)}CAN`);
  for (const token of items) {
    io.out(
      pad(token.id, 38) +
        pad(token.name, 20) +
        pad(token.prefix, 14) +
        pad(tokenState(token), 9) +
        pad(token.lastUsedAt ?? "never", 26) +
        token.permissions.join(","),
    );
  }
  return 0;
}

export async function tokenRevokeCommand(api: WindkeelApi, io: RemoteIo, tokenId: string): Promise<number> {
  const { token } = await api.revokeToken(tokenId);
  io.out(`Revoked "${token.name}" (${token.prefix}…). Anything still using it is refused from now on.`);
  return 0;
}

function tokenState(token: ApiTokenView): string {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return "expired";
  return "active";
}

export async function orgListCommand(api: WindkeelApi, io: RemoteIo, json?: boolean): Promise<number> {
  const self = await api.self();
  const orgs = self.organizations ?? [];
  if (json) {
    io.out(JSON.stringify(orgs, null, 2));
    return 0;
  }
  if (!self.organizations) {
    io.out("This deployment does not report organizations (it predates ADR-0024).");
    return 0;
  }
  if (orgs.length === 0) {
    io.out("You are not a member of any organization.");
    return 0;
  }
  const current = api.org ?? (orgs.length === 1 ? orgs[0]!.id : undefined);
  io.out(`  ${pad("ID", 38)}${pad("NAME", 24)}ROLE`);
  for (const org of orgs) {
    const mark = current === org.id || current === org.name ? "* " : "  ";
    io.out(`${mark}${pad(org.id, 38)}${pad(org.name, 24)}${org.role}`);
  }
  if (!current) io.out("\nNone chosen. `windkeel org use <id>` picks one for every command that follows.");
  return 0;
}

export async function orgUseCommand(api: WindkeelApi, io: RemoteIo, wanted: string, deps: AuthDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const self = await api.self();
  const orgs = self.organizations ?? [];
  const match = orgs.find((o) => o.id === wanted) ?? orgs.find((o) => o.name === wanted);
  if (!match) {
    io.err(`You are not a member of ${wanted}. Yours: ${orgs.map((o) => `${o.id} (${o.name})`).join(", ") || "none"}`);
    return 1;
  }
  const stored = readCredentials(env);
  if (!stored || api.tokenSource !== "file") {
    io.err(
      `The credential in use comes from ${api.tokenSource === "env" ? "WINDKEEL_API_TOKEN" : "the caller"}, not from \`windkeel login\`, ` +
        `so there is no file to remember this in. Set WINDKEEL_ORG=${match.id} instead.`,
    );
    return 1;
  }
  writeCredentials({ ...stored, org: match.id }, env);
  io.out(`Using ${match.name} (${match.id}) as ${match.role}.`);
  return 0;
}

export async function resolveOrgId(api: WindkeelApi): Promise<{ id: string } | { error: string }> {
  if (api.org) return { id: api.org };
  const orgs = (await api.self()).organizations ?? [];
  if (orgs.length === 1) return { id: orgs[0]!.id };
  if (orgs.length === 0) return { error: "You are not a member of any organization." };
  return {
    error:
      `You belong to ${orgs.length} organizations; say which with --org <id> or \`windkeel org use <id>\`: ` +
      orgs.map((o) => `${o.id} (${o.name})`).join(", "),
  };
}

export type MemberCommand =
  | { kind: "list"; json?: boolean }
  | { kind: "invitations"; json?: boolean }
  | { kind: "invite"; githubLogin: string; role?: string }
  | { kind: "role"; principalId: string; role: string }
  | { kind: "remove"; principalId: string };

export async function memberCommand(api: WindkeelApi, io: RemoteIo, command: MemberCommand): Promise<number> {
  const role = command.kind === "invite" ? (command.role ?? "member") : command.kind === "role" ? command.role : undefined;
  if (role !== undefined && !(ROLES as readonly string[]).includes(role)) {
    io.err(`a role is one of ${ROLES.join(", ")}, not ${role}`);
    return 2;
  }
  const org = await resolveOrgId(api);
  if ("error" in org) {
    io.err(org.error);
    return 2;
  }

  switch (command.kind) {
    case "list": {
      const { items } = await api.listMembers(org.id);
      if (command.json) {
        io.out(JSON.stringify({ items }, null, 2));
        return 0;
      }
      if (items.length === 0) {
        io.out("No members.");
        return 0;
      }
      io.out(`${pad("PRINCIPAL", 38)}${pad("ROLE", 8)}${pad("GITHUB", 22)}NAME`);
      for (const m of items) {
        io.out(pad(m.principalId, 38) + pad(m.role, 8) + pad(m.githubLogin ? `@${m.githubLogin}` : "—", 22) + show(m.displayName));
      }
      return 0;
    }
    case "invitations": {
      const { items } = await api.listInvitations(org.id);
      if (command.json) {
        io.out(JSON.stringify({ items }, null, 2));
        return 0;
      }
      if (items.length === 0) {
        io.out("No open invitations.");
        return 0;
      }
      io.out(`${pad("GITHUB", 24)}${pad("ROLE", 8)}${pad("INVITED", 26)}EXPIRES`);
      for (const i of items) {
        io.out(pad(`@${i.githubLogin}`, 24) + pad(i.role, 8) + pad(show(i["createdAt"]), 26) + show(i["expiresAt"]));
      }
      return 0;
    }
    case "invite": {
      const login = command.githubLogin.replace(/^@/, "");
      await api.invite(org.id, { githubLogin: login, role: role! });
      io.out(`Invited @${login} to ${org.id} as ${role}.`);
      io.out("They accept by signing in to the console with that GitHub account.");
      return 0;
    }
    case "role":
      await api.setMemberRole(org.id, command.principalId, role!);
      io.out(`${command.principalId} is now ${role} in ${org.id}.`);
      return 0;
    case "remove":
      await api.removeMember(org.id, command.principalId);
      io.out(`Removed ${command.principalId} from ${org.id}. Their tokens no longer reach it.`);
      return 0;
  }
}

function readExisting(io: RemoteIo, env: NodeJS.ProcessEnv): StoredCredentials | null {
  try {
    return readCredentials(env);
  } catch (err) {
    if (!(err instanceof CredentialsFileError)) throw err;
    io.out(`Replacing ${err.path}, which could not be read.`);
    return null;
  }
}

export function tokenPrefix(token: string): string {
  return token.startsWith("orq_") ? `${token.slice(0, 12)}…` : "(a credential that is not an orq_ token)";
}

export function openInBrowser(url: string): boolean {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

function show(value: unknown): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}
