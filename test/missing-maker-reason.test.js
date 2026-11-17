/**
 * What a stage says when it finds no live maker workspace (#97's run, `b1abdb0e`): "no maker
 * workspace row" only when there is none, and the row's id and status when there is one — the
 * destroyed-by-an-earlier-attempt case that the old wording sent readers to provisioning for.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makerWorkspaceOf, missingMakerReason } from "../dist/factory/workflow/handlers/provisioning.js";

const maker = (status) => ({ id: "e354f957-3b46-4221-b24c-fe27bdbeb47a", role: "maker", status });

test("no maker row at all says so", () => {
  assert.equal(
    missingMakerReason([], "there is nothing to implement in"),
    "this run has no maker workspace row, so there is nothing to implement in.",
  );
  assert.match(missingMakerReason([{ ...maker("ready"), role: "verifier" }], "x"), /no maker workspace row/);
});

test("a destroyed maker row is named, with its status, and points at the log", () => {
  const workspaces = [maker("destroyed")];
  assert.equal(makerWorkspaceOf(workspaces), undefined, "a destroyed workspace is not live");
  const reason = missingMakerReason(workspaces, "there is no repair turn to take");
  assert.match(reason, /^the maker workspace e354f957-3b46-4221-b24c-fe27bdbeb47a is destroyed, not live, so there is no repair turn to take\./);
  assert.match(reason, /"stage threw"/);
  assert.doesNotMatch(reason, /no maker workspace row/);
});
