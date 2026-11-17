import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKSPACE_TABS, workspaceHref, workspaceTab, workspaceTarget } from "./session.ts";

test("with no tab, a run waiting for approval opens on its criteria, any other on its changes", () => {
  assert.deepEqual(workspaceTab({}, "WAITING_FOR_APPROVAL"), { tab: "criteria", view: "verifications" });
  assert.deepEqual(workspaceTab({}, "IMPLEMENTING"), { tab: "changes", view: "verifications" });
  assert.deepEqual(workspaceTab({ tab: "nonsense" }, "COMPLETED"), { tab: "changes", view: "verifications" });
});

test("the evidence panel's old ?tab= links land on Evidence, on the view they named", () => {
  assert.deepEqual(workspaceTab({ tab: "cost" }, "COMPLETED"), { tab: "evidence", view: "cost" });
  assert.deepEqual(workspaceTab({ tab: "evidence", view: "attempts" }, "COMPLETED"), { tab: "evidence", view: "attempts" });
});

test("tab links are always explicit, and the default evidence view isn't spelled out", () => {
  assert.equal(workspaceHref("r1", "changes"), "/runs/r1?tab=changes");
  assert.equal(workspaceHref("r1", "evidence", "verifications"), "/runs/r1?tab=evidence");
  assert.equal(workspaceHref("r1", "evidence", "cost"), "/runs/r1?tab=evidence&view=cost");
  assert.equal(workspaceHref("../x", "progress"), "/runs/..%2Fx?tab=progress");
});

test("phase 3's tabs sit beside Changes, and carry a path or a turn in the URL", () => {
  assert.deepEqual(WORKSPACE_TABS.map(([k]) => k), ["changes", "terminal", "files", "browser", "criteria", "evidence", "progress"]);
  assert.deepEqual(workspaceTab({ tab: "files" }, "VERIFYING"), { tab: "files", view: "verifications" });
  assert.equal(workspaceHref("r1", "files", undefined, { path: "src/a b.ts" }), "/runs/r1?tab=files&path=src%2Fa+b.ts");
  assert.equal(workspaceHref("r1", "files"), "/runs/r1?tab=files");
  assert.equal(workspaceHref("r1", "changes", undefined, { turn: "ar-1" }), "/runs/r1?tab=changes&turn=ar-1");
  assert.equal(workspaceHref("r1", "terminal", undefined, { path: "x", turn: "y" }), "/runs/r1?tab=terminal", "a target only rides on its own tab");
  assert.deepEqual(workspaceTarget({}), { path: "", turn: null });
  assert.deepEqual(workspaceTarget({ path: ["a", "b"], turn: " " }), { path: "a", turn: null });
  assert.deepEqual(workspaceTarget({ path: "src", turn: "ar-2" }), { path: "src", turn: "ar-2" });
});
