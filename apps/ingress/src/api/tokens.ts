import { recordAuditEvent, withTransaction } from "@windkeel/factory/tenancy";
import type { Page } from "@windkeel/api-contract";
import { ADMIN_PERMISSIONS, accountRoleOf, createApiToken, decideDeviceLogin as storeDecision, DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS, DeviceLoginError, findDeviceLogin, getAccount, getPrincipal, isUuid, linkDeviceToken, listTokens, organizationsFor, pollDeviceLogin as storePoll, resolveScope, revokeToken as storeRevoke, startDeviceLogin as storeStartDeviceLogin, type ApiToken, type Permission } from "@windkeel/factory/tenancy";
import type { Caller, OrganizationScope } from "./router.js";
import { type ApiDeps, type ApiError, type ApiResult, badRequest, conflict, field, notFound, ok, stringField } from "./common.js";

export async function self(
  deps: ApiDeps,
  caller: Caller,
  organizations: OrganizationScope[],
): Promise<ApiResult> {
  const account = await getAccount(deps.pool, caller.principal.accountId);
  const role = await accountRoleOf(deps.pool, caller.principal.id);
  const token = caller.token;
  return ok({
    principal: {
      id: caller.principal.id,
      kind: caller.principal.kind,
      displayName: caller.principal.displayName,
      githubLogin: caller.principal.githubLogin,
    },
    account,

    accountRole:
      role && !token?.organizationId
        ? { key: role.key, name: role.name, permissions: token ? role.permissions.filter((p) => token.permissions.includes(p)) : role.permissions }
        : null,
    organizations: organizations.map((org) => ({
      id: org.id,
      name: org.name,
      role: org.role,
      permissions: org.permissions,
    })),
    token: caller.token
      ? {
          id: caller.token.id,
          name: caller.token.name,
          permissions: caller.token.permissions,
          organizationId: caller.token.organizationId,
        }
      : null,
    via: caller.via,
    subject: caller.actor,

    features: { takeover: deps.takeover?.enabled === true },
    scopes: caller.via === "bootstrap" ? ["operator"] : [...new Set(organizations.flatMap((o) => o.permissions))],
  });
}

