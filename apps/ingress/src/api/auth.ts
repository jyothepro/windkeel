

import {
  accountRoleOf,
  findLiveToken,
  getBootstrapPrincipal,
  getPrincipal,
  looksLikeApiToken,
  organizationsFor,
  principalForSession,
  type ApiToken,
  type Principal,
  type SessionClaims,
} from "@windkeel/factory/tenancy";
import { recordAuditEvent, type AuditContext, type AuditRequestContext } from "@windkeel/factory/tenancy";
import { checkSessionPolicy, clientIp, getSecurityPolicy, ipAllowed } from "@windkeel/factory/tenancy";
import * as accountHandlers from "./account.js";
import type { ApiDeps, ApiResult, Query } from "./handlers.js";
import type { Permission } from "./route.js";
import type { SessionVerifier } from "./session.js";
import { defaultAccountId } from "../stores/account-store.js";
import * as nodeCrypto from "node:crypto";
import { rejected } from "./errors.js";

export interface ApiRequest {
  method: string;

  path: string;
  query: Query;

  headers: Record<string, string | undefined>;

  body?: unknown;

  remoteAddress?: string | undefined;

  rawBody?: Buffer | string | undefined;
}

export interface ApiAuth {
  token: string | undefined;

  subject: string;
  sessions?: SessionVerifier | undefined;

  clientIpHeader?: string | undefined;
}

export interface Caller {
  principal: Principal;

  token: ApiToken | null;
  via: "bootstrap" | "token" | "session";

  actor: string;

  audit: AuditContext;

  session?: SessionClaims | undefined;
}

export interface OrganizationScope {
  id: string;
  name: string;
  role: string | null;
  permissions: Permission[];
}

export async function authenticate(
  deps: ApiDeps,
  auth: ApiAuth,
  headers: Record<string, string | undefined>,
  request: AuditRequestContext,
): Promise<Caller | ApiResult> {
  const presented = bearerFrom(headers["authorization"]);
  const bootstrap = auth.token === undefined || auth.token === "" ? undefined : auth.token;

  if (presented !== undefined && looksLikeApiToken(presented)) {
    const token = await findLiveToken(deps.pool, presented);
    if (!token) return rejected();
    const principal = await getPrincipal(deps.pool, token.ownerPrincipalId);
    if (!principal || principal.deactivatedAt) return rejected();
    const actor = actorName(principal);
    return { principal, token, via: "token", actor, audit: { actor: { principalId: principal.id, text: actor, kind: "token" }, request } };
  }

  if (bootstrap === undefined && !auth.sessions) {
    return {
      status: 503,
      body: {
        error: "neither WINDKEEL_API_TOKEN nor sign-in is configured, so the API is disabled",
        code: "api_disabled",
      },
    };
  }
  if (presented === undefined) {
    return {
      status: 401,
      body: { error: "a bearer token is required", code: "unauthenticated" },
      headers: { "www-authenticate": "Bearer" },
    };
  }

  if (bootstrap !== undefined && timingSafeEqual(presented, bootstrap)) {
    const principal = await getBootstrapPrincipal(deps.pool);
    if (!principal) {
      return { status: 500, body: { error: "the bootstrap principal is missing", code: "internal" } };
    }
    return {
      principal,
      token: null,
      via: "bootstrap",
      actor: auth.subject,
      audit: { actor: { principalId: principal.id, text: auth.subject, kind: "token" }, request },
    };
  }

  if (auth.sessions) {
    const claims = await auth.sessions.verify(presented);
    if (claims) {
      const principal = await principalForSession(deps.pool, claims);
      if (!principal) {
        await auditRefusedSignIn(deps, claims, request);
        return {
          status: 403,
          body: {
            error: "you are signed in, but no organization has invited this account",
            code: "not_a_member",
          },
        };
      }
      const actor = actorName(principal);
      return {
        principal,
        token: null,
        via: "session",
        actor,
        audit: { actor: { principalId: principal.id, text: actor, kind: "user" }, request },
        session: claims,
      };
    }
  }
  return rejected();
}

export function requestContext(auth: ApiAuth, request: ApiRequest): AuditRequestContext {
  return {
    ip: clientIp(request.headers, request.remoteAddress, auth.clientIpHeader),
    userAgent: request.headers["user-agent"] ?? null,
    requestId: request.headers["x-vercel-id"] ?? request.headers["x-request-id"] ?? null,
  };
}

async function auditRefusedSignIn(deps: ApiDeps, claims: SessionClaims, request: AuditRequestContext): Promise<void> {
  const accountId = await defaultAccountId(deps.pool);
  if (!accountId) return;
  await recordAuditEvent(deps.pool, {
    accountId,
    actor: { principalId: null, text: claims.githubLogin ?? `${claims.provider}:${claims.subject}`, kind: "user" },
    action: "session.refused",
    request,
    detail: { reason: "not_a_member", provider: claims.provider, subject: claims.subject, githubUserId: claims.githubUserId },
  });
}

