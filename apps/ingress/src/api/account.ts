import {
  exportAuditEvents,
  listAuditEvents,
  purgeAuditEvents,
  recordAuditEvent,
  verifyAuditChain,
  withTransaction,
  csvField,
  type AuditContext,
  type AuditExportFormat,
  type AuditFilter,
} from "@windkeel/factory/tenancy";
import {
  createRole as storeCreateRole,
  deleteRole as storeDeleteRole,
  isUuid,
  listRoles,
  updateRole as storeUpdateRole,
  type AccessRole,
  type Permission,
} from "@windkeel/factory/tenancy";
import { getSecurityPolicy, putSecurityPolicy, type SecurityPolicy } from "@windkeel/factory/tenancy";
import { auditRetentionDaysFromEnv } from "@windkeel/factory/tenancy";
import { badRequest, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";
import { accessReviewLiveTokens, accessReviewMemberships, accessReviewPrincipals, organizationAccountId } from "../stores/account-store.js";

export interface AccountScope {
  accountId: string;
  principalId: string;
  actor: string;
  permissions: readonly Permission[];
  audit: AuditContext;
}

function time(query: Query, name: string): Date | undefined | ApiResult {
  const raw = query.get(name);
  if (raw === undefined || raw === "") return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? badRequest(`${name} must be an ISO 8601 time`, "invalid_time") : parsed;
}

function filterFrom(query: Query, base: { accountId: string; organizationId?: string | null }): AuditFilter | ApiResult {
  const after = time(query, "after");
  if (after && "status" in after) return after;
  const before = time(query, "before");
  if (before && "status" in before) return before;
  const actor = query.get("actor") || undefined;
  if (actor !== undefined && !isUuid(actor)) return badRequest("actor must be a principal id", "invalid_actor");
  const org = base.organizationId ?? query.get("org") ?? undefined;
  if (org && !isUuid(org)) return notFound("organization");
  return {
    accountId: base.accountId,
    organizationId: org || undefined,
    after: after,
    before: before,
    action: query.get("action") || undefined,
    actorPrincipalId: actor,
  };
}

async function organizationAccount(deps: ApiDeps, organizationId: string): Promise<string> {
  return organizationAccountId(deps.pool, organizationId);
}

async function listEvents(deps: ApiDeps, filter: AuditFilter, query: Query): Promise<ApiResult> {
  const limit = query.get("limit");
  const page = await listAuditEvents(deps.pool, {
    ...filter,
    cursor: query.get("cursor") || undefined,
    limit: limit === undefined ? undefined : Number(limit),
  });
  return ok(page);
}

async function exportEvents(deps: ApiDeps, filter: AuditFilter, query: Query, audit: AuditContext): Promise<ApiResult> {
  const format = (query.get("format") ?? "jsonl") as AuditExportFormat;
  if (format !== "jsonl" && format !== "csv") return badRequest("format must be jsonl or csv", "invalid_format");
  const cursor = query.get("cursor") || undefined;
  const part = await exportAuditEvents(deps.pool, { ...filter, format, cursor });
  await recordAuditEvent(deps.pool, {
    accountId: filter.accountId,
    organizationId: filter.organizationId ?? null,
    ...audit,
    action: "audit.exported",
    detail: {
      format,
      count: part.count,
      after: filter.after?.toISOString() ?? null,
      before: filter.before?.toISOString() ?? null,
      action: filter.action ?? null,
      continued: cursor !== undefined,
    },
  });
  const headers: Record<string, string> = {
    "content-type": part.contentType,
    "content-disposition": `attachment; filename="windkeel-audit.${format === "csv" ? "csv" : "jsonl"}"`,
    "x-windkeel-export-count": String(part.count),
  };
  if (part.nextCursor) headers["x-windkeel-next-cursor"] = part.nextCursor;
  return { status: 200, body: null, raw: part.body, headers };
}

export async function accountAuditEvents(deps: ApiDeps, scope: AccountScope, query: Query): Promise<ApiResult> {
  const filter = filterFrom(query, { accountId: scope.accountId });
  if ("status" in filter) return filter;
  return listEvents(deps, filter, query);
}

export async function accountAuditExport(deps: ApiDeps, scope: AccountScope, query: Query): Promise<ApiResult> {
  const filter = filterFrom(query, { accountId: scope.accountId });
  if ("status" in filter) return filter;
  return exportEvents(deps, filter, query, scope.audit);
}

export async function accountAuditVerify(deps: ApiDeps, scope: AccountScope): Promise<ApiResult> {
  return ok(await verifyAuditChain(deps.pool, scope.accountId));
}

export async function deleteAccountAuditEvents(deps: ApiDeps, scope: AccountScope, query: Query): Promise<ApiResult> {
  const before = time(query, "before");
  if (before === undefined) return badRequest("before is required: events older than it are deleted", "missing_field");
  if ("status" in before) return before;
  const { deleted, event } = await purgeAuditEvents(deps.pool, {
    accountId: scope.accountId,
    before,
    actor: scope.audit.actor,
    request: scope.audit.request,
    reason: "deleted",
  });
  return ok({ deleted, event });
}

export async function auditEvents(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const accountId = await organizationAccount(deps, scope.organizationId);
  const filter = filterFrom(query, { accountId, organizationId: scope.organizationId });
  if ("status" in filter) return filter;
  return listEvents(deps, filter, query);
}

export async function auditExport(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const accountId = await organizationAccount(deps, scope.organizationId);
  const filter = filterFrom(query, { accountId, organizationId: scope.organizationId });
  if ("status" in filter) return filter;
  return exportEvents(deps, filter, query, auditContextOf(scope));
}

function auditContextOf(scope: Scope): AuditContext {
  return scope.audit ?? { actor: { principalId: scope.principalId, text: scope.actor, kind: "user" } };
}

function roleView(role: AccessRole) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    builtIn: role.builtIn,
    createdBy: role.createdBy,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export async function roles(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const accountId = await organizationAccount(deps, scope.organizationId);
  const items = await listRoles(deps.pool, accountId);
  return ok({ items: items.map(roleView), endCursor: null, hasNextPage: false });
}

export async function accountRoles(deps: ApiDeps, scope: AccountScope): Promise<ApiResult> {
  const items = await listRoles(deps.pool, scope.accountId);
  return ok({ items: items.map(roleView), endCursor: null, hasNextPage: false });
}

function body(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export async function createRole(deps: ApiDeps, scope: AccountScope, raw: unknown): Promise<ApiResult> {
  const input = body(raw);
  const role = await withTransaction(deps.pool, async (tx) => {
    const created = await storeCreateRole(tx, {
      accountId: scope.accountId,
      key: input["key"],
      name: input["name"],
      description: input["description"],
      permissions: input["permissions"],
      createdByPrincipalId: scope.principalId,
      ceiling: scope.permissions,
    });
    await recordAuditEvent(tx, {
      accountId: scope.accountId,
      ...scope.audit,
      action: "role.created",
      target: { type: "role", id: created.id },
      detail: { key: created.key, name: created.name, permissions: created.permissions },
    });
    return created;
  });
  return { status: 201, body: { role: roleView(role) } };
}

export async function updateRole(deps: ApiDeps, scope: AccountScope, roleId: string, raw: unknown): Promise<ApiResult> {
  const input = body(raw);
  const changed = await withTransaction(deps.pool, async (tx) => {
    const result = await storeUpdateRole(tx, {
      accountId: scope.accountId,
      roleId,
      name: input["name"],
      description: input["description"],
      permissions: input["permissions"],
      ceiling: scope.permissions,
    });
    if (!result) return null;
    await recordAuditEvent(tx, {
      accountId: scope.accountId,
      ...scope.audit,
      action: "role.updated",
      target: { type: "role", id: result.after.id },
      detail: {
        key: result.after.key,
        before: { name: result.before.name, permissions: result.before.permissions },
        after: { name: result.after.name, permissions: result.after.permissions },
      },
    });
    return result.after;
  });
  return changed ? ok({ role: roleView(changed) }) : notFound("role");
}

export async function deleteRole(deps: ApiDeps, scope: AccountScope, roleId: string): Promise<ApiResult> {
  const deleted = await withTransaction(deps.pool, async (tx) => {
    const role = await storeDeleteRole(tx, scope.accountId, roleId);
    if (!role) return null;
    await recordAuditEvent(tx, {
      accountId: scope.accountId,
      ...scope.audit,
      action: "role.deleted",
      target: { type: "role", id: role.id },
      detail: { key: role.key, name: role.name },
    });
    return role;
  });
  return deleted ? ok({ deleted: deleted.id }) : notFound("role");
}

function policyView(policy: SecurityPolicy) {
  return {
    maxTokenTtlDays: policy.maxTokenTtlDays,
    requireTokenExpiry: policy.requireTokenExpiry,
    idleSessionMinutes: policy.idleSessionMinutes,
    requireMfa: policy.requireMfa,
    ipAllowlist: policy.ipAllowlist,
    auditRetentionDays: policy.auditRetentionDays,
    defaultAuditRetentionDays: auditRetentionDaysFromEnv(),
    updatedAt: policy.updatedAt,
  };
}

export async function securityPolicy(deps: ApiDeps, scope: AccountScope): Promise<ApiResult> {
  return ok({ policy: policyView(await getSecurityPolicy(deps.pool, scope.accountId)) });
}

export async function setSecurityPolicy(deps: ApiDeps, scope: AccountScope, raw: unknown): Promise<ApiResult> {
  const input = body(raw);
  const after = await withTransaction(deps.pool, async (tx) => {
    const result = await putSecurityPolicy(tx, scope.accountId, input, scope.principalId);
    await recordAuditEvent(tx, {
      accountId: scope.accountId,
      ...scope.audit,
      action: "policy.updated",
      target: { type: "account", id: scope.accountId },
      detail: { before: policyView(result.before), after: policyView(result.after) },
    });
    return result.after;
  });
  return ok({ policy: policyView(after) });
}

interface ReviewRow {
  principalId: string;
  kind: "user" | "service";
  displayName: string;
  githubLogin: string | null;
  bootstrap: boolean;
  deactivatedAt: Date | null;
  lastSignInAt: Date | null;
  accountRole: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
  tokens: Array<{
    id: string;
    name: string;
    prefix: string;
    organizationId: string | null;
    permissions: string[];
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
  }>;
}

export async function accessReview(deps: ApiDeps, scope: AccountScope, query: Query): Promise<ApiResult> {
  const format = query.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return badRequest("format must be json or csv", "invalid_format");
  const principals = await accessReviewPrincipals(deps.pool, scope.accountId);
  const memberships = await accessReviewMemberships(deps.pool, scope.accountId);
  const tokens = await accessReviewLiveTokens(deps.pool, scope.accountId);
  const review: ReviewRow[] = principals.map((p) => ({
    principalId: p["id"] as string,
    kind: p["kind"] === "token" ? "service" : "user",
    displayName: p["display_name"] as string,
    githubLogin: (p["github_login"] as string | null) ?? null,
    bootstrap: p["is_bootstrap"] === true,
    deactivatedAt: (p["deactivated_at"] as Date | null) ?? null,
    lastSignInAt: (p["last_sign_in_at"] as Date | null) ?? null,
    accountRole: (p["account_role"] as string | null) ?? null,
    organizations: memberships
      .filter((m) => m["principal_id"] === p["id"])
      .map((m) => ({ id: m["id"] as string, name: m["name"] as string, role: m["role"] as string })),
    tokens: tokens
      .filter((t) => t["owner_principal_id"] === p["id"])
      .map((t) => ({
        id: t["id"] as string,
        name: t["name"] as string,
        prefix: t["prefix"] as string,
        organizationId: (t["organization_id"] as string | null) ?? null,
        permissions: t["permissions"] as string[],
        createdAt: t["created_at"] as Date,
        lastUsedAt: (t["last_used_at"] as Date | null) ?? null,
        expiresAt: (t["expires_at"] as Date | null) ?? null,
      })),
  }));
  await recordAuditEvent(deps.pool, {
    accountId: scope.accountId,
    ...scope.audit,
    action: "access_review.exported",
    detail: { format, principals: review.length },
  });
  const generatedAt = new Date().toISOString();
  if (format === "json") return ok({ generatedAt, accountId: scope.accountId, principals: review });

  const header = ["principal_id", "kind", "display_name", "github_login", "bootstrap", "deactivated_at", "last_sign_in_at", "account_role", "organization", "role", "token_prefix", "token_permissions", "token_last_used_at", "token_expires_at"];
  const lines = [header.join(",")];
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  for (const r of review) {
    const base = [r.principalId, r.kind, r.displayName, r.githubLogin, r.bootstrap, iso(r.deactivatedAt), iso(r.lastSignInAt), r.accountRole];
    const orgs = r.organizations.length ? r.organizations : [null];
    for (const o of orgs) lines.push([...base, o?.name ?? null, o?.role ?? null, null, null, null, null].map(csvField).join(","));
    for (const t of r.tokens) {
      lines.push([...base, null, null, t.prefix, t.permissions.join(" "), iso(t.lastUsedAt), iso(t.expiresAt)].map(csvField).join(","));
    }
  }
  return {
    status: 200,
    body: null,
    raw: `${lines.join("\n")}\n`,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="windkeel-access-review-${generatedAt.slice(0, 10)}.csv"`,
    },
  };
}
