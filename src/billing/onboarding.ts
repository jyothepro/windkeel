

import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { lockedOrganizationAccess, type SessionClaims } from "../factory/tenancy.js";
import type { InstallationVerifier } from "../github/installation-verifier.js";
import type { BillingPlan } from "./accounts.js";
import type { BillingProviderName, SelfServeMode } from "../factory/config/billing.js";
import { enableCredits, grantCredits, topupWindow } from "./credit-ledger.js";
import { creditsToMicro, TRIAL_CREDITS } from "../factory/config/credits.js";
import {
  claimScmConnection,
  grantUnclaimedInstallationRepositories,
  insertAccount,
  insertAccountMembership,
  insertActiveBillingAccount,
  insertInstallState,
  insertMembership,
  insertOrganization,
  insertSignupInvite,
  insertUserIdentity,
  insertUserPrincipal,
  lockInstallState,
  lockSignupInvite,
  markInstallStateUsed,
  redeemSignupInvite,
  selectBuiltInAdminRole,
  selectGithubConnectionOwner,
  selectPrincipalByGithubUser,
  selectUserIdentity,
} from "./stores/billing-store.js";
import { withTransaction } from "../factory/db/transaction.js";

export class OnboardingError extends Error {
  override readonly name = "OnboardingError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const token = (prefix: string): string => `${prefix}${randomBytes(24).toString("base64url")}`;

const DEFAULT_INVITE_DAYS = 14;

export async function createSignupInvite(
  db: Pool | PoolClient,
  input: { note?: string | null; expiresInDays?: number; now?: Date } = {},
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const days = input.expiresInDays ?? DEFAULT_INVITE_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new OnboardingError(400, "invalid_expiry", "an invite lasts 1 to 365 days");
  const code = token("orqinv_");
  const expiresAt = new Date((input.now ?? new Date()).getTime() + days * 86_400_000);
  const { rows } = await insertSignupInvite(db, sha256(code), input.note ?? null, expiresAt);
  return { id: rows[0]["id"] as string, code, expiresAt };
}

export interface SelfServeSignupInput {

  claims: SessionClaims;
  inviteCode: string;
  organizationName: string;
  plan: Exclude<BillingPlan, "internal">;
  mode: SelfServeMode;

  provider: BillingProviderName;

  trialCredits?: number;
  now?: Date;
}

export interface SelfServeAccount {
  accountId: string;
  organizationId: string;
  principalId: string;
}

function validateOrganizationName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 2 || trimmed.length > 64) throw new OnboardingError(400, "invalid_name", "an organization name is 2 to 64 characters");
  if (/[\u0000-\u001f]/.test(trimmed)) throw new OnboardingError(400, "invalid_name", "an organization name is one line of text");
  return trimmed;
}

export async function createSelfServeAccount(pool: Pool, input: SelfServeSignupInput): Promise<SelfServeAccount> {
  if (input.mode === "off") throw new OnboardingError(404, "signup_disabled", "self-serve signup is not on for this deployment");
  const { claims } = input;
  if (claims.githubUserId === null) {
    throw new OnboardingError(400, "github_required", "sign in with GitHub to create an organization: Windkeel works on GitHub repositories");
  }
  const name = validateOrganizationName(input.organizationName);
  if (input.plan !== "byok" && input.plan !== "managed") throw new OnboardingError(400, "invalid_plan", "plan is byok or managed");
  const code = typeof input.inviteCode === "string" ? input.inviteCode.trim() : "";
  if (!code) throw new OnboardingError(403, "invite_required", "signup is invite-only: enter the invite code you were sent");
  const now = input.now ?? new Date();

  try {
    return await withTransaction(pool, async (client): Promise<SelfServeAccount> => {
      const identity = await selectUserIdentity(client, claims.provider, claims.subject);
      if (identity.rowCount) throw new OnboardingError(409, "already_member", "you already belong to an organization; sign in to it instead");

      const known = await selectPrincipalByGithubUser(client, claims.githubUserId);
      if (known.rowCount) throw new OnboardingError(409, "already_has_account", "this GitHub account already belongs to a Windkeel organization");

      const { rows: invites } = await lockSignupInvite(client, sha256(code));
      const invite = invites[0];
      if (!invite || invite["redeemed_at"] !== null || (invite["expires_at"] as Date) <= now) {

        throw new OnboardingError(403, "invalid_invite", "that invite code is not valid (unknown, already used, or expired)");
      }

      const { rows: account } = await insertAccount(client, name);
      const accountId = account[0]["id"] as string;
      const { rows: org } = await insertOrganization(client, accountId, name);
      const organizationId = org[0]["id"] as string;
      const { rows: principal } = await insertUserPrincipal(
        client,
        accountId,
        claims.displayName ?? claims.githubLogin ?? "owner",
        claims.githubUserId,
        claims.githubLogin,
      );
      const principalId = principal[0]["id"] as string;
      await insertUserIdentity(client, principalId, claims.provider, claims.subject);
      const { rows: admin } = await selectBuiltInAdminRole(client);
      const adminRoleId = admin[0]["id"] as string;
      await insertMembership(client, organizationId, principalId, adminRoleId);
      await insertAccountMembership(client, accountId, principalId, adminRoleId);
      await insertActiveBillingAccount(client, accountId, input.provider, input.plan);

      await enableCredits(client, accountId, now);
      const trialCredits = input.trialCredits ?? TRIAL_CREDITS;
      if (trialCredits > 0) {
        await grantCredits(client, {
          accountId,
          source: "trial",
          product: "trial",
          amountMicro: creditsToMicro(trialCredits),
          ...topupWindow(now),
          idempotencyKey: `trial:${accountId}`,
        });
      }
      await redeemSignupInvite(client, invite["id"], principalId, accountId);
      return { accountId, organizationId, principalId };
    });
  } catch (error) {

    if ((error as { code?: string }).code === "23505") {
      throw new OnboardingError(409, "already_has_account", "this GitHub account already belongs to a Windkeel organization");
    }
    throw error;
  }
}

const INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

export async function createInstallState(
  db: Pool | PoolClient,
  input: { organizationId: string; principalId: string; now?: Date; ttlMs?: number },
): Promise<{ state: string; expiresAt: Date }> {
  const state = token("ois_");
  const expiresAt = new Date((input.now ?? new Date()).getTime() + (input.ttlMs ?? INSTALL_STATE_TTL_MS));
  await insertInstallState(db, sha256(state), input.organizationId, input.principalId, expiresAt);
  return { state, expiresAt };
}

export function installUrl(appSlug: string, state: string, webBase = "https://github.com"): string {
  return `${webBase.replace(/\/+$/, "")}/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export interface LinkInstallationInput {
  state: string;
  installationId: number;

  code: string | undefined;

  principalId: string;
  verifier: InstallationVerifier;
  now?: Date;
}

async function assertManagesRepositories(client: PoolClient, principalId: string, organizationId: string): Promise<void> {
  const access = await lockedOrganizationAccess(client, principalId, organizationId);
  if (!access?.permissions.includes("repositories.manage")) {
    throw new OnboardingError(
      403,
      "permission_revoked",
      "you no longer hold repositories.manage in that organization, so the installation was not linked; ask one of its admins",
    );
  }
}

export async function linkInstallation(
  pool: Pool,
  input: LinkInstallationInput,
): Promise<{ organizationId: string; installationId: number; granted: number }> {
  if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) {
    throw new OnboardingError(400, "invalid_installation", "installation_id must be a positive integer");
  }
  const now = input.now ?? new Date();

  const state = await withTransaction(pool, async (client) => {
    const { rows } = await lockInstallState(client, sha256(typeof input.state === "string" ? input.state : ""));
    const row = rows[0];
    if (!row || row["used_at"] !== null || row["principal_id"] !== input.principalId) {
      throw new OnboardingError(403, "invalid_state", "that installation link is not valid; start the installation again from Windkeel");
    }
    if ((row["expires_at"] as Date) <= now) {
      throw new OnboardingError(403, "expired_state", "that installation link has expired; start the installation again from Windkeel");
    }
    await assertManagesRepositories(client, input.principalId, row["organization_id"] as string);
    await markInstallStateUsed(client, sha256(input.state));
    return row;
  });

  const verdict = await input.verifier.verify({ installationId: input.installationId, code: input.code });
  if (!verdict.ok && verdict.reason === "not_owner") {
    throw new OnboardingError(
      403,
      "installation_not_owned",
      "only the owner of the account the App is installed on (that user, or an admin of that organization) can link the installation",
    );
  }
  if (!verdict.ok) {
    throw new OnboardingError(403, "installation_not_yours", "GitHub does not show that installation as one you can reach");
  }

  const organizationId = state["organization_id"] as string;
  const accountId = state["account_id"] as string;
  return withTransaction(pool, async (client) => {
    await assertManagesRepositories(client, input.principalId, organizationId);
    const claimed = await claimScmConnection(client, accountId, input.installationId);
    if (claimed.rowCount === 0) {
      const { rows: owner } = await selectGithubConnectionOwner(client, input.installationId);
      if (owner[0]?.["account_id"] !== accountId) {
        throw new OnboardingError(409, "installation_claimed", "that GitHub App installation already belongs to another Windkeel account");
      }
    }
    const granted = await grantUnclaimedInstallationRepositories(client, organizationId, input.installationId, input.principalId);
    return { organizationId, installationId: input.installationId, granted: granted.rowCount ?? 0 };
  });
}
