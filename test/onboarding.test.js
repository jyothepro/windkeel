/**
 * #394 / ADR-0038: invite-only self-serve signup and linking a GitHub App installation.
 *
 * Signup is all-or-nothing and one per GitHub user; an install link is single-use, short-lived and
 * bound to its organization and person; an installation is linked only when GitHub says the person
 * can reach it, and never one another account already owns.
 */
import "./helpers.js"; // WINDKEEL_VALIDATE_RESPONSES: every API answer here is checked against the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { DEFAULT_PRICING } from "../dist/factory/config/billing.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import {
  createInstallState,
  createSelfServeAccount,
  createSignupInvite,
  installUrl,
  linkInstallation,
} from "../dist/billing/onboarding.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import { fakeInstallationVerifier } from "../dist/github/installation-verifier.js";
import { skip, withSchema } from "./billing-fixtures.js";

const claims = (id, login = `user${id}`) => ({
  provider: "supabase",
  subject: `sub-${id}`,
  githubUserId: id,
  githubLogin: login,
  displayName: login,
});

const signup = (pool, input) =>
  createSelfServeAccount(pool, {
    plan: "managed",
    mode: "invite",
    provider: "fake",
    organizationName: "Acme Robotics",
    ...input,
  });

async function tableCounts(pool) {
  const { rows } = await pool.query(
    `select (select count(*) from account)::int as accounts, (select count(*) from organization)::int as orgs,
            (select count(*) from principal)::int as principals, (select count(*) from billing_account)::int as billing`,
  );
  return rows[0];
}

test("signup creates account, organization, owner and billing atomically, and redeems the invite", { skip }, async () => {
  await withSchema("onboarding_signup", async (pool) => {
    const { code } = await createSignupInvite(pool, { note: "design partner" });
    assert.match(code, /^orqinv_/);
    const created = await signup(pool, { claims: claims(1001, "ada"), inviteCode: code, plan: "byok" });

    const { rows: org } = await pool.query("select name, is_default, account_id from organization where id = $1", [created.organizationId]);
    assert.deepEqual([org[0].name, org[0].is_default, org[0].account_id], ["Acme Robotics", false, created.accountId]);
    const { rows: role } = await pool.query(
      `select r.key from membership m join access_role r on r.id = m.access_role_id where m.organization_id = $1 and m.principal_id = $2`,
      [created.organizationId, created.principalId],
    );
    assert.equal(role[0].key, "admin", "the person who signs up owns it");
    const { rows: identity } = await pool.query("select provider, subject from user_identity where principal_id = $1", [created.principalId]);
    assert.deepEqual(identity[0], { provider: "supabase", subject: "sub-1001" });
    const { rows: billing } = await pool.query(
      "select provider, plan, status, credit_billing_since from billing_account where account_id = $1",
      [created.accountId],
    );
    assert.deepEqual([billing[0].provider, billing[0].plan, billing[0].status], ["fake", "byok", "active"]);
    assert.ok(billing[0].credit_billing_since, "#431: a new account is on credits from the start");
    // #431 / ADR-0040: the trial is 500 credits, one time, no card — not a monthly budget any more.
    const { rows: grants } = await pool.query("select source, amount_micro, expires_at > now() + interval '360 days' as year from credit_grant where account_id = $1", [created.accountId]);
    assert.deepEqual(grants.map((g) => [g.source, Number(g.amount_micro), g.year]), [["trial", 500_000_000, true]]);
    const { rows: budget } = await pool.query("select 1 from organization_budget where organization_id = $1", [created.organizationId]);
    assert.equal(budget.length, 0, "no budget row: credits are the limit");
    const { rows: invite } = await pool.query("select redeemed_by_principal_id, code_hash from signup_invite");
    assert.equal(invite[0].redeemed_by_principal_id, created.principalId);
    assert.notEqual(invite[0].code_hash, code, "only the hash is stored");
  });
});

