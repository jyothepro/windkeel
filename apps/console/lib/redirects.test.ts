import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicPath, notAMemberPath, safeNext, selfServeSignupOn } from "./redirects.ts";

test("after sign-in, only paths on this site are followed", () => {
  assert.equal(safeNext("/runs/abc?tab=cost"), "/runs/abc?tab=cost");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, undefined, "/\tevil"]) {
    assert.equal(safeNext(bad), "/runs", String(bad));
  }
});

test("device approval needs a session; the sign-in pages don't", () => {
  assert.ok(isPublicPath("/login"));
  assert.ok(isPublicPath("/auth/callback"));
  assert.ok(!isPublicPath("/login/device"), "approving a CLI must require a signed-in person");
  assert.ok(!isPublicPath("/runs"));
});

test("a signed-in person with no organization goes to the welcome wizard only when signup is on (ADR-0038)", () => {
  assert.equal(notAMemberPath({}), "/not-a-member");
  assert.equal(notAMemberPath({ WINDKEEL_SELF_SERVE_SIGNUP: "0" }), "/not-a-member");
  assert.equal(notAMemberPath({ WINDKEEL_SELF_SERVE_SIGNUP: "invite" }), "/welcome");
  assert.equal(notAMemberPath({ WINDKEEL_SELF_SERVE_SIGNUP: "1" }), "/welcome");
  assert.equal(selfServeSignupOn({ WINDKEEL_SELF_SERVE_SIGNUP: "open" }), false, "there is no open mode");
  assert.ok(!isPublicPath("/welcome"), "the wizard needs a signed-in person");
  assert.ok(isPublicPath("/docs") && isPublicPath("/docs/getting-started"), "the docs are readable signed out");
  assert.ok(!isPublicPath("/docsx"));
  assert.ok(isPublicPath("/home") && isPublicPath("/pricing"), "the landing and pricing pages are readable signed out");
  assert.ok(!isPublicPath("/homex") && !isPublicPath("/pricing/admin"));
});
