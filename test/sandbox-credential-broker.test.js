import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCredentialBrokerAllowMap,
  buildPhaseAllowMap,
  CODEX_API_KEY_PLACEHOLDER,
  makerModelKeyRule,
  resolvedModelKeyRule,
} from "../dist/sandbox/credential-broker.js";

test("makerModelKeyRule returns the exact CredentialBrokerRule shape expected", () => {
  const rule = makerModelKeyRule("api.openai.com", "OPENAI_API_KEY");
  assert.deepEqual(rule, {
    domain: "api.openai.com",
    header: "Authorization",
    secretEnvVar: "OPENAI_API_KEY",
  });
});

test("CODEX_API_KEY_PLACEHOLDER is a stable, obviously-fake placeholder string", () => {
  assert.equal(CODEX_API_KEY_PLACEHOLDER, "brokered-do-not-use-directly");
});

test("buildCredentialBrokerAllowMap throws (not swallows) when the referenced secretEnvVar is unset", async () => {
  const envVar = "WINDKEEL_TEST_UNSET_CREDENTIAL_BROKER_SECRET";
  delete process.env[envVar];

  await assert.rejects(
    buildCredentialBrokerAllowMap([makerModelKeyRule("api.openai.com", envVar)]),
    /WINDKEEL_TEST_UNSET_CREDENTIAL_BROKER_SECRET is unset/,
  );
});

test("buildCredentialBrokerAllowMap injects the secret's value as the header, keeping other egress open", async () => {
  const envVar = "WINDKEEL_TEST_CREDENTIAL_BROKER_SECRET";
  process.env[envVar] = "Bearer sk-fake-test-value";
  try {
    const allow = await buildCredentialBrokerAllowMap([makerModelKeyRule("api.openai.com", envVar)]);
    assert.deepEqual(allow, {
      "*": [],
      "api.openai.com": [{ transform: [{ headers: { Authorization: "Bearer sk-fake-test-value" } }] }],
    });
  } finally {
    delete process.env[envVar];
  }
});

/**
 * The gap the tests above left, and why it survived to a live run.
 *
 * The case above stores `"Bearer sk-fake-test-value"` — a value that is already a complete
 * header — so it passed whether or not anything formed one. The real configuration cannot look
 * like that: `WINDKEEL_MODEL_KEY_ENV_VAR` names the same variable the checker gateway and
 * `windkeel doctor` read as an API key, and `Bearer sk-…` is not an API key. So the deployed maker
 * sent `Authorization: sk-…`, and OpenAI answered
 *
 *     401 Unauthorized: Missing bearer or basic authentication in header
 *
 * after a sandbox had been created and an agent had started work.
 */

test("a bare token becomes a Bearer credential", async () => {
  const envVar = "WINDKEEL_TEST_BARE_TOKEN";
  process.env[envVar] = "sk-bare-token";
  try {
    const allow = await buildCredentialBrokerAllowMap([makerModelKeyRule("api.openai.com", envVar)]);
    assert.deepEqual(allow["api.openai.com"], [
      { transform: [{ headers: { Authorization: "Bearer sk-bare-token" } }] },
    ]);
  } finally {
    delete process.env[envVar];
  }
});

test("a secret that already carries a scheme is left alone", async () => {
  const envVar = "WINDKEEL_TEST_SCHEMED_TOKEN";
  for (const value of ["Bearer sk-already", "Basic dXNlcjpwYXNz"]) {
    process.env[envVar] = value;
    try {
      const allow = await buildCredentialBrokerAllowMap([makerModelKeyRule("api.openai.com", envVar)]);
      assert.deepEqual(allow["api.openai.com"], [
        { transform: [{ headers: { Authorization: value } }] },
      ]);
    } finally {
      delete process.env[envVar];
    }
  }
});

test("a header that is not Authorization takes the secret verbatim", async () => {
  const envVar = "WINDKEEL_TEST_X_API_KEY";
  // Anthropic's shape: the secret *is* the value, and a `Bearer ` prefix would break it.
  process.env[envVar] = "sk-ant-bare";
  try {
    const allow = await buildCredentialBrokerAllowMap([
      { domain: "api.anthropic.com", header: "x-api-key", secretEnvVar: envVar },
    ]);
    assert.deepEqual(allow["api.anthropic.com"], [
      { transform: [{ headers: { "x-api-key": "sk-ant-bare" } }] },
    ]);
  } finally {
    delete process.env[envVar];
  }
});