test("an invite is one account; unknown, used and expired codes are one refusal; off is off", { skip }, async () => {
  await withSchema("onboarding_invites", async (pool) => {
    const { code } = await createSignupInvite(pool);
    await signup(pool, { claims: claims(1), inviteCode: code });
    const before = await tableCounts(pool);
    for (const inviteCode of [code, "orqinv_nope", ""]) {
      await assert.rejects(signup(pool, { claims: claims(2), inviteCode }), (error) => {
        assert.ok(["invalid_invite", "invite_required"].includes(error.code));
        assert.equal(error.status, 403);
        return true;
      });
    }
    const { code: expired } = await createSignupInvite(pool, { expiresInDays: 1, now: new Date("2026-01-01T00:00:00Z") });
    await assert.rejects(signup(pool, { claims: claims(3), inviteCode: expired }), /not valid/);
    assert.deepEqual(await tableCounts(pool), before, "a refused signup leaves nothing behind");

    const { code: fresh } = await createSignupInvite(pool);
    await assert.rejects(signup(pool, { claims: claims(4), inviteCode: fresh, mode: "off" }), (e) => e.code === "signup_disabled");
    await assert.rejects(signup(pool, { claims: { ...claims(5), githubUserId: null }, inviteCode: fresh }), (e) => e.code === "github_required");
    await assert.rejects(signup(pool, { claims: claims(6), inviteCode: fresh, plan: "free" }), (e) => e.code === "invalid_plan");
    await assert.rejects(signup(pool, { claims: claims(7), inviteCode: fresh, organizationName: "x" }), (e) => e.code === "invalid_name");
  });
});

test("one GitHub user gets one trial, however many invites they hold", { skip }, async () => {
  await withSchema("onboarding_one_trial", async (pool) => {
    const first = await createSignupInvite(pool);
    const second = await createSignupInvite(pool);
    await signup(pool, { claims: claims(42), inviteCode: first.code });
    // The same GitHub user through another sign-in subject: still one account.
    await assert.rejects(
      signup(pool, { claims: { ...claims(42), subject: "another-subject" }, inviteCode: second.code }),
      (error) => error.code === "already_has_account" && error.status === 409,
    );
    const { rows } = await pool.query("select redeemed_at from signup_invite where id = $1", [second.id]);
    assert.equal(rows[0].redeemed_at, null, "the second invite is not spent by a refusal");
  });
});

// --- installing the App --------------------------------------------------------------------

async function signedUp(pool, id = 7) {
  const { code } = await createSignupInvite(pool);
  return signup(pool, { claims: claims(id), inviteCode: code });
}

test("a linked installation's repositories are granted to the organization; the state is single use", { skip }, async () => {
  await withSchema("onboarding_link", async (pool) => {
    process.env.WINDKEEL_SELF_SERVE_SIGNUP = "invite";
    try {
      const acme = await signedUp(pool);
      // A webhook arrived first: with signup on, the default organization does not claim it.
      const early = await upsertRepository(pool, { owner: "acme", name: "early", defaultBranch: "main", cloneUrl: "https://github.com/acme/early.git", githubInstallationId: 777 });
      assert.equal((await pool.query("select 1 from repository_grant where repository_id = $1", [early.id])).rowCount, 0);

      const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId: acme.principalId });
      assert.match(installUrl("windkeel-app", state), /^https:\/\/github\.com\/apps\/windkeel-app\/installations\/new\?state=ois_/);
      const verifier = fakeInstallationVerifier({ "code-ada": [777] });
      const linked = await linkInstallation(pool, { state, installationId: 777, code: "code-ada", principalId: acme.principalId, verifier });
      assert.deepEqual(linked, { organizationId: acme.organizationId, installationId: 777, granted: 1 });

      // A repository the installation reaches later goes to the same organization.
      const late = await upsertRepository(pool, { owner: "acme", name: "late", defaultBranch: "main", cloneUrl: "https://github.com/acme/late.git", githubInstallationId: 777 });
      const { rows } = await pool.query("select organization_id, intake from repository_grant where repository_id = any ($1) order by repository_id", [[early.id, late.id]]);
      assert.deepEqual(rows.map((r) => [r.organization_id, r.intake]), [[acme.organizationId, true], [acme.organizationId, true]]);

      await assert.rejects(
        linkInstallation(pool, { state, installationId: 777, code: "code-ada", principalId: acme.principalId, verifier }),
        (error) => error.code === "invalid_state",
        "used once",
      );
    } finally {
      delete process.env.WINDKEEL_SELF_SERVE_SIGNUP;
    }
  });
});

