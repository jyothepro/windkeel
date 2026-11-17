import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROUTES, matchRoute } from "../apps/ingress/dist/src/api/route.js";
import { repoRoot } from "./helpers.js";

test("every route ADR-0023 names is reachable, and the table is the only place they exist", () => {
  // The point of the assertion is not the number. It is that an endpoint cannot be added to the
  // router without appearing in this table, so "what does this API expose" has one answer.
  const named = new Set(ROUTES.map((r) => r.name));
  assert.equal(named.size, ROUTES.length, "two routes share a name");

  for (const route of ROUTES) {
    const path = route.pattern
      .replace(/:([a-zA-Z]+)/g, "11111111-1111-1111-1111-111111111111")
      .replace(/\*path/, "mapping.json");
    const match = matchRoute(route.method, path);
    assert.ok(match && "matched" in match, `${route.method} ${route.pattern} does not match itself`);
    assert.equal(match.matched.route.name, route.name);
  }
});

test("a known path with the wrong method is 405 with Allow, not 404", () => {
  const match = matchRoute("POST", "/v1/runs/abc/events");
  assert.ok(match && "methodMismatch" in match);
  assert.deepEqual(match.methodMismatch, ["GET"]);

  // Both verbs exist on /v1/runs, so the mismatch case must not fire for either.
  for (const method of ["GET", "POST"]) {
    const both = matchRoute(method, "/v1/runs");
    assert.ok(both && "matched" in both, `${method} /v1/runs should match`);
  }
});

test("an unknown path is null, so the caller can answer 404 rather than guessing", () => {
  assert.equal(matchRoute("GET", "/v1/nope"), null);
  assert.equal(matchRoute("GET", "/v2/runs"), null);
  assert.equal(matchRoute("GET", "/"), null);
});

test("an evidence file path keeps its slashes", () => {
  // attestation/bundle.json is a real spine path; a router that split on every slash would
  // address the wrong object, or none.
  const match = matchRoute("GET", "/v1/runs/run-1/evidence/attestation/bundle.json");
  assert.ok(match && "matched" in match);
  assert.equal(match.matched.route.name, "runEvidenceFile");
  assert.equal(match.matched.params.path, "attestation/bundle.json");
  assert.equal(match.matched.params.runId, "run-1");
});

test("the evidence collection and a file under it are different routes", () => {
  const collection = matchRoute("GET", "/v1/runs/r/evidence");
  assert.ok(collection && "matched" in collection);
  assert.equal(collection.matched.route.name, "runEvidence");
});

test("only liveness and the CLI's device login are public; everything else requires a credential", () => {
  // The device login's two halves run before the CLI holds any credential, which is the point of
  // them. Nothing else may join this list: a public endpoint that names what it is connected to is
  // reconnaissance.
  const publicRoutes = ROUTES.filter((r) => r.public).map((r) => r.name);
  // ADR-0037/0038 add two, each authenticated by something other than a bearer: the billing
  // webhook by its provider's signature over the raw body, and signup by a verified session (the
  // router checks it itself, because the person has no principal yet).
  assert.deepEqual(publicRoutes, ["health", "billingWebhook", "signup", "startDeviceLogin", "pollDeviceLogin"]);
});

test("every organization route declares the permission it needs", () => {
  // A route that forgot its permission would be open to any member, including a read-only token.
  for (const route of ROUTES.filter((r) => r.organization)) {
    assert.ok(route.permission, `${route.method} ${route.pattern} is scoped with no permission`);
  }
});

test("every /v1/account route is an account route with a permission, and has no organization form", () => {
  // #393: the account's audit log, roles, policy and access review need an account role (router.ts).
  const account = ROUTES.filter((r) => r.pattern.startsWith("/v1/account/"));
  assert.deepEqual(account.map((r) => r.name).sort(), [
    "accessReview",
    "accountAuditEvents",
    "accountAuditExport",
    "accountAuditVerify",
    "accountRoles",
    "createRole",
    "deleteAccountAuditEvents",
    "deleteRole",
    "securityPolicy",
    "setSecurityPolicy",
    "updateRole",
  ]);
  for (const route of account) {
    assert.equal(route.account, true, `${route.pattern} must be an account route`);
    assert.notEqual(route.organization, true, `${route.pattern} must not also be an organization route`);
    assert.ok(["audit.read", "roles.manage", "account.manage"].includes(route.permission), `${route.pattern} needs an account permission`);
  }
  assert.ok(ROUTES.filter((r) => r.account).every((r) => r.pattern.startsWith("/v1/account/")));
  assert.equal(matchRoute("GET", "/v1/orgs/org-1/account/audit-events"), null);
  const mirror = matchRoute("GET", "/v1/orgs/org-1/audit-events/export");
  assert.equal(mirror.matched.route.name, "auditExport");
  assert.equal(mirror.matched.route.permission, "audit.read");
  const role = matchRoute("PATCH", "/v1/account/roles/r-1");
  assert.deepEqual(role.matched.params, { roleId: "r-1" });
});

