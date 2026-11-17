
import { InvalidCursorError, InvalidEventKindError } from "@windkeel/factory/runs";
import { InvalidPageCursorError } from "@windkeel/factory/runs";
import { MalformedEvidenceRefError } from "@windkeel/factory/execution";
import type { ApiResult } from "./handlers.js";
import { isConnectionLimit } from "../connection-limit.js";
import type { Permission } from "./route.js";
import type { Caller } from "./auth.js";

const TENANCY_ERRORS: Record<string, { status: number; code: string }> = {
  InvalidScopeError: { status: 400, code: "invalid_scope" },
  TokenScopeError: { status: 400, code: "invalid_scope" },
  GrantError: { status: 400, code: "invalid_grant" },

  GrantForbiddenError: { status: 403, code: "forbidden" },
  MembershipError: { status: 409, code: "invalid_membership" },

  OrganizationBudgetExhaustedError: { status: 402, code: "org_budget_exhausted" },
  BillingAccountSuspendedError: { status: 402, code: "billing_suspended" },

  CreditsExhaustedError: { status: 402, code: "credits_exhausted" },
  ServicePrincipalError: { status: 400, code: "invalid_service_principal" },

  RoleError: { status: 400, code: "invalid_role" },
  UnknownRoleError: { status: 404, code: "role_not_found" },
  BuiltinRoleError: { status: 403, code: "builtin_role" },
  RoleInUseError: { status: 409, code: "role_in_use" },

  SecurityPolicyError: { status: 400, code: "invalid_policy" },
  TokenPolicyError: { status: 400, code: "token_policy" },
  UnknownAuditActionError: { status: 400, code: "invalid_action" },
  InvalidAuditCursorError: { status: 400, code: "invalid_cursor" },
};

export function rejected(): ApiResult {

  return { status: 403, body: { error: "token rejected", code: "forbidden" } };
}

export function forbidden(permission: Permission, caller: Caller): ApiResult {
  return {
    status: 403,
    body: {
      error:
        caller.token && !caller.token.permissions.includes(permission)
          ? `this token's scope does not include ${permission}`
          : `you do not hold ${permission} in this organization`,
      code: "forbidden",
      missing: permission,
    },
  };
}

export function translateError(err: unknown): ApiResult {

  if (isConnectionLimit(err)) {
    return {
      status: 503,
      body: { error: "the control plane is out of database connections right now; try again in a few seconds", code: "connection_limit" },
      headers: { "retry-after": "2" },
    };
  }
  if (err instanceof InvalidCursorError || err instanceof InvalidPageCursorError) {
    return { status: 400, body: { error: err.message, code: "invalid_cursor" } };
  }
  if (err instanceof InvalidEventKindError) {
    return { status: 400, body: { error: err.message, code: "invalid_kind" } };
  }

  if (err instanceof Error) {
    const code = TENANCY_ERRORS[err.name];
    if (code) return { status: code.status, body: { error: err.message, code: code.code } };
  }

  if (err instanceof Error && err.name === "InvalidSecretKeyError") {
    return { status: 400, body: { error: err.message, code: "invalid_secret_key" } };
  }
  if (err instanceof Error && err.name === "SealedSecretError") {

    return {
      status: 500,
      body: {
        error: "this deployment's WINDKEEL_SECRET_PUBLIC_KEY is not a usable X25519 public key",
        code: "secret_key_unusable",
      },
    };
  }

  if (err instanceof Error) {
    const integration = integrationError(err);
    if (integration) return integration;
  }
  if (err instanceof MalformedEvidenceRefError) {

    return { status: 500, body: { error: "stored evidence reference is malformed", code: "bad_ref" } };
  }
  throw err;
}

function integrationError(err: Error): ApiResult | null {
  switch (err.name) {
    case "TenantClaimedError":
      return { status: 409, body: { error: err.message, code: "tenant_claimed" } };

    case "RouteError":
    case "WebhookEndpointError":

    case "ModelCredentialError":

    case "ModelPolicyError":

    case "KnowledgeNoteError":

    case "PlaybookError": {
      const { status, code } = err as Error & { status: number; code: string };
      return { status, body: { error: err.message, code } };
    }
    case "IntegrationNotConnected":
      return { status: 422, body: { error: err.message, code: "integration_not_connected" } };
    case "IntegrationMisconfigured":
      return { status: 503, body: { error: err.message, code: "integration_misconfigured" } };
    case "IntegrationUnavailable":
      return { status: 502, body: { error: err.message, code: "integration_unavailable" } };
    default:
      return null;
  }
}
