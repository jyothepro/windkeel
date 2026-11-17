
import * as fixtures from "./fixtures.ts";
import { ApiError } from "./http.ts";
import type {
  AccessRole,
  AuditEvent,
  ApiToken,
  CreatedToken,
  DeviceRequest,
  Invitation,
  Member,
  RepositoryGrant,
  Page,
} from "./types.ts";
import { live, orgRoute, query, request, sampleOnly, sampleToken } from "./api-transport.ts";

export async function connectGithub(body: { code: string; codeVerifier: string; redirectUri: string }): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", "/github-authorization", body);
}

export async function disconnectGithub(): Promise<void> {
  if (!live()) sampleOnly();
  await request("DELETE", "/github-authorization");
}

export async function listTokens(): Promise<ApiToken[]> {
  if (!live()) return fixtures.tokens();
  return (await request<Page<ApiToken>>("GET", "/tokens")).items;
}

export async function createToken(input: {
  name: string;
  preset?: string;
  permissions?: string[];
  organizationId: string | null;
  expiresInDays: number | null;
}): Promise<CreatedToken> {
  if (!live()) {
    return {
      secret: sampleToken(),
      token: {
        id: "tok-sample",
        name: input.name,
        prefix: "orq_SAMP",
        organizationId: input.organizationId,
        permissions: input.permissions ?? null,
        ownerPrincipalId: "p-you",
        createdBy: "you",
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    };
  }
  return request("POST", "/tokens", input);
}

export async function revokeToken(id: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", `/tokens/${encodeURIComponent(id)}/revoke`);
}

export async function listMembers(orgId: string): Promise<Member[]> {
  if (!live()) return fixtures.members();
  return (await request<Page<Member>>("GET", orgRoute(orgId, "/members"))).items;
}

export async function setMemberRole(orgId: string, principalId: string, role: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", orgRoute(orgId, `/members/${encodeURIComponent(principalId)}/role`), { role });
}

export async function removeMember(orgId: string, principalId: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", orgRoute(orgId, `/members/${encodeURIComponent(principalId)}/delete`));
}

export async function listInvitations(orgId: string): Promise<Invitation[]> {
  if (!live()) return fixtures.invitations();
  return (await request<Page<Invitation>>("GET", orgRoute(orgId, "/invitations"))).items;
}

export async function createInvitation(orgId: string, githubLogin: string, role: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", orgRoute(orgId, "/invitations"), { githubLogin, role });
}

export async function deleteInvitation(orgId: string, id: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", orgRoute(orgId, `/invitations/${encodeURIComponent(id)}/delete`));
}

export async function listGrants(orgId: string): Promise<RepositoryGrant[]> {
  if (!live()) return fixtures.grants();
  return (await request<Page<RepositoryGrant>>("GET", orgRoute(orgId, "/repositories/grants"))).items;
}

export async function createGrant(orgId: string, repositoryId: string, intake: boolean): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", orgRoute(orgId, "/repositories/grants"), { repositoryId, intake });
}

export async function deleteGrant(orgId: string, repositoryId: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", orgRoute(orgId, `/repositories/grants/${encodeURIComponent(repositoryId)}/delete`));
}

export async function listAuditEvents(
  orgId: string,
  filter: { action?: string; after?: string; before?: string; cursor?: string } = {},
): Promise<Page<AuditEvent>> {
  if (!live()) return { items: [], endCursor: null, hasNextPage: false };
  return request("GET", orgRoute(orgId, `/audit-events${query({ ...filter, limit: "50" })}`));
}

export async function listRoles(orgId: string): Promise<AccessRole[]> {
  if (!live()) return [];
  return (await request<Page<AccessRole>>("GET", orgRoute(orgId, "/roles"))).items;
}

export async function listAccountRoles(): Promise<AccessRole[]> {
  if (!live()) return [];
  return (await request<Page<AccessRole>>("GET", "/account/roles")).items;
}

export async function createRole(input: { name: string; description?: string; permissions: string[] }): Promise<AccessRole> {
  if (!live()) sampleOnly();
  return (await request<{ role: AccessRole }>("POST", "/account/roles", input)).role;
}

export async function deleteRole(roleId: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("DELETE", `/account/roles/${encodeURIComponent(roleId)}`);
}

export async function getDeviceRequest(userCode: string): Promise<DeviceRequest | null> {
  if (!live()) return fixtures.deviceRequest(userCode);
  try {
    return await request("GET", `/auth/device/${encodeURIComponent(userCode)}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}

export async function decideDevice(userCode: string, decision: "approve" | "deny"): Promise<void> {
  if (!live()) return;
  await request("POST", `/auth/device/${encodeURIComponent(userCode)}/${decision}`);
}