test("a forged, expired or someone else's state, or an installation the person cannot reach, is refused", { skip }, async () => {
  await withSchema("onboarding_link_refused", async (pool) => {
    const acme = await signedUp(pool, 8);
    const mallory = await signedUp(pool, 9);
    const verifier = fakeInstallationVerifier({ "code-acme": [555], "code-mallory": [999] }, { "code-collab": [555] });
    const link = (input) => linkInstallation(pool, { installationId: 555, code: "code-acme", principalId: acme.principalId, verifier, ...input });

    await assert.rejects(link({ state: "ois_forged" }), (e) => e.code === "invalid_state" && e.status === 403);
    const expired = await createInstallState(pool, { organizationId: acme.organizationId, principalId: acme.principalId, ttlMs: -1000 });
    await assert.rejects(link({ state: expired.state }), (e) => e.code === "expired_state");
    const acmes = await createInstallState(pool, { organizationId: acme.organizationId, principalId: acme.principalId });
    await assert.rejects(link({ state: acmes.state, principalId: mallory.principalId }), (e) => e.code === "invalid_state", "bound to who asked");

    // Mallory's own valid state, naming Acme's installation: GitHub does not list it for her.
    const mallorys = await createInstallState(pool, { organizationId: mallory.organizationId, principalId: mallory.principalId });
    await assert.rejects(
      link({ state: mallorys.state, principalId: mallory.principalId, code: "code-mallory" }),
      (e) => e.code === "installation_not_yours",
    );
    // A collaborator on one of Acme's repositories can see the installation, but does not own it.
    const collabs = await createInstallState(pool, { organizationId: mallory.organizationId, principalId: mallory.principalId });
    await assert.rejects(
      link({ state: collabs.state, principalId: mallory.principalId, code: "code-collab" }),
      (e) => e.code === "installation_not_owned" && e.status === 403,
    );
    const noCode = await createInstallState(pool, { organizationId: acme.organizationId, principalId: acme.principalId });
    await assert.rejects(link({ state: noCode.state, code: undefined }), (e) => e.code === "installation_not_yours");
    assert.equal((await pool.query("select 1 from scm_connection where installation_id = 555")).rowCount, 0);
  });
});

test("an installation another account owns — including the operator's — is not linked", { skip }, async () => {
  await withSchema("onboarding_link_claimed", async (pool) => {
    // Signup off: first seen is the operator's, as in a single-tenant deployment.
    await upsertRepository(pool, { owner: "op", name: "r", defaultBranch: "main", cloneUrl: "https://github.com/op/r.git", githubInstallationId: 321 });
    const acme = await signedUp(pool, 10);
    const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId: acme.principalId });
    await assert.rejects(
      linkInstallation(pool, { state, installationId: 321, code: "c", principalId: acme.principalId, verifier: fakeInstallationVerifier({ c: [321] }) }),
      (e) => e.code === "installation_claimed" && e.status === 409,
    );
  });
});

// --- #419: repositories.manage is re-checked when the link lands --------------------------------

async function addMember(pool, organizationId, githubUserId, roleKey = "admin") {
  const { rows: org } = await pool.query("select account_id from organization where id = $1", [organizationId]);
  const { rows: person } = await pool.query(
    `insert into principal (account_id, kind, display_name, github_user_id, github_login)
     values ($1, 'user', $2, $3, $2) returning id`,
    [org[0].account_id, `user${githubUserId}`, githubUserId],
  );
  await pool.query(
    `insert into membership (organization_id, principal_id, access_role_id)
     select $1, $2, id from access_role where key = $3 and account_id is null`,
    [organizationId, person[0].id, roleKey],
  );
  return person[0].id;
}

