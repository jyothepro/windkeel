import type { Pool } from "pg";
import { recordAuditEvent, withTransaction } from "../audit-log.js";
import { type Queryable } from "./common.js";
import { type Principal, getPrincipal, rowToPrincipal } from "./principals.js";
import {
  acceptPendingInvitations,
  hasPendingInvitation,
  insertUserPrincipal,
  linkIdentity,
  lockPendingInvitations,
  selectIdentityLink,
  selectPrincipalByGithubUser,
  touchIdentity,
} from "./stores/session-store.js";

export interface SessionClaims {
  provider: string;
  subject: string;
  githubUserId: number | null;
  githubLogin: string | null;
  displayName: string | null;

  sessionId?: string | null | undefined;

  aal?: string | null | undefined;
}

export async function principalForSession(pool: Pool, claims: SessionClaims): Promise<Principal | null> {
  const link = await selectIdentityLink(pool, claims.provider, claims.subject);
  const knownId = link?.principalId;
  if (knownId) {
    const linkedGithubId = link.githubUserId;
    if (linkedGithubId !== null && Number(linkedGithubId) !== claims.githubUserId) return null;
    await touchIdentity(pool, claims.provider, claims.subject);

    if (claims.githubUserId !== null) await acceptInvitations(pool, knownId, claims.githubUserId);
    return getPrincipal(pool, knownId);
  }
  if (claims.githubUserId === null) return null;
  const githubUserId = claims.githubUserId;

  return withTransaction(pool, async (client) => {
    const pending = await lockPendingInvitations(client, githubUserId);
    const existing = await selectPrincipalByGithubUser(client, githubUserId);

    if (pending.length === 0 && !existing) return null;
    const principal = rowToPrincipal(
      existing ??
        (await insertUserPrincipal(client, {
          accountId: pending[0]!["account_id"],
          displayName: claims.displayName ?? claims.githubLogin ?? `github:${githubUserId}`,
          githubUserId,
          githubLogin: claims.githubLogin,
        })),
    );
    await linkIdentity(client, principal.id, claims.provider, claims.subject);
    await acceptInvitations(client, principal.id, githubUserId);
    return principal;
  });
}

async function acceptInvitations(db: Queryable, principalId: string, githubUserId: number): Promise<void> {

  if (!(await hasPendingInvitation(db, githubUserId))) return;
  await withTransaction(db, async (tx) => {
    const rows = await acceptPendingInvitations(tx, principalId, githubUserId);
    for (const row of rows) {
      await recordAuditEvent(tx, {
        organizationId: row["organization_id"] as string,
        actor: { principalId, text: (row["github_login"] as string | null) ?? (row["display_name"] as string), kind: "user" },
        action: "invitation.accepted",
        target: { type: "invitation", id: row["id"] as string },
        detail: { role: row["role"] },
      });
    }
  });
}
