import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INVITE_REQUEST_URL, PLANS, bonusPercent, inviteRequestUrl } from "./site.ts";

test("each plan's stated bonus matches its credits and price (ADR-0040 §2)", () => {
  for (const plan of PLANS) assert.equal(bonusPercent(plan), plan.bonusPercent, plan.name);
});

test("the plans are ADR-0040's four, cheapest first", () => {
  assert.deepEqual(PLANS.map((p) => [p.name, p.usdPerMonth, p.credits]), [
    ["Starter", 20, 2_000],
    ["Pro", 50, 5_250],
    ["Team", 100, 11_000],
    ["Scale", 250, 30_000],
  ]);
});

test("the invite link takes a configured https, mailto or same-site URL and nothing else", () => {
  assert.equal(inviteRequestUrl({}), DEFAULT_INVITE_REQUEST_URL);
  assert.equal(inviteRequestUrl({ NEXT_PUBLIC_INVITE_REQUEST_URL: "https://forms.example.com/w" }), "https://forms.example.com/w");
  assert.equal(inviteRequestUrl({ NEXT_PUBLIC_INVITE_REQUEST_URL: "mailto:hello@example.com" }), "mailto:hello@example.com");
  assert.equal(inviteRequestUrl({ NEXT_PUBLIC_INVITE_REQUEST_URL: "/welcome" }), "/welcome");
  assert.equal(inviteRequestUrl({ NEXT_PUBLIC_INVITE_REQUEST_URL: "javascript:alert(1)" }), DEFAULT_INVITE_REQUEST_URL);
  assert.equal(inviteRequestUrl({ NEXT_PUBLIC_INVITE_REQUEST_URL: "//evil.example" }), DEFAULT_INVITE_REQUEST_URL);
  assert.equal(inviteRequestUrl({ NEXT_PUBLIC_INVITE_REQUEST_URL: "http://plain.example" }), DEFAULT_INVITE_REQUEST_URL);
});
