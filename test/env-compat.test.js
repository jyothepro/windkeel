import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptLegacyEnv } from "@windkeel/verification/env-compat.js";

test("a legacy ORQON_ variable fills its WINDKEEL_ name when that is unset", () => {
  const env = { ORQON_API_URL: "https://old.example", ORQON_API_TOKEN: "orq_old", WINDKEEL_API_TOKEN: "orq_new", PATH: "/bin" };
  assert.deepEqual(adoptLegacyEnv(env), ["WINDKEEL_API_URL"]);
  assert.equal(env.WINDKEEL_API_URL, "https://old.example");
  assert.equal(env.WINDKEEL_API_TOKEN, "orq_new", "a WINDKEEL_ value always wins");
  assert.equal(env.PATH, "/bin");
});