/**
 * ADR-0026 §7: an organization's key is not in a variable on this process, so a rule can carry a
 * resolver that opens it. The value is produced at the moment a policy is built — once per build,
 * so a rotated or revoked credential takes effect at the next phase change — and the rule itself
 * never holds it.
 */
test("a resolver rule opens its secret each time a policy is built, and the rule never holds it", async () => {
  let opened = 0;
  const rule = resolvedModelKeyRule(
    "openrouter.ai",
    async () => {
      opened++;
      return "sk-or-v1-resolved-not-real";
    },
    "team-router",
  );
  assert.ok(!JSON.stringify(rule).includes("sk-or-v1"), "the rule carries a resolver, not a value");

  const allow = await buildCredentialBrokerAllowMap([rule]);
  assert.deepEqual(allow["openrouter.ai"], [
    { transform: [{ headers: { Authorization: "Bearer sk-or-v1-resolved-not-real" } }] },
  ]);
  const phase = await buildPhaseAllowMap({ mode: "allowlist", allowedDomains: ["openrouter.ai"] }, [rule]);
  assert.deepEqual(Object.keys(phase), ["openrouter.ai"]);
  assert.equal(opened, 2, "opened per build, not cached");
});

test("a resolver that opens nothing, or fails, refuses the policy rather than sending no key", async () => {
  await assert.rejects(
    buildCredentialBrokerAllowMap([resolvedModelKeyRule("openrouter.ai", async () => "", "team-router")]),
    /"team-router" opened empty/,
  );
  await assert.rejects(
    buildCredentialBrokerAllowMap([
      resolvedModelKeyRule("openrouter.ai", async () => {
        throw new Error("model credential team-router is revoked");
      }, "team-router"),
    ]),
    /revoked/,
  );
});

// --- per protocol (ADR-0027 §5, #395) ---------------------------------------------------------

test("the header is the provider's: Authorization for OpenAI-protocol providers, x-api-key for Anthropic", async () => {
  const { authHeaderFor } = await import("../dist/sandbox/credential-broker.js");
  assert.equal(authHeaderFor("openai"), "Authorization");
  assert.equal(authHeaderFor("openrouter"), "Authorization");
  assert.equal(authHeaderFor("openai-compatible"), "Authorization");
  assert.equal(authHeaderFor("anthropic"), "x-api-key");
  assert.equal(authHeaderFor(undefined), "Authorization", "unknown means today's behaviour");
  assert.deepEqual(makerModelKeyRule("api.anthropic.com", "WINDKEEL_X", "x-api-key"), {
    domain: "api.anthropic.com",
    header: "x-api-key",
    secretEnvVar: "WINDKEEL_X",
  });
});

test("an Anthropic key is injected verbatim as x-api-key for its host, and nothing else is added", async () => {
  const key = "sk-ant-api03-not-a-real-key-000000";
  const allow = await buildPhaseAllowMap(
    { mode: "allowlist", allowedDomains: ["api.anthropic.com"] },
    [resolvedModelKeyRule("api.anthropic.com", async () => key, "claude", "x-api-key")],
  );
  assert.deepEqual(allow, {
    "api.anthropic.com": [{ transform: [{ headers: { "x-api-key": key } }] }],
  });
  assert.ok(!JSON.stringify(allow).includes("Bearer"), "no Bearer prefix on a non-Authorization header");
  assert.ok(!JSON.stringify(allow).includes("Authorization"), "no Authorization header for Anthropic's host");
});

test("an OpenAI-protocol key on the same rule shape still becomes a Bearer Authorization header", async () => {
  const allow = await buildPhaseAllowMap(
    { mode: "allowlist", allowedDomains: ["openrouter.ai"] },
    [resolvedModelKeyRule("openrouter.ai", async () => "sk-or-v1-x", "router")],
  );
  assert.deepEqual(allow, { "openrouter.ai": [{ transform: [{ headers: { Authorization: "Bearer sk-or-v1-x" } }] }] });
});
