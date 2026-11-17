/**
 * ORQ-15: a maker sandbox reattached from a fresh process must never be sent a wildcard egress
 * policy.
 *
 * The sandbox holds the narrowed execution policy, but a handle built by `attach()` used to start
 * with no narrowing recorded, so the first `runInExecutionPhase` on it sent the brokering-only
 * shape — `{"*": allow, <model domain>: header}` — before re-narrowing. Between those two
 * `sandbox.update` calls any process the agent left running could reach any host.
 *
 * `Sandbox.get` is stubbed: the property under test is which policies this code *sends*, which
 * needs no live sandbox.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Sandbox } from "@vercel/sandbox";
import { runInExecutionPhase } from "../dist/sandbox/lifecycle.js";
import { VercelSandboxProvider } from "../dist/sandbox/vercel.js";

const updates = [];
const realGet = Sandbox.get;
const KEY_VAR = "ORQ15_TEST_MODEL_KEY";

function stubSandbox() {
  return {
    name: "windkeel-maker-reattached",
    update: async (params) => {
      updates.push(params.networkPolicy.allow);
    },
    runCommand: async () => ({ exitCode: 0, stdout: async () => "/vercel/sandbox\n", stderr: async () => "" }),
  };
}

before(() => {
  process.env[KEY_VAR] = "sk-test";
  Sandbox.get = async () => stubSandbox();
});

after(() => {
  Sandbox.get = realGet;
  delete process.env[KEY_VAR];
});

const provider = new VercelSandboxProvider({ token: "t", teamId: "team", projectId: "prj" });
const rules = [{ domain: "api.openai.com", header: "Authorization", secretEnvVar: KEY_VAR }];

test("the first execution phase on a reattached handle never sends a wildcard policy", async () => {
  updates.length = 0;
  const handle = await provider.attach({ handleId: "windkeel-maker-reattached", role: "maker" });
  const result = await runInExecutionPhase(handle, "api.openai.com", rules, "true");
  assert.equal(result.status, 0);
  assert.ok(updates.length > 0, "the phase change sends at least one policy");
  for (const allow of updates) {
    assert.ok(!("*" in allow), `a reattached handle sent a wildcard policy: ${JSON.stringify(Object.keys(allow))}`);
  }
  assert.deepEqual(Object.keys(updates.at(-1)), ["api.openai.com"]);
  assert.ok(updates.at(-1)["api.openai.com"][0].transform, "the final policy still brokers the key");
});

test("brokering alone on a reattached handle does not reopen egress", async () => {
  updates.length = 0;
  const handle = await provider.attach({ handleId: "windkeel-maker-reattached", role: "maker" });
  await handle.applyCredentialBrokerRules(rules);
  assert.equal(updates.length, 1);
  assert.ok(!("*" in updates[0]), "the create()-time wide-open shape is for create() only");
});