export async function enforcePolicy(deps: ApiDeps, caller: Caller): Promise<ApiResult | null> {
  if (caller.via === "bootstrap") return null;
  const policy = await getSecurityPolicy(deps.pool, caller.principal.accountId);
  const ip = caller.audit.request?.ip ?? null;
  if (policy.ipAllowlist && !ipAllowed(ip, policy.ipAllowlist)) {
    await recordAuditEvent(deps.pool, {
      accountId: caller.principal.accountId,
      ...caller.audit,
      action: "request.ip_denied",
      detail: { via: caller.via },
    });
    return { status: 403, body: { error: "this account does not accept requests from your address", code: "ip_not_allowed" } };
  }
  if (caller.via !== "session" || !caller.session) return null;
  const { refusal, firstSeen } = await checkSessionPolicy(
    deps.pool,
    caller.principal,
    { sessionId: caller.session.sessionId ?? null, aal: caller.session.aal ?? null },
    policy,
  );
  if (refusal) {
    await recordAuditEvent(deps.pool, {
      accountId: caller.principal.accountId,
      ...caller.audit,
      action: "session.refused",
      detail: { reason: refusal.code },
    });
    return {
      status: refusal.code === "session_idle" ? 401 : 403,
      body: { error: refusal.error, code: refusal.code },
      ...(refusal.code === "session_idle" ? { headers: { "www-authenticate": "Bearer" } } : {}),
    };
  }
  if (firstSeen) {
    await recordAuditEvent(deps.pool, {
      accountId: caller.principal.accountId,
      ...caller.audit,
      action: "session.signed_in",
      detail: { provider: caller.session.provider, aal: caller.session.aal ?? null },
    });
  }
  return null;
}

export async function accountScope(deps: ApiDeps, caller: Caller): Promise<accountHandlers.AccountScope | ApiResult> {
  if (caller.token?.organizationId) {
    return {
      status: 403,
      body: { error: "this token is pinned to one organization, so it cannot act on the account", code: "forbidden" },
    };
  }
  const role = await accountRoleOf(deps.pool, caller.principal.id);
  if (!role) {
    return {
      status: 403,
      body: { error: "account routes need an account role; yours is only in organizations", code: "account_role_required" },
    };
  }
  const token = caller.token;
  return {
    accountId: caller.principal.accountId,
    principalId: caller.principal.id,
    actor: caller.actor,
    permissions: token ? role.permissions.filter((p) => token.permissions.includes(p)) : role.permissions,
    audit: caller.audit,
  };
}

export function forbiddenInAccount(permission: Permission, caller: Caller): ApiResult {
  return {
    status: 403,
    body: {
      error:
        caller.token && !caller.token.permissions.includes(permission)
          ? `this token's scope does not include ${permission}`
          : `your account role does not hold ${permission}`,
      code: "forbidden",
      missing: permission,
    },
  };
}

function actorName(principal: Principal): string {
  return principal.githubLogin ?? principal.displayName;
}

export async function accessibleOrganizations(deps: ApiDeps, caller: Caller): Promise<OrganizationScope[]> {
  const all = await organizationsFor(deps.pool, caller.principal.id);
  const token = caller.token;
  if (!token) return all;
  return all
    .filter((org) => token.organizationId === null || token.organizationId === org.id)
    .map((org) => ({ ...org, permissions: org.permissions.filter((p) => token.permissions.includes(p)) }));
}

export function resolveOrganization(
  organizations: OrganizationScope[],
  orgId: string | undefined,
): OrganizationScope | ApiResult {
  if (orgId !== undefined) {
    const found = organizations.find((org) => org.id === orgId);
    return found ?? { status: 404, body: { error: "no such organization", code: "not_found" } };
  }
  if (organizations.length === 1) return organizations[0]!;
  if (organizations.length === 0) {
    return {
      status: 403,
      body: { error: "this credential reaches no organization", code: "not_a_member" },
    };
  }
  return {
    status: 400,
    body: {
      error: "you belong to more than one organization; call /v1/orgs/{orgId}/… to say which",
      code: "organization_required",
      organizations: organizations.map((org) => ({ id: org.id, name: org.name })),
    },
  };
}

export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const value = rest.join(" ").trim();
  return value === "" ? undefined : value;
}

function timingSafeEqual(a: string, b: string): boolean {
  const { createHash, timingSafeEqual: compare } = nodeCrypto;
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return compare(digest(a), digest(b));
}