test("a route is reachable under /v1/orgs/{orgId}, and only organization routes are", () => {
  const scoped = matchRoute("GET", "/v1/orgs/org-1/runs/run-1/events");
  assert.ok(scoped && "matched" in scoped);
  assert.equal(scoped.matched.route.name, "runEvents");
  assert.equal(scoped.matched.params.orgId, "org-1");
  assert.equal(scoped.matched.params.runId, "run-1");

  // Tokens belong to their owner, not to an organization, so they have no scoped form.
  assert.equal(matchRoute("GET", "/v1/orgs/org-1/tokens"), null);
  assert.equal(matchRoute("GET", "/v1/orgs/org-1/self"), null);

  // Service principals belong to one organization, so they have both forms.
  const sp = matchRoute("DELETE", "/v1/orgs/org-1/service-principals/sp-1/tokens/tok-1");
  assert.ok(sp && "matched" in sp);
  assert.equal(sp.matched.route.name, "revokeServiceToken");
  assert.equal(sp.matched.route.permission, "tokens.manage");
  assert.deepEqual(sp.matched.params, { principalId: "sp-1", tokenId: "tok-1", orgId: "org-1" });
});

test("device approval, GitHub authorization and merging accept only a signed-in session", () => {
  const session = ROUTES.filter((r) => r.session).map((r) => r.name).sort();
  // #371: binding a GitHub account to a person, and merging with it, are never a token's to do.
  assert.deepEqual(session, ["approveDeviceLogin", "connectGithub", "denyDeviceLogin", "deviceLogin", "disconnectGithub", "mergeRun"]);
});

test("every write is declared a command, and no read is", () => {
  for (const route of ROUTES) {
    if (route.method !== "GET") {
      assert.equal(route.command, true, `${route.pattern} is a write but not marked a command`);
    } else {
      assert.notEqual(route.command, true, `${route.pattern} is a GET marked as a command`);
    }
  }
});

test("every route in the table is dispatched — none is left answering 501", () => {
  /*
   * Three routes shipped as `501`s with ADR-0023 §9's name in the body, which was the honest thing
   * to do at the time and is exactly the kind of placeholder that survives a milestone. This asserts
   * the router's switch covers every name in the table, so a route that is declared and not wired
   * fails here rather than in someone's terminal.
   *
   * Read out of the source rather than probed through the router, because probing would need a
   * database and a fixture per endpoint — and what is being checked is structural: is there a case
   * for this name.
   */
  const router = readFileSync(
    join(repoRoot, "apps", "ingress", "src", "api", "router.ts"),
    "utf8",
  );
  for (const route of ROUTES) {
    assert.match(
      router,
      new RegExp(`case "${route.name}":`),
      `${route.method} ${route.pattern} is in the table with no case in the router`,
    );
  }
  assert.ok(
    !/not_implemented/.test(router),
    "a route that is declared and unimplemented has to be removed from the table or built",
  );
});

test("ingress never reads the private key that opens repository secrets", () => {
  /*
   * The load-bearing assertion for ADR-0023 §9. Its guarantee — the API can accept a secret and
   * cannot read one — is a property of *which half of the key pair this process holds*, and the only
   * way to lose it is for something under `apps/ingress` to read `WINDKEEL_SECRET_PRIVATE_KEY`. That is a
   * one-line change that no test about responses would catch, because the responses would still look
   * right. So it is checked directly, across the whole app.
   *
   * `openSecret` is named too: importing it here would be the same mistake arriving by a different
   * route, and it has no use in a process with no private key.
   */
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(join(repoRoot, "apps", "ingress"));
  assert.ok(files.length > 5, "the walk found almost nothing, so it is not checking anything");

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(repoRoot.length + 1);
    /*
     * The comments in this app discuss the variable by name on purpose — saying "never set this
     * here" is half of how the rule survives — so the check is for a *read*, not a mention.
     */
    assert.ok(
      !/(process\.env\[["']WINDKEEL_SECRET_PRIVATE_KEY|process\.env\.WINDKEEL_SECRET_PRIVATE_KEY)/.test(source),
      `${relative} reads WINDKEEL_SECRET_PRIVATE_KEY; only the stage deployment may hold it`,
    );
    assert.ok(
      !/\bopenSecret\b/.test(source),
      `${relative} imports openSecret; this process is not supposed to be able to open a secret`,
    );
    /*
     * M9-2 (#320): the same rule for model credentials. Ingress seals with the public key and starts
     * a check by id; the reader, the validator and the private-key accessors belong to the stage
     * deployment, and naming any of them here would be the first step of opening a key in the
     * process that faces the internet.
     */
    for (const name of [
      "openModelCredential",
      "validateModelCredentialFromEnvironment",
      "model-credential-validation",
      "secretPrivateKeys",
      "secretPrivateKeysFromEnv",
      // #371: a person's GitHub user token. Ingress seals it and starts the merge by id; the opener
      // and the merge step that calls it belong to the stage side.
      "openGithubUserToken",
      "executeRunMerge",
      "executeRunMergeFromEnvironment",
      "user-merge",
    ]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(source), `${relative} names ${name}; only the stage deployment may`);
    }
    assert.ok(
      !/process\.env(\[["']|\.)WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY/.test(source),
      `${relative} reads WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY; only the stage deployment may hold it`,
    );
  }
});
