/**
 * #419: linking a GitHub App installation succeeds if and only if the person holds
 * repositories.manage in the state's organization when the link lands, whatever their organization
 * and account roles held when they asked for the link. A refusal leaves no claim and no grant.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { createInstallState, createSelfServeAccount, createSignupInvite, linkInstallation } from "../dist/billing/onboarding.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import { PERMISSIONS } from "../dist/factory/tenancy/permissions.js";
import { fakeInstallationVerifier } from "../dist/github/installation-verifier.js";
import { skip, withSchema } from "./billing-fixtures.js";

const permissionSet = fc.subarray([...PERMISSIONS]);
const roleAtLinkTime = fc.record({
  member: fc.option(permissionSet, { nil: null }),
  account: fc.option(permissionSet, { nil: null }),
});

test("#419 property: a link succeeds iff repositories.manage is held at link time", { skip }, async () => {
  await withSchema("onboarding_link_property", async (pool) => {
    process.env.WINDKEEL_SELF_SERVE_SIGNUP = "invite";
    try {
      const { code } = await createSignupInvite(pool);
      const acme = await createSelfServeAccount(pool, {
        claims: { provider: "supabase", subject: "sub-owner", githubUserId: 9000, githubLogin: "owner", displayName: "owner" },
        inviteCode: code,
        organizationName: "Acme",
        plan: "managed",
        mode: "invite",
        provider: "fake",
      });
      let n = 0;

      await fc.assert(
        fc.asyncProperty(roleAtLinkTime, async (atLink) => {
          n += 1;
          const installationId = 10_000 + n;
          const { rows: person } = await pool.query(
            `insert into principal (account_id, kind, display_name, github_user_id, github_login)
             values ($1, 'user', $2, $3, $2) returning id`,
            [acme.accountId, `p${n}`, 20_000 + n],
          );
          const principalId = person[0].id;
          const { rows: roles } = await pool.query(
            `insert into access_role (account_id, key, name, permissions)
             values ($1, $2, $2, array['repositories.manage']), ($1, $3, $3, array['repositories.manage']) returning id`,
            [acme.accountId, `m${n}`, `a${n}`],
          );
          const [memberRole, accountRole] = roles.map((r) => r.id);
          await pool.query("insert into membership (organization_id, principal_id, access_role_id) values ($1, $2, $3)", [
            acme.organizationId,
            principalId,
            memberRole,
          ]);
          await pool.query("insert into account_membership (account_id, principal_id, access_role_id) values ($1, $2, $3)", [
            acme.accountId,
            principalId,
            accountRole,
          ]);
          const repo = await upsertRepository(pool, {
            owner: "acme",
            name: `r${n}`,
            defaultBranch: "main",
            cloneUrl: `https://github.com/acme/r${n}.git`,
            githubInstallationId: installationId,
          });
          const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId });

          if (atLink.member === null) await pool.query("delete from membership where principal_id = $1", [principalId]);
          else await pool.query("update access_role set permissions = $2 where id = $1", [memberRole, atLink.member]);
          if (atLink.account === null) await pool.query("delete from account_membership where principal_id = $1", [principalId]);
          else await pool.query("update access_role set permissions = $2 where id = $1", [accountRole, atLink.account]);

          const holds = [...(atLink.member ?? []), ...(atLink.account ?? [])].includes("repositories.manage");
          const verifier = fakeInstallationVerifier({ c: [installationId] });
          const outcome = await linkInstallation(pool, { state, installationId, code: "c", principalId, verifier }).then(
            (linked) => ({ linked }),
            (error) => ({ error }),
          );
          const claims = (await pool.query("select 1 from scm_connection where installation_id = $1", [installationId])).rowCount;
          const grants = (await pool.query("select 1 from repository_grant where repository_id = $1", [repo.id])).rowCount;
          if (holds) {
            assert.deepEqual(outcome.linked, { organizationId: acme.organizationId, installationId, granted: 1 });
            assert.deepEqual([claims, grants], [1, 1]);
          } else {
            assert.equal(outcome.error?.code, "permission_revoked", String(outcome.error ?? "linked"));
            assert.equal(outcome.error.status, 403);
            assert.deepEqual([claims, grants], [0, 0]);
          }
        }),
        { numRuns: 60 },
      );
    } finally {
      delete process.env.WINDKEEL_SELF_SERVE_SIGNUP;
    }
  });
});