async function linkLeftNothing(pool, installationId, repositoryId) {
  assert.equal((await pool.query("select 1 from scm_connection where installation_id = $1", [installationId])).rowCount, 0, "no claim");
  assert.equal((await pool.query("select 1 from repository_grant where repository_id = $1", [repositoryId])).rowCount, 0, "no grant");
}

const installationRepo = (pool, installationId) =>
  upsertRepository(pool, {
    owner: "acme",
    name: `repo-${installationId}`,
    defaultBranch: "main",
    cloneUrl: `https://github.com/acme/repo-${installationId}.git`,
    githubInstallationId: installationId,
  });

async function withSignupOn(fn) {
  process.env.WINDKEEL_SELF_SERVE_SIGNUP = "invite";
  try {
    return await fn();
  } finally {
    delete process.env.WINDKEEL_SELF_SERVE_SIGNUP;
  }
}

test("#419: someone removed from the organization after asking for the link cannot link", { skip }, async () => {
  await withSchema("onboarding_link_removed", (pool) =>
    withSignupOn(async () => {
      const { removeMember } = await import("../dist/factory/tenancy.js");
      const acme = await signedUp(pool, 20);
      const bob = await addMember(pool, acme.organizationId, 21);
      const repo = await installationRepo(pool, 601);
      const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId: bob });
      assert.equal(await removeMember(pool, acme.organizationId, bob), true);
      const verifier = fakeInstallationVerifier({ "code-bob": [601] });
      await assert.rejects(
        linkInstallation(pool, { state, installationId: 601, code: "code-bob", principalId: bob, verifier }),
        (e) => e.code === "permission_revoked" && e.status === 403,
      );
      await linkLeftNothing(pool, 601, repo.id);
    }),
  );
});

test("#419: someone whose role no longer holds repositories.manage cannot link; restored, the same state works", { skip }, async () => {
  await withSchema("onboarding_link_downgraded", (pool) =>
    withSignupOn(async () => {
      const { setMemberRole } = await import("../dist/factory/tenancy.js");
      const acme = await signedUp(pool, 22);
      const bob = await addMember(pool, acme.organizationId, 23);
      const repo = await installationRepo(pool, 602);
      const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId: bob });
      await setMemberRole(pool, acme.organizationId, bob, "member");
      const verifier = fakeInstallationVerifier({ "code-bob": [602] });
      const link = () => linkInstallation(pool, { state, installationId: 602, code: "code-bob", principalId: bob, verifier });
      await assert.rejects(link(), (e) => e.code === "permission_revoked" && e.status === 403);
      await linkLeftNothing(pool, 602, repo.id);
      const { rows } = await pool.query("select used_at from github_install_state");
      assert.ok(rows.every((r) => r.used_at === null), "a refusal before the state is spent does not spend it");

      await setMemberRole(pool, acme.organizationId, bob, "admin");
      assert.deepEqual(await link(), { organizationId: acme.organizationId, installationId: 602, granted: 1 });
    }),
  );
});

test("#419: a person who still holds repositories.manage links", { skip }, async () => {
  await withSchema("onboarding_link_still_admin", (pool) =>
    withSignupOn(async () => {
      const acme = await signedUp(pool, 24);
      const bob = await addMember(pool, acme.organizationId, 25);
      await installationRepo(pool, 603);
      const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId: bob });
      const verifier = fakeInstallationVerifier({ "code-bob": [603] });
      const linked = await linkInstallation(pool, { state, installationId: 603, code: "code-bob", principalId: bob, verifier });
      assert.deepEqual(linked, { organizationId: acme.organizationId, installationId: 603, granted: 1 });
    }),
  );
});

