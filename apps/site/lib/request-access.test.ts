import assert from "node:assert/strict";
import { test } from "node:test";
import { HONEYPOT_FIELD, LIMITS, validateAccessRequest } from "./request-access.ts";

const valid = { email: "Lead@Example.com ", company: "Acme", teamSize: "11-50", agents: "Claude Code, Codex" };

test("accepts a complete request and normalizes the email", () => {
  const result = validateAccessRequest(valid);
  assert.deepEqual(result, {
    ok: true,
    value: { email: "lead@example.com", company: "Acme", teamSize: "11-50", agents: "Claude Code, Codex" },
  });
});

test("reports every missing field", () => {
  const result = validateAccessRequest({});
  assert.equal(result.ok, false);
  assert.ok(!result.ok && !result.spam);
  if (!result.ok && !result.spam) {
    assert.deepEqual(Object.keys(result.errors).sort(), ["agents", "company", "email", "teamSize"]);
  }
});

test("rejects a malformed email and an unknown team size", () => {
  const result = validateAccessRequest({ ...valid, email: "not-an-email", teamSize: "huge" });
  assert.ok(!result.ok && !result.spam);
  if (!result.ok && !result.spam) {
    assert.match(result.errors.email ?? "", /name@company\.com/);
    assert.equal(result.errors.teamSize, "Choose your team size.");
  }
});

test("rejects values over the length limits", () => {
  const result = validateAccessRequest({
    ...valid,
    company: "a".repeat(LIMITS.company + 1),
    agents: "b".repeat(LIMITS.agents + 1),
  });
  assert.ok(!result.ok && !result.spam);
  if (!result.ok && !result.spam) {
    assert.ok(result.errors.company);
    assert.ok(result.errors.agents);
  }
});

test("flags a filled honeypot as spam", () => {
  assert.deepEqual(validateAccessRequest({ ...valid, [HONEYPOT_FIELD]: "https://spam.example" }), { ok: false, spam: true });
});

test("treats non-objects and non-string values as empty", () => {
  for (const input of [null, "text", 42, { email: 1, company: [], teamSize: {}, agents: true }]) {
    const result = validateAccessRequest(input);
    assert.ok(!result.ok && !result.spam);
  }
});
