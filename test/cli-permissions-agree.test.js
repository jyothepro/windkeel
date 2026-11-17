import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSIONS as CLI_PERMISSIONS, PRESETS as CLI_PRESETS } from "../packages/cli/dist/client/api.js";
import { PERMISSIONS as SERVER_PERMISSIONS, TOKEN_PRESETS } from "../dist/factory/tenancy/permissions.js";

test("the CLI knows exactly the permissions the server defines", () => {
  assert.deepEqual([...CLI_PERMISSIONS].sort(), [...SERVER_PERMISSIONS].sort());
});

test("the CLI presets grant exactly what the server presets grant", () => {
  assert.deepEqual(Object.keys(CLI_PRESETS).sort(), Object.keys(TOKEN_PRESETS).sort());
  for (const name of Object.keys(TOKEN_PRESETS)) {
    assert.deepEqual([...CLI_PRESETS[name]].sort(), [...TOKEN_PRESETS[name]].sort(), `preset ${name}`);
  }
});
