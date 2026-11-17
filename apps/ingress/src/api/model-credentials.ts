

import { describeError, defaultLog } from "@windkeel/factory/intake";
import {
  getModelCredential,
  listModelCredentials,
  putModelCredential,
  revokeModelCredential as storeRevoke,
  rotateModelCredential as storeRotate,
  type ModelCredential,
} from "@windkeel/factory/models";
import { accepted, audited, conflict, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";

function modelCredentialView(c: ModelCredential) {
  return {
    id: c.id,
    provider: c.provider,
    baseUrl: c.baseUrl,
    declaredVendor: c.declaredVendor,
    label: c.label,
    last4: c.last4,
    keypairId: c.keypairId,
    status: c.status,
    statusReason: c.statusReason,
    validatedAt: c.validatedAt?.toISOString() ?? null,
    createdByPrincipalId: c.createdByPrincipalId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    revokedAt: c.revokedAt?.toISOString() ?? null,
  };
}

type ValidationStart = "started" | "unavailable" | "failed";

export async function modelCredentials(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const items = await listModelCredentials(deps.pool, scope.organizationId, {
    includeRevoked: query.get("include") === "revoked",
  });
  return ok({ items: items.map(modelCredentialView), endCursor: null, hasNextPage: false });
}

export async function createModelCredential(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  if (!deps.secretPublicKey) return secretsDisabled();
  const fields = objectBody(body);
  const publicKey = deps.secretPublicKey;
  const stored = await audited(
    deps,
    scope,
    (tx) =>
      putModelCredential(tx, {
        organizationId: scope.organizationId,
        provider: stringOr(fields["provider"]),
        label: stringOr(fields["label"]),
        value: stringOr(fields["value"]),
        baseUrl: optionalString(fields["baseUrl"]),
        declaredVendor: optionalString(fields["declaredVendor"]),
        createdByPrincipalId: scope.principalId,
        publicKey,
        ...(deps.modelEndpoint ? { endpoint: deps.modelEndpoint } : {}),
      }),

    (done) => ({ action: "model_credential.created", target: { type: "model_credential", id: done.id }, detail: { label: done.label, provider: done.provider } }),
  );
  const validation = await startValidation(deps, stored);
  return { status: 201, body: { credential: modelCredentialView(stored), validation } };
}

export async function rotateModelCredential(
  deps: ApiDeps,
  scope: Scope,
  credentialId: string,
  body: unknown,
): Promise<ApiResult> {
  if (!deps.secretPublicKey) return secretsDisabled();
  const publicKey = deps.secretPublicKey;
  const rotated = await audited(
    deps,
    scope,
    (tx) =>
      storeRotate(tx, {
        organizationId: scope.organizationId,
        credentialId,
        value: stringOr(objectBody(body)["value"]),
        publicKey,
      }),
    (done) => (done ? { action: "model_credential.rotated", target: { type: "model_credential", id: credentialId }, detail: { label: done.label } } : null),
  );
  if (!rotated) return notFound("model credential (or it is revoked)");
  const validation = await startValidation(deps, rotated);
  return ok({ credential: modelCredentialView(rotated), validation });
}

export async function revokeModelCredential(deps: ApiDeps, scope: Scope, credentialId: string): Promise<ApiResult> {
  const revoked = await audited(
    deps,
    scope,
    (tx) => storeRevoke(tx, scope.organizationId, credentialId),
    (done) => (done ? { action: "model_credential.revoked", target: { type: "model_credential", id: credentialId }, detail: { label: done.label } } : null),
  );
  return revoked ? ok({ credential: modelCredentialView(revoked) }) : notFound("model credential");
}

export async function validateModelCredential(deps: ApiDeps, scope: Scope, credentialId: string): Promise<ApiResult> {
  const credential = await getModelCredential(deps.pool, scope.organizationId, credentialId);
  if (!credential) return notFound("model credential");
  if (credential.revokedAt) return conflict("this credential is revoked", "credential_revoked");
  const validation = await startValidation(deps, credential);
  if (validation !== "started") {
    return {
      status: 503,
      body: { error: "the credential check could not be started; try again shortly", code: "validation_unavailable" },
    };
  }
  return accepted({ credential: modelCredentialView(credential), validation });
}

async function startValidation(deps: ApiDeps, credential: ModelCredential): Promise<ValidationStart> {
  if (!deps.credentialValidation) return "unavailable";
  try {
    await deps.credentialValidation.request(credential.organizationId, credential.id);
    return "started";
  } catch (error) {
    defaultLog("model credential validation did not start", { credentialId: credential.id, ...describeError(error) });
    return "failed";
  }
}

function secretsDisabled(): ApiResult {
  return {
    status: 503,
    body: {
      error:
        "WINDKEEL_SECRET_PUBLIC_KEY is not set, so this deployment cannot seal a model credential. " +
        "Run `windkeel-admin secrets keygen` and set the public half here and the private half on the " +
        "stage deployment.",
      code: "secrets_disabled",
    },
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function stringOr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
