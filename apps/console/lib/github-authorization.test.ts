import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizeUrl, decodePending, githubWebBase, encodePending, newPendingAuthorization, outcomeMessage, returnWith, safeReturnTo, statesMatch } from "./github-authorization.ts";

test("a fresh authorization has a long random state and an S256 challenge of its verifier", () => {
  const a = newPendingAuthorization("/runs/1");
  const b = newPendingAuthorization("/runs/1");
  assert.notEqual(a.state, b.state);
  assert.ok(a.verifier.length >= 43 && a.verifier.length <= 128);
  assert.match(a.verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(a.challenge, createHash("sha256").update(a.verifier).digest("base64url"));
});

test("the authorize URL carries the client id, state and challenge — never the verifier", () => {
  const p = newPendingAuthorization("/settings/merging");
  const url = new URL(authorizeUrl({ clientId: "Iv1.test", redirectUri: "https://console.test/api/github/user-authorization/callback", state: p.state, challenge: p.challenge }));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("state"), p.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!url.toString().includes(p.verifier));
});

test("return paths stay on this console", () => {
  assert.equal(safeReturnTo("/runs/abc"), "/runs/abc");
  for (const bad of ["https://evil.test", "//evil.test", "/\\evil", "", null]) assert.equal(safeReturnTo(bad), "/settings/merging");
  assert.equal(returnWith("/runs/1?tab=evidence", "connected"), "/runs/1?tab=evidence&github=connected");
});

test("the cookie round-trips, and a mismatched or missing state is refused", () => {
  const p = newPendingAuthorization("/runs/1");
  const back = decodePending(encodePending(p));
  assert.equal(back?.state, p.state);
  assert.equal(decodePending("not-base64-json"), null);
  assert.equal(decodePending(undefined), null);
  assert.equal(statesMatch(p.state, p.state), true);
  assert.equal(statesMatch(p.state, `${p.state}x`), false);
  assert.equal(statesMatch(p.state, null), false);
});

test("each callback outcome has a sentence", () => {
  assert.equal(outcomeMessage(undefined), null);
  assert.equal(outcomeMessage("connected")?.intent, "success");
  assert.match(outcomeMessage("github_account_mismatch")?.text ?? "", /different GitHub account/);
});

test("GHES: the authorize URL is on the enterprise host, derived from the API base the code is exchanged against", () => {
  assert.equal(githubWebBase(undefined), "https://github.com");
  assert.equal(githubWebBase("https://api.github.com/"), "https://github.com");
  assert.equal(githubWebBase("https://ghes.example.com/api/v3"), "https://ghes.example.com");
  assert.equal(githubWebBase("https://api.octocorp.ghe.com"), "https://octocorp.ghe.com");
  const url = new URL(authorizeUrl({ clientId: "Iv1", redirectUri: "https://c.test/cb", state: "s", challenge: "c", webBase: githubWebBase("https://ghes.example.com/api/v3") }));
  assert.equal(url.origin + url.pathname, "https://ghes.example.com/login/oauth/authorize");
});