export async function tokens(deps: ApiDeps, caller: Caller): Promise<ApiResult> {
  const items = await listTokens(deps.pool, caller.principal.id);
  return ok({ items: items.map(tokenView), endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}

export async function createToken(
  deps: ApiDeps,
  caller: Caller,
  organizations: OrganizationScope[],
  body: unknown,
): Promise<ApiResult> {
  if (caller.token && !caller.token.permissions.includes("tokens.manage")) {
    return {
      status: 403,
      body: {
        error: "this token's scope does not include tokens.manage, so it cannot make tokens",
        code: "forbidden",
        missing: "tokens.manage",
      } satisfies ApiError & { missing: string },
    };
  }
  if (caller.principal.kind !== "user") {

    return {
      status: 403,
      body: {
        error: "a service principal cannot make its own tokens; use /v1/service-principals/{id}/tokens",
        code: "forbidden",
      } satisfies ApiError,
    };
  }
  const name = stringField(body, "name");
  if (!name) return badRequest("name is required", "missing_field");

  const pinned = caller.token?.organizationId ?? null;
  const organizationId = stringField(body, "organizationId") ?? pinned;
  const reachable = organizationId === null ? organizations : organizations.filter((o) => o.id === organizationId);
  if (organizationId !== null && reachable.length === 0) return notFound("organization");

  const permissions = resolveScope({ preset: field(body, "preset"), permissions: field(body, "permissions") });
  const ceiling = [...new Set(reachable.flatMap((o) => o.permissions))];
  const expires = field(body, "expiresInDays");
  const created = await withTransaction(deps.pool, async (tx) => {
    const minted = await createApiToken(tx, {
      name,
      ownerPrincipalId: caller.principal.id,
      createdByPrincipalId: caller.principal.id,
      organizationId,
      creatorPin: pinned,
      permissions,
      ceiling,

      expiresInDays: typeof expires === "number" ? expires : undefined,
    });
    await recordAuditEvent(tx, {
      accountId: caller.principal.accountId,
      organizationId,
      ...caller.audit,
      action: "token.created",
      target: { type: "token", id: minted.token.id },
      detail: tokenAuditDetail(minted.token, minted.expiryClamped),
    });
    return minted;
  });
  return {
    status: 201,
    body: { token: tokenView(created.token), secret: created.secret, ...(created.expiryClamped ? { expiryClamped: true } : {}) },
  };
}

export function tokenAuditDetail(token: ApiToken, clamped = false): Record<string, unknown> {
  return {
    name: token.name,
    prefix: token.prefix,
    permissions: token.permissions,
    organizationId: token.organizationId,
    ownerPrincipalId: token.ownerPrincipalId,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    ...(clamped ? { expiryClamped: true } : {}),
  };
}

export async function revokeToken(deps: ApiDeps, caller: Caller, tokenId: string): Promise<ApiResult> {
  if (!isUuid(tokenId)) return notFound("token");
  const revoked = await withTransaction(deps.pool, async (tx) => {
    const token = await storeRevoke(tx, caller.principal.id, tokenId);
    if (token) {
      await recordAuditEvent(tx, {
        accountId: caller.principal.accountId,
        organizationId: token.organizationId,
        ...caller.audit,
        action: "token.revoked",
        target: { type: "token", id: token.id },
        detail: tokenAuditDetail(token),
      });
    }
    return token;
  });
  return revoked ? ok({ token: tokenView(revoked) }) : notFound("token");
}

export function tokenView(token: ApiToken) {

  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    organizationId: token.organizationId,
    permissions: token.permissions,
    ownerPrincipalId: token.ownerPrincipalId,
    createdBy: token.createdBy,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
  };
}

export async function startDeviceLogin(deps: ApiDeps, body: unknown): Promise<ApiResult> {
  if (!deps.consoleUrl) {
    return {
      status: 503,
      body: {
        error: "this deployment has no console to approve a login in; use `windkeel login --with-token`",
        code: "console_unconfigured",
      } satisfies ApiError,
    };
  }
  const admin = field(body, "admin") === true;
  const permissions = admin
    ? resolveScope({ preset: "admin" })
    : resolveScope({ preset: field(body, "preset"), permissions: field(body, "permissions") });
  const requested = admin ? permissions : permissions.filter((p) => !ADMIN_PERMISSIONS.includes(p));
  const organizationId = stringField(body, "organizationId") ?? null;
  if (organizationId !== null && !isUuid(organizationId)) return badRequest("organizationId is not an id");

  try {
    const { deviceCode, login } = await storeStartDeviceLogin(deps.pool, {
      machineName: stringField(body, "machineName") ?? "unnamed machine",
      permissions: requested,
      organizationId,
    });
    const verificationUri = `${deps.consoleUrl.replace(/\/+$/, "")}/login/device`;
    return ok({
      deviceCode,
      userCode: login.userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(login.userCode)}`,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
      expiresIn: DEVICE_CODE_TTL_SECONDS,
    });
  } catch (err) {
    if (err instanceof DeviceLoginError) {
      return { status: 429, body: { error: err.message, code: err.code } satisfies ApiError };
    }
    throw err;
  }
}

export async function pollDeviceLogin(deps: ApiDeps, body: unknown): Promise<ApiResult> {
  const deviceCode = stringField(body, "deviceCode");
  if (!deviceCode) return badRequest("deviceCode is required", "missing_field");
  const poll = await storePoll(deps.pool, deviceCode);
  switch (poll.kind) {
    case "pending":
      return badRequest("waiting for someone to approve this login", "authorization_pending");
    case "slow_down":
      return badRequest("polling too fast; wait longer between polls", "slow_down");
    case "denied":
      return badRequest("the login was denied", "access_denied");
    case "expired":
      return badRequest("the login expired or was already used; start again", "expired_token");
    case "approved": {
      const organizations = await organizationsFor(deps.pool, poll.decidedBy);
      const reachable = poll.login.organizationId === null
        ? organizations
        : organizations.filter((o) => o.id === poll.login.organizationId);

      const ceiling = new Set(reachable.flatMap((o) => o.permissions));
      const permissions = poll.login.permissions.filter((p) => ceiling.has(p));
      if (permissions.length === 0) {
        return badRequest("the approver holds none of the permissions this login asked for", "access_denied");
      }
      const approver = await getPrincipal(deps.pool, poll.decidedBy);
      const created = await withTransaction(deps.pool, async (tx) => {
        const minted = await createApiToken(tx, {
          name: `CLI on ${poll.login.machineName}`,
          ownerPrincipalId: poll.decidedBy,
          createdByPrincipalId: poll.decidedBy,
          organizationId: poll.login.organizationId,
          permissions,
          ceiling: [...ceiling],

          requiredDefaultDays: DEVICE_TOKEN_REQUIRED_DAYS,
        });
        await linkDeviceToken(tx, poll.login.id, minted.token.id);
        await recordAuditEvent(tx, {
          accountId: approver?.accountId,
          organizationId: poll.login.organizationId,
          actor: {
            principalId: poll.decidedBy,
            text: approver ? (approver.githubLogin ?? approver.displayName) : poll.decidedBy,
            kind: "user",
          },
          action: "token.created",
          target: { type: "token", id: minted.token.id },
          detail: { ...tokenAuditDetail(minted.token, minted.expiryClamped), via: "device_login" },
        });
        return minted;
      });
      return ok({ token: tokenView(created.token), secret: created.secret });
    }
  }
}

const DEVICE_TOKEN_REQUIRED_DAYS = 90;

export async function deviceLogin(deps: ApiDeps, userCode: string): Promise<ApiResult> {
  const login = await findDeviceLogin(deps.pool, userCode);
  if (!login) return notFound("login");
  return ok(deviceLoginView(login));
}

export async function decideDeviceLogin(
  deps: ApiDeps,
  caller: Caller,
  organizations: OrganizationScope[],
  userCode: string,
  decision: "approved" | "denied",
): Promise<ApiResult> {
  const login = await findDeviceLogin(deps.pool, userCode);
  if (!login) return notFound("login");
  if (decision === "approved" && organizations.length === 0) {
    return { status: 403, body: { error: "you belong to no organization", code: "not_a_member" } };
  }
  const decided = await storeDecision(deps.pool, userCode, decision, caller.principal.id);
  if (!decided) {
    return conflict(`this login is ${login.state} and can no longer be ${decision}`, "not_pending");
  }
  return ok(deviceLoginView(decided));
}

function deviceLoginView(login: { userCode: string; machineName: string; permissions: Permission[]; expiresAt: Date; state: string }) {
  return {
    userCode: login.userCode,
    machineName: login.machineName,
    requestedPermissions: login.permissions,
    admin: login.permissions.some((p) => ADMIN_PERMISSIONS.includes(p)),
    expiresAt: login.expiresAt,

    state: login.state === "consumed" ? "approved" : login.state,
  };
}