test("#419: a removal that commits while GitHub is being asked is honoured by the claim", { skip }, async () => {
  await withSchema("onboarding_link_race", (pool) =>
    withSignupOn(async () => {
      const acme = await signedUp(pool, 26);
      const bob = await addMember(pool, acme.organizationId, 27);
      const repo = await installationRepo(pool, 604);
      const { state } = await createInstallState(pool, { organizationId: acme.organizationId, principalId: bob });
      const inner = fakeInstallationVerifier({ "code-bob": [604] });
      let removal;
      const verifier = {
        async verify(input) {
          const admin = await pool.connect();
          await admin.query("begin");
          await admin.query("delete from membership where organization_id = $1 and principal_id = $2", [acme.organizationId, bob]);
          removal = new Promise((resolve, reject) => {
            setTimeout(() => {
              admin.query("commit").then(resolve, reject).finally(() => admin.release());
            }, 300);
          });
          return inner.verify(input);
        },
      };
      await assert.rejects(
        linkInstallation(pool, { state, installationId: 604, code: "code-bob", principalId: bob, verifier }),
        (e) => e.code === "permission_revoked" && e.status === 403,
      );
      await removal;
      await linkLeftNothing(pool, 604, repo.id);
    }),
  );
});

// --- through the API -------------------------------------------------------------------------

test("POST /v1/signup takes a session with no organization, and is off unless the flag says invite", { skip }, async () => {
  await withSchema("onboarding_api", async (pool) => {
    const sessions = {
      async verify(jwt) {
        const [kind, subject, id, login] = jwt.split(":");
        return kind === "session" ? { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login } : null;
      },
    };
    const deps = (selfServe) => ({
      pool,
      control: { listMessages: async () => [] },
      consoleUrl: "https://console.example",
      billing: {
        provider: new FakeBillingProvider(),
        providerName: "fake",
        pricing: DEFAULT_PRICING,
        selfServe,
        trialCredits: 150,
        githubAppSlug: "windkeel-test",
        installationVerifier: fakeInstallationVerifier({ "code-grace": [4242] }),
      },
    });
    const call = (selfServe, method, path, bearer, body) =>
      handleApiRequest(deps(selfServe), { token: "boot", subject: "operator", sessions }, {
        method,
        path,
        query: { get: () => undefined },
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        body,
      });
    const grace = "session:sub-grace:5150:grace";
    const { code } = await createSignupInvite(pool);

    assert.equal((await call("invite", "GET", "/v1/self", grace)).status, 403, "not a member yet");
    assert.equal((await call("off", "POST", "/v1/signup", grace, { inviteCode: code, organizationName: "Grace Labs" })).status, 404);
    assert.equal((await call("invite", "POST", "/v1/signup", null, { inviteCode: code, organizationName: "Grace Labs" })).status, 401);
    const created = await call("invite", "POST", "/v1/signup", grace, { inviteCode: code, organizationName: "Grace Labs", plan: "managed" });
    assert.equal(created.status, 201);
    assert.equal(created.body.trialCredits, 150);

    const self = await call("invite", "GET", "/v1/self", grace);
    assert.equal(self.status, 200);
    assert.deepEqual(self.body.organizations.map((o) => o.name), ["Grace Labs"]);
    assert.ok(self.body.organizations[0].permissions.includes("billing.manage"));
    const again = await call("invite", "POST", "/v1/signup", grace, { inviteCode: code, organizationName: "Again" });
    assert.equal(again.status, 409);

    const link = await call("invite", "POST", "/v1/github-installations/state", grace);
    assert.equal(link.status, 201);
    const state = new URL(link.body.url).searchParams.get("state");
    const linked = await call("invite", "POST", "/v1/github-installations", grace, { installationId: "4242", state, code: "code-grace" });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.organizationId, created.body.organizationId);
    const replay = await call("invite", "POST", "/v1/github-installations", grace, { installationId: 4242, state, code: "code-grace" });
    assert.deepEqual([replay.status, replay.body.code], [403, "invalid_state"]);

    const second = await call("invite", "POST", "/v1/github-installations/state", grace);
    const secondState = new URL(second.body.url).searchParams.get("state");
    await pool.query("delete from account_membership where principal_id = $1", [created.body.principalId]);
    await pool.query(
      "update membership set access_role_id = (select id from access_role where key = 'viewer' and account_id is null) where principal_id = $1",
      [created.body.principalId],
    );
    const revoked = await call("invite", "POST", "/v1/github-installations", grace, { installationId: 4242, state: secondState, code: "code-grace" });
    assert.deepEqual([revoked.status, revoked.body.code], [403, "permission_revoked"]);
  });
});
