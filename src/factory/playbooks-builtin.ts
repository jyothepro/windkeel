import type { Playbook } from "./playbooks.js";

export const BUILTIN_PLAYBOOKS: readonly Playbook[] = Object.freeze([
  {
    id: null,
    slug: "code-review",
    name: "Address review feedback",
    kind: "code-review",
    version: 1,
    makerInstructions: [
      "This task is review-and-fix: address the review feedback, or review the named area and fix what you find.",
      "- Work through each review point named in the description, in order.",
      "- Address each point, or decline it explicitly with the reason in your final summary.",
      "- Keep the diff focused on the points raised; no drive-by refactors or reformatting.",
    ].join("\n"),
    criteria: [{ text: "Each review point named in the description is addressed or explicitly declined" }],
    verifier: {},
    defaultRiskLevel: null,
    modelPresetId: null,
    builtin: true,
  },
  {
    id: null,
    slug: "migration",
    name: "Migration",
    kind: "migration",
    version: 1,
    makerInstructions: [
      "This task is a mechanical migration. Behaviour must stay identical.",
      "- Make the change incrementally and mechanically; do not redesign while migrating.",
      "- Update every call site; search the whole repository, not only the files named.",
      "- Do not change or delete existing tests to make them pass. If one has to change, say why.",
    ].join("\n"),
    criteria: [{ text: "No behaviour change: existing tests pass unchanged" }],
    verifier: { checksRequired: true },
    defaultRiskLevel: null,
    modelPresetId: null,
    builtin: true,
  },
  {
    id: null,
    slug: "incident-fix",
    name: "Incident fix",
    kind: "incident-fix",
    version: 1,
    makerInstructions: [
      "This task fixes an incident. Reproduce it first.",
      "- Write a failing test that reproduces the incident before changing any production code.",
      "- Make the smallest fix that makes that test pass.",
      "- State the root cause in one or two sentences in your final summary.",
    ].join("\n"),
    criteria: [{ text: "A regression test reproduces the incident and passes after the fix" }],
    verifier: { checksRequired: true },
    defaultRiskLevel: null,
    modelPresetId: null,
    builtin: true,
  },
  {
    id: null,
    slug: "test-writing",
    name: "Test writing",
    kind: "test-writing",
    version: 1,
    makerInstructions: [
      "This task adds tests.",
      "- Add tests only. Do not change production code unless a test reveals a bug; if it does, fix it and say so.",
      "- Cover the edge cases, not only the happy path: empty input, boundaries, errors.",
      "- Follow the repository's existing test layout and conventions.",
    ].join("\n"),
    criteria: [
      { text: "New tests exercise the described behaviour" },
      { text: "No production-code change unless justified in the PR body" },
    ],
    verifier: { checksRequired: true },
    defaultRiskLevel: null,
    modelPresetId: null,
    builtin: true,
  },
  {
    id: null,
    slug: "dependency-upgrade",
    name: "Dependency upgrade",
    kind: "dependency-upgrade",
    version: 1,
    makerInstructions: [
      "This task upgrades a dependency.",
      "- Upgrade only the package(s) named in the description.",
      "- Read the changelog for breaking changes between the two versions, and handle each one.",
      "- Update the lockfile with the repository's own package manager, consistently with the manifest.",
      "- Fix what the upgrade breaks. Make no unrelated changes.",
    ].join("\n"),
    criteria: [
      { text: "Lockfile is updated consistently with the manifest" },
      { text: "Existing test suite passes" },
    ],
    verifier: { checksRequired: true, requireStages: ["security"] },
    defaultRiskLevel: null,
    modelPresetId: null,
    builtin: true,
  },
] satisfies Playbook[]);

function builtinPlaybooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["WINDKEEL_PLAYBOOKS_BUILTIN"] !== "0";
}

export function builtinPlaybooks(env: NodeJS.ProcessEnv = process.env): readonly Playbook[] {
  return builtinPlaybooksEnabled(env) ? BUILTIN_PLAYBOOKS : [];
}
