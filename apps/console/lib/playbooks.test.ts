import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./http.ts";
import * as fixtures from "./fixtures.ts";
import {
  canManagePlaybooks,
  canReadPlaybooks,
  duplicatePlaybook,
  formDefaults,
  pickerOptions,
  playbookBadge,
  readPlaybookForm,
  savePlaybook,
  verifierLines,
  verifierSentence,
  type PlaybookInput,
  type PlaybooksApi,
} from "./playbooks.ts";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function fakeApi(): PlaybooksApi & { sent: Array<{ op: string; id?: string; input?: PlaybookInput }> } {
  const sent: Array<{ op: string; id?: string; input?: PlaybookInput }> = [];
  const base = fixtures.playbooks()[2]!;
  return {
    sent,
    list: async () => fixtures.playbooks(),
    create: async (_org, input) => (sent.push({ op: "create", input }), { ...base, ...input, slug: input.slug ?? input.from ?? base.slug, version: 1 }),
    update: async (_org, id, input) => (sent.push({ op: "update", id, input }), { ...base, ...input, version: base.version + 1 }),
    archive: async (_org, id) => void sent.push({ op: "archive", id }),
  };
}

test("the picker offers None first, then each playbook with what it adds", () => {
  const options = pickerOptions(fixtures.playbooks());
  assert.equal(options[0]!.value, "");
  assert.equal(options[0]!.label, "None");
  const dep = options.find((o) => o.value === "dependency-upgrade")!;
  assert.deepEqual(dep.criteria, ["PB1 — Lockfile is updated consistently with the manifest", "PB2 — Existing test suite passes"]);
  assert.deepEqual(dep.verifier, ["fail when the repository declares no checks", "require the security stage to run (a skip blocks)"]);
  assert.match(options.find((o) => o.value === "strict-lint")!.label, /\(yours\)/);
});

test("'Verifier will also' lines mirror the factory's words, and say nothing when nothing is added", () => {
  assert.deepEqual(
    verifierLines({
      extraChecks: [{ name: "lint-strict", command: "npm run lint" }],
      checksRequired: true,
      requireStages: ["browser"],
      extraTools: [{ package: "jq" }],
    }),
    [
      "run check playbook.lint-strict (`npm run lint`)",
      "fail when the repository declares no checks",
      "require the browser stage to run (a skip blocks)",
      "install jq",
    ],
  );
  assert.equal(verifierSentence([]), null);
  assert.equal(verifierSentence(["install jq"]), "Verifier will also: install jq.");
});

test("permission gating: read picks, manage writes", () => {
  assert.equal(canReadPlaybooks(["runs.read"]), false);
  assert.equal(canReadPlaybooks(["playbooks.read"]), true);
  assert.equal(canManagePlaybooks(["playbooks.read"]), false);
  assert.equal(canManagePlaybooks(["playbooks.manage"]), true);
});

test("the badge names slug and version, and nothing without a playbook", () => {
  assert.equal(playbookBadge({ slug: "dependency-upgrade", version: 1 }), "Playbook: dependency-upgrade v1");
  assert.equal(playbookBadge(null), null);
  assert.equal(playbookBadge(undefined), null);
});

test("the settings form reads only fields that add, and says what's wrong in words", () => {
  const read = readPlaybookForm(
    form({
      slug: "strict-lint",
      name: "Strict lint",
      kind: "custom",
      makerInstructions: "Fix every warning.",
      criteria: "- [ ] No new warnings\n\n  Second one",
      extraChecks: "lint-strict: npm run lint -- --max-warnings 0",
      checksRequired: "on",
      "require-browser": "on",
      defaultRiskLevel: "low",
    }),
  );
  assert.ok("input" in read);
  assert.deepEqual(read.input.criteria, [{ text: "No new warnings" }, { text: "Second one" }]);
  assert.deepEqual(read.input.verifier, {
    extraChecks: [{ name: "lint-strict", command: "npm run lint -- --max-warnings 0" }],
    checksRequired: true,
    requireStages: ["browser"],
  });
  assert.equal(read.input.defaultRiskLevel, "low");
  const bare = readPlaybookForm(form({ slug: "x", name: "X", makerInstructions: "Do it." }));
  assert.ok("input" in bare);
  assert.deepEqual(bare.input.verifier, {});

  assert.ok("problem" in readPlaybookForm(form({ slug: "Bad Slug", name: "X", makerInstructions: "y" })));
  assert.ok("problem" in readPlaybookForm(form({ slug: "x", name: "X", makerInstructions: "" })));
  const badCheck = readPlaybookForm(form({ slug: "x", name: "X", makerInstructions: "y", extraChecks: "../x: rm -rf" }));
  assert.ok("problem" in badCheck && /name: command/.test(badCheck.problem));
});

test("an edit keeps the flows and tools the form has no fields for; the version comes back", async () => {
  const api = fakeApi();
  const existing = { verifier: { extraTools: [{ package: "jq" }], extraFlows: [{ name: "smoke", command: "npx playwright test" }] } };
  const res = await savePlaybook(api, "org-1", "pb-1", form({ ...formDefaults(fixtures.playbooks()[2]!), checksRequired: "" } as never), existing);
  assert.equal(res.ok, true);
  const sent = api.sent[0]!;
  assert.equal(sent.op, "update");
  assert.deepEqual(sent.input!.verifier!.extraTools, [{ package: "jq" }]);
  assert.deepEqual(sent.input!.verifier!.extraFlows, [{ name: "smoke", command: "npx playwright test" }]);
  assert.match(res.ok ? (res.message ?? "") : "", /v4/);
});

test("duplicating a built-in sends from, and a refusal comes back in words", async () => {
  const api = fakeApi();
  const res = await duplicatePlaybook(api, "org-1", "dependency-upgrade");
  assert.equal(res.ok, true);
  assert.deepEqual(api.sent[0], { op: "create", input: { from: "dependency-upgrade" } });

  const refusing = { ...fakeApi(), create: async () => Promise.reject(new ApiError(409, "playbook_slug_taken", 'a playbook with slug "x" already exists')) };
  const refused = await duplicatePlaybook(refusing, "org-1", "dependency-upgrade");
  assert.equal(refused.ok, false);
});
