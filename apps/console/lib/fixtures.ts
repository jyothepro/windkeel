import type { RunState, Verdict } from "./run-states.ts";
import type {
  CandidateProvenance,
  TakeoverInfo,
  AgentStep,
  EvidenceStatus,
  RunDiff,
  StageResult,
  ApiToken,
  CostBreakdown,
  DeviceRequest,
  Invitation,
  Member,
  RepositoryGrant,
  SelfView,
  GuidanceMessage,
  RepositorySecret,
  EventPage,
  EvidenceEntry,
  Page,
  RepositorySummary,
  ReportedRepairAttempt,
  RunDetail,
  RunEvent,
  RunReport,
  RunSummary,
  Task,
  TaskRow,
  Integration,
  Schedule,
  ServicePrincipal,
  WebhookEndpoint,
  WorkspaceRead,
  MakerScreenshot,
} from "./types.ts";
import { ApiError } from "./http.ts";
import type { ModelCredential, ModelPolicyEntry, ModelPolicyLayer, ModelPreset, RunModelConfig } from "./models.ts";
import type { RepositoryEnvironment } from "./environment.ts";
import type { Playbook } from "./playbooks.ts";

const page = <T>(items: T[]): Page<T> => ({ items, endCursor: null, hasNextPage: false });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const REPO: RepositorySummary = {
  id: "repo-windkeel",
  createdAt: minutesAgo(60 * 24 * 30),
  fullName: "jyothepro/windkeel",
  defaultBranch: "main",
  openRuns: 4,
};

const REPO_DOCS: RepositorySummary = {
  id: "repo-docs",
  createdAt: minutesAgo(60 * 24 * 9),
  fullName: "jyothepro/windkeel-docs",
  defaultBranch: "main",
  openRuns: 0,
};

interface Seed {
  id: string;
  title: string;
  state: RunState;
  verdict: Verdict | null;
  age: number;
  path: RunState[];
  cost: number;
  pr?: number;
  stopReason?: string;
  provenance?: "extracted" | "generated";
}

const SEEDS: Seed[] = [
  {
    id: "7f3a2c10",
    title: "Adopt a run whose execution ended",
    state: "IMPLEMENTING",
    verdict: null,
    age: 4,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"],
    cost: 0.41,
  },
  {
    id: "b81e0d44",
    title: "Say when a signal has nothing to carry it",
    state: "REPAIRING",
    verdict: null,
    age: 22,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "REPAIRING"],
    cost: 1.87,
  },
  {
    id: "c09f5a71",
    title: "Sweep workspaces whose sandbox is gone",
    state: "WAITING_FOR_APPROVAL",
    verdict: null,
    age: 35,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL"],
    cost: 0.06,
    provenance: "generated",
  },
  {
    id: "d4417be2",
    title: "Record the human-in-the-loop half as observed",
    state: "WAITING_FOR_HUMAN",
    verdict: "pass",
    age: 70,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN"],
    cost: 2.12,
    pr: 274,
  },
  {
    id: "e6c3aa09",
    title: "Stop a criterion nothing can satisfy from failing a correct change",
    state: "COMPLETED",
    verdict: "warn",
    age: 60 * 26,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "VERIFYING", "PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN", "COMPLETED"],
    cost: 3.48,
    pr: 275,
  },
  {
    id: "f2d98c36",
    title: "Make the run feed resumable",
    state: "MAX_REPAIR_ATTEMPTS_REACHED",
    verdict: "fail",
    age: 60 * 49,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "VERIFYING", "REPAIRING", "VERIFYING", "MAX_REPAIR_ATTEMPTS_REACHED"],
    cost: 5.9,
    stopReason: "repair_cap",
  },
  {
    id: "0a5b7e18",
    title: "Browser QA for the ingress page",
    state: "CANCELLED",
    verdict: null,
    age: 60 * 72,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "CANCELLED"],
    cost: 0.18,
  },
  {
    id: "7e2b9c41",
    title: "Let a person finish the retry banner by hand",
    state: "HUMAN_EDITING",
    verdict: null,
    age: 12,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "HUMAN_EDITING"],
    cost: 0.73,
  },
  {
    id: "a3c1e5f7",
    title: "Read the scanner config from the Gate",
    state: "FAILED",
    verdict: null,
    age: 60 * 6,
    path: ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "FAILED"],
    cost: 0.92,
    stopReason: "maker_failed",
  },
];

const QUEUED: Seed = {
  id: "1c7d3f90",
  title: "Name the milestone, not its number",
  state: "CREATED",
  verdict: null,
  age: 2,
  path: ["CREATED"],
  cost: 0,
};

function summary(s: Seed): RunSummary {
  const terminal = ["COMPLETED", "CANCELLED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"].includes(s.state);
  return {
    id: s.id,
    createdAt: minutesAgo(s.age),
    taskId: `task-${s.id}`,
    taskTitle: s.title,
    repositoryId: REPO.id,
    status: s.state,
    terminal,
    finalVerdict: s.verdict,
    stopReason: s.stopReason ?? null,
    cost: s.cost,
    spendCapUsd: 10,
    startedAt: s.state === "CREATED" ? null : minutesAgo(s.age - 1),
    completedAt: terminal ? minutesAgo(Math.max(0, s.age - 30)) : null,
    prNumber: s.pr ?? null,
    prMergedAt: null,
  };
}

const CRITERIA = [
  { id: "c1", text: "A merge that lands after the execution ends moves the run to COMPLETED." },
  { id: "c2", text: "The adopted run keeps its evidence package and its cost ledger." },
  { id: "c3", text: "A test covers the late merge." },
];

function sourceOf(s: Seed): Pick<Task, "sourceType" | "sourceReference" | "sourceContext"> {
  const github = { sourceType: "github_issue", sourceReference: `jyothepro/windkeel#${260 + SEEDS.indexOf(s)}`, sourceContext: {} };
  switch (SEEDS.indexOf(s)) {
    case 1:
      return {
        sourceType: "slack",
        sourceReference: "slack:T0ACME:C0123ABCD:1790000000.000100",
        sourceContext: { teamId: "T0ACME", channelId: "C0123ABCD", threadTs: "1790000000.000100" },
      };
    case 2:
      return {
        sourceType: "linear",
        sourceReference: "linear:lin-org-1:lin-issue-142",
        sourceContext: { organizationId: "lin-org-1", issueId: "lin-issue-142", identifier: "ENG-142", url: "https://linear.app/acme/issue/ENG-142" },
      };
    case 3:
      return {
        sourceType: "jira",
        sourceReference: "jira:cloud-acme:OPS-88",
        sourceContext: { cloudId: "cloud-acme", issueKey: "OPS-88", siteUrl: "https://acme.atlassian.net" },
      };
    case 4:
      return {
        sourceType: "schedule",
        sourceReference: `schedule:sch-nightly:${minutesAgo(s.age + 1)}`,
        sourceContext: { scheduleId: "sch-nightly", slot: minutesAgo(s.age + 1) },
      };
    case 5:
      return { sourceType: "webhook", sourceReference: "webhook:whe-pagerduty:INC-1234", sourceContext: { endpointId: "whe-pagerduty" } };
    case 6:
      return { sourceType: "api", sourceReference: "api:operator", sourceContext: {} };
    default:
      return github;
  }
}

function taskOf(s: Seed): Task {
  const generated = s.provenance === "generated";
  const criteria: Task["criteria"] = {
    provenance: (generated ? "generated" : "extracted"),
    generatedBy: generated ? "anthropic/claude-sonnet-5" : null,
    approvedBy: null,
    approvedAt: null,
    items: CRITERIA,
  };
  return {
    id: `task-${s.id}`,
    repositoryId: REPO.id,
    acceptanceCriteria: criteria.items,
    criteriaProvenance: criteria.provenance,
    criteriaGeneratedBy: criteria.generatedBy,
    criteriaApprovedBy: null,
    criteriaApprovedAt: null,
    ...sourceOf(s),
    title: s.title,
    description: `${s.title}.\n\nFiled from the issue; see the linked discussion for context.`,
    riskLevel: "medium",
    priority: null,
    status: s.state === "COMPLETED" ? "done" : "in_progress",
    createdAt: minutesAgo(s.age + 1),
    updatedAt: minutesAgo(s.age),
    criteria,
  };
}

const MAKER_STEPS: AgentStep[] = [
  { type: "started" },
  { type: "thinking", text: "The adopt path runs after the execution ends, so the late merge has to be read from the pull request, not the workflow.\nI'll look at how run-service settles a merged PR first." },
  { type: "command_started", command: "rg -n \"settleMerged\" src/factory" },
  {
    type: "command_finished",
    command: "rg -n \"settleMerged\" src/factory",
    exitCode: 0,
    output: "src/factory/run-service.ts:212:export async function settleMerged(pool: Pool, run: EngineeringRun) {\nsrc/factory/run-service.ts:301:  const settled = await settleMerged(pool, run);",
  },
  { type: "file_changed", path: "src/factory/run-service.ts", kind: "update" },
  { type: "file_changed", path: "test/run-service.test.js", kind: "update" },
  { type: "test_started", command: "npm test -- test/run-service.test.js" },
  {
    type: "test_finished",
    command: "npm test -- test/run-service.test.js",
    exitCode: 0,
    passed: true,
    output: "✔ a merged pull request completes the run (14ms)\n✔ a merge after the execution ended adopts the run (9ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0",
  },
  { type: "message", text: "A merge that lands after the execution ends now moves the run to COMPLETED, and a test covers it." },
];

const REPAIR_STEPS: AgentStep[] = [
  { type: "thinking", text: "Verification says the evidence package is dropped on adoption. The fix is to carry the verification row forward." },
  { type: "file_changed", path: "src/factory/run-service.ts", kind: "update" },
  { type: "test_started", command: "npm test" },
  {
    type: "test_finished",
    command: "npm test",
    exitCode: 1,
    passed: false,
    output: "✖ a merge after the execution ended keeps its evidence (11ms)\n  AssertionError: the evidence package is kept\n      at test/run-service.test.js:97:10\nℹ tests 41\nℹ pass 40\nℹ fail 1",
  },
];

function stepsFor(to: RunState, live: boolean): AgentStep[] {
  const steps = to === "REPAIRING" ? REPAIR_STEPS : MAKER_STEPS;
  return live ? steps.slice(0, to === "REPAIRING" ? 3 : 5) : [...steps, { type: "completed" }];
}

function eventsOf(s: Seed): RunEvent[] {
  const out: RunEvent[] = [];
  let seq = 100;
  s.path.forEach((to, i) => {
    const at = minutesAgo(s.age - i * 2);
    const reason = to === "FAILED" ? `agent run 3f2a9c10-1b2c-4d5e-8f90-${s.id}0000 exited without a candidate` : null;
    if (i > 0) out.push({ kind: "transition", cursor: String(++seq), at, from: s.path[i - 1], to, reason });
    if (to === "IMPLEMENTING" || to === "REPAIRING") {
      const live = i === s.path.length - 1 && s.state === to;
      for (const event of stepsFor(to, live)) {
        out.push({ kind: "agent", cursor: String(++seq), at, agentRunId: `ar-${s.id}-${i}`, role: to === "REPAIRING" ? "repairer" : "implementer", event });
      }
    }
    if (to === "IMPLEMENTING" || to === "REPAIRING")
      out.push({ kind: "cost", cursor: String(++seq), at, usd: 0.3141, costKind: "model", stageType: to.toLowerCase() });
    if (to === "PROVISIONING")
      out.push({ kind: "cost", cursor: String(++seq), at, usd: 0.0121, costKind: "sandbox", stageType: "provisioning" });
  });
  return out;
}

function reportOf(s: Seed): RunReport {
  const task = taskOf(s);
  const verifying = s.path.filter((p) => p === "VERIFYING").length;
  const verifications = Array.from({ length: verifying }, (_, i) => {
    const last = i === verifying - 1;
    const done = last ? s.state !== "VERIFYING" : true;
    return {
      id: `ver-${s.id}-${i + 1}`,
      cycle: i + 1,
      candidateSha: `9c1e${i}a07b${s.id.slice(0, 4)}`,
      verdict: (last ? s.verdict ?? (s.state === "REPAIRING" ? "fail" : null) : "fail"),
      startedAt: minutesAgo(s.age - 8 - i * 6),
      completedAt: done ? minutesAgo(s.age - 10 - i * 6) : null,
      evidence: { state: "stored" as const, ref: `s3://evidence/${s.id}/${i + 1}`, manifestDigest: `sha256:9c1e${i}…a07b` },
      verdictOfRecord: last && done,
      superseded: !last,
      stages: done ? stagesFor((last ? s.verdict : "fail") ?? "fail", s.verdict === "warn" && last) : null,
    };
  });
  const repairs = s.path.filter((p) => p === "REPAIRING").length;
  return {
    engineeringRunId: s.id,
    task: {
      id: task.id,
      title: task.title,
      riskLevel: task.riskLevel,
      criteria: task.criteria.items,
      criteriaProvenance: task.criteria.provenance,
      criteriaGeneratedBy: task.criteria.generatedBy,
      criteriaApprovedBy: null,
      criteriaApprovedAt: null,
    },
    state: s.state,
    terminal: summary(s).terminal,
    stopReason: s.stopReason ?? null,
    stopReasonText:
      s.stopReason === "repair_cap"
        ? "The repair cap for a medium-risk task (2) was reached."
        : s.stopReason === "maker_failed"
          ? "The agent stopped before it produced a change to verify."
          : null,
    finalVerdict: s.verdict,
    startedAt: summary(s).startedAt,
    completedAt: summary(s).completedAt,
    verifications,
    repairAttempts: attemptsOf(s),
    repairAttemptsTaken: repairs,
    repairCap: 2,
    agentRuns: [
      {
        id: `ar-${s.id}`,
        role: "maker",
        workerType: "codex",
        model: "openai/gpt-5.2-codex",
        startedAt: minutesAgo(s.age - 3),
        completedAt: null,
        modelCostUsd: s.cost * 0.9,
        cachedInputShare: 0.97,
      },
    ],
    cost: {
      totalUsd: s.cost,
      modelUsd: s.cost * 0.9,
      sandboxUsd: s.cost * 0.1,
      unpricedModelCalls: 0,
      runCostUsd: s.cost,
      reconciles: true,
      spendCapUsd: 10,
    },
    criteria: { satisfied: s.verdict === "pass" ? 3 : s.verdict === "warn" ? 2 : null, total: 3 },
    incompleteStages:
      s.verdict === "warn"
        ? [{ stage: "intent", evidenceId: "ev-04", tool: "intent", detail: "“UI shows adoption” — this change has no UI." }]
        : [],
    signed: s.verdict === null ? null : s.verdict !== "fail",
    pendingSignals: [],
  };
}

function stagesFor(verdict: Verdict, intentIncomplete: boolean): StageResult[] {
  const item = (stage: StageResult["stage"], type: string, status: EvidenceStatus, summary: string) => ({ id: `ev-${stage}`, stage, type, status, summary });
  const one = (stage: StageResult["stage"], type: string, status: EvidenceStatus, summary: string): StageResult => ({
    stage,
    status,
    items: [item(stage, type, status, summary)],
  });
  return [
    one("checks", "command", verdict === "fail" ? "failed" : "passed", verdict === "fail" ? "npm test exited 1" : "npm test exited 0"),
    one("review", "model_review", verdict === "fail" ? "completed_with_findings" : "passed", verdict === "fail" ? "1 blocking finding" : "No findings"),
    one("intent", "criteria_mapping", intentIncomplete ? "warning" : "passed", intentIncomplete ? "1 criterion the evidence could not settle" : "3 of 3 criteria met"),
    one("security", "scanners", "passed", "gitleaks, semgrep: nothing found"),
    one("browser", "browser_qa", "skipped", "No browser flows configured for this repository"),
  ];
}

export function diff(id: string): RunDiff | null {
  const s = find(id);
  if (!s || !s.path.includes("VERIFYING")) return null;
  const sha = `9c1e0a07b${s.id.slice(0, 4)}`.padEnd(40, "0");
  return {
    candidateSha: sha,
    workingBranch: `windkeel/${s.id}`,
    filesChanged: ["src/factory/run-service.ts", "test/run-service.test.js"],
    truncated: false,
    candidates: [{ sha, agentRunId: `ar-${s.id}`, role: "implementer", filesChanged: 2 }],
    patch: [
      "diff --git a/src/factory/run-service.ts b/src/factory/run-service.ts",
      "index 3b1f2e0..8c4d9a1 100644",
      "--- a/src/factory/run-service.ts",
      "+++ b/src/factory/run-service.ts",
      "@@ -212,9 +212,14 @@ export async function settleMerged(pool: Pool, run: EngineeringRun) {",
      "   const pr = await pullRequestFor(pool, run.id);",
      "   if (!pr?.mergedAt) return { outcome: \"not_merged\" };",
      "-  if (TERMINAL_STATES.has(run.status)) {",
      "-    return { outcome: \"ignored\", reason: \"the run already ended\" };",
      "-  }",
      "+  // A merge can land after the execution ended: adopt it rather than discard it.",
      "+  if (run.status === \"COMPLETED\") return { outcome: \"already_completed\" };",
      "+  if (TERMINAL_STATES.has(run.status) && run.status !== \"WAITING_FOR_HUMAN\") {",
      "+    await adoptRun(pool, run.id, pr);",
      "+    return { outcome: \"adopted\" };",
      "+  }",
      "   await advanceRun(pool, run.id, \"COMPLETED\", \"pull request merged\");",
      "   return { outcome: \"completed\" };",
      " }",
      "diff --git a/test/run-service.test.js b/test/run-service.test.js",
      "index 51aa0c2..d20e7f3 100644",
      "--- a/test/run-service.test.js",
      "+++ b/test/run-service.test.js",
      "@@ -88,6 +88,17 @@ test(\"a merged pull request completes the run\", async () => {",
      "   assert.equal(run.status, \"COMPLETED\");",
      " });",
      " ",
      "+test(\"a merge after the execution ended adopts the run\", async () => {",
      "+  const run = await endedRun(pool);",
      "+  await mergePullRequest(pool, run);",
      "+  const settled = await settleMerged(pool, run);",
      "+  assert.equal(settled.outcome, \"adopted\");",
      "+  const after = await getEngineeringRun(pool, run.id);",
      "+  assert.equal(after.status, \"COMPLETED\");",
      "+  assert.ok(after.evidencePackageRef, \"the evidence package is kept\");",
      "+});",
      "+",
      "",
    ].join("\n"),
  };
}

const WORKSPACE_FILES: Record<string, string> = {
  "README.md": "# windkeel\n\nThe factory: runs, sandboxes, workers.\n",
  "package.json": '{\n  "name": "@windkeel/factory",\n  "type": "module"\n}\n',
  "src/factory/run-service.ts":
    'import type { Pool } from "pg";\n\n/** A merge can land after the execution ended: adopt it rather than discard it. */\nexport async function settleMerged(pool: Pool, run: EngineeringRun) {\n  const pr = await pullRequestFor(pool, run.id);\n  if (!pr?.mergedAt) return { outcome: "not_merged" };\n  return { outcome: "completed" };\n}\n',
  "test/run-service.test.js": 'test("a merge after the execution ended adopts the run", async () => {\n  assert.ok(true);\n});\n',
};

export function workspace(id: string, path: string): WorkspaceRead | { refused: { code: string; message: string } } {
  const s = find(id);
  const refuse = (code: string, message: string) => ({ refused: { code, message } });
  if (!s) return refuse("not_found", "no such run");
  if (s.state === "IMPLEMENTING" || s.state === "REPAIRING") return refuse("turn_running", `run is ${s.state}: the agent is mid-turn`);
  if (["COMPLETED", "CANCELLED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"].includes(s.state)) return refuse("run_terminal", `run is ${s.state}`);
  if (!s.path.includes("IMPLEMENTING")) return refuse("no_workspace", `run is ${s.state}; no maker sandbox has been made yet`);
  const clean = path.split("/").filter((p) => p && p !== ".").join("/");
  if (clean.split("/").includes("..") || path.startsWith("/")) return refuse("invalid_path", "path must be relative to the workspace root");
  const content = WORKSPACE_FILES[clean];
  if (content !== undefined) return { kind: "file", path: clean, bytes: new TextEncoder().encode(content).length, content };
  const prefix = clean ? `${clean}/` : "";
  const names = new Map<string, "file" | "directory">();
  for (const file of Object.keys(WORKSPACE_FILES)) {
    if (!file.startsWith(prefix)) continue;
    const [head, ...rest] = file.slice(prefix.length).split("/");
    names.set(head!, rest.length ? "directory" : "file");
  }
  if (names.size === 0) return refuse("not_found", `${clean}: no such file or directory in the workspace`);
  const entries = [...names].map(([name, type]) => {
    const full = `${prefix}${name}`;
    return { name, path: full, type, bytes: type === "file" ? new TextEncoder().encode(WORKSPACE_FILES[full]).length : null };
  });
  entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
  return { kind: "directory", path: clean, entries, truncated: false };
}

function attemptsOf(s: Seed): ReportedRepairAttempt[] {
  const repairs = s.path.filter((p) => p === "REPAIRING").length;
  return Array.from({ length: repairs }, (_, i) => ({
    attemptNumber: i + 1,
    triggeringVerificationId: `ver-${s.id}-${i + 1}`,
    taken: true,
    failedCriteria: ["c3"],
    failedChecks: ["npm test"],
    blockingFindings: i === 0 ? ["run-service.ts discards a late merge instead of adopting it"] : [],
  }));
}

const all = () => [...SEEDS, QUEUED];
const find = (id: string) => all().find((s) => s.id === id);

export function runs(filter: { repository?: string; status?: string; task?: string }): Page<RunSummary> {
  return page(
    [...SEEDS, QUEUED].map(summary).filter(
      (r) =>
        (!filter.repository || r.repositoryId === filter.repository) &&
        (!filter.status || r.status === filter.status) &&
        (!filter.task || r.taskId === filter.task),
    ),
  );
}

export function queue(): Page<RunSummary> {
  return page([summary(QUEUED)]);
}

export function run(id: string): RunDetail | null {
  const s = find(id);
  if (!s) return null;
  const events = eventsOf(s);
  return {
    report: reportOf(s),
    rendered: "",
    terminal: summary(s).terminal,
    cursor: events.at(-1)?.cursor ?? "0",
    modelConfig: modelConfigOf(s.id),
    takeover: takeoverOf(s),
    candidates: candidatesOf(s),
  };
}

function takeoverOf(s: Seed): TakeoverInfo {
  const editing = s.state === "HUMAN_EDITING";
  return {
    enabled: true,
    session: editing
      ? {
          id: `hs-${s.id}`,
          state: "ready",
          origin: "takeover",
          editor: { principalId: "p-you", login: "jyothepro", displayName: "Jyothidhar" },
          yours: true,
          awake: false,
          requestedAt: minutesAgo(9),
          startedAt: minutesAgo(7),
          lastActiveAt: minutesAgo(40),
          expiresAt: new Date(Date.parse(minutesAgo(7)) + 24 * 3600_000).toISOString(),
          seedSha: "4b1e09c7d2a85f3e6b0c1d9a7e2f48c3b6a5d1e0",
          intent: null,
          error: null,
          outcome: null,
          installNote: "Installed without repository secrets — private dependencies may be missing.",
          canHandBack: true,
        }
      : null,
    cycles: { used: 0, cap: 10 },
  };
}

function candidatesOf(s: Seed): CandidateProvenance[] {
  if (!s.path.includes("VERIFYING") && s.state !== "HUMAN_EDITING") return [];
  const maker = { harness: "codex", model: "gpt-5.1-codex" };
  const out: CandidateProvenance[] = [
    { sha: "4b1e09c7d2a85f3e6b0c1d9a7e2f48c3b6a5d1e0", parentSha: null, at: minutesAgo(s.age - 3), commitAuthor: "maker", provenance: "maker", maker, person: null },
  ];
  if (s.id === "e6c3aa09") {
    out.push({
      sha: "9d0f2c6e1b7a43d58e2c9f01a6b3d7e4c5f8a2b1",
      parentSha: out[0]!.sha,
      at: minutesAgo(s.age - 20),
      commitAuthor: "person",
      provenance: "mixed",
      maker: null,
      person: { login: "jyothepro", principalId: "p-you" },
    });
  }
  return out;
}

export function events(id: string): EventPage {
  const s = find(id);
  const items = s ? eventsOf(s) : [];
  return {
    items,
    endCursor: items.at(-1)?.cursor ?? null,
    hasNextPage: false,
    runStatus: s?.state ?? "CREATED",
    terminal: s ? summary(s).terminal : false,
  };
}

export function cost(id: string): CostBreakdown {
  const s = find(id);
  const total = s?.cost ?? 0;
  return {
    totalUsd: total,
    byStage: [
      { stageType: "implementing", kind: "model", usd: total * 0.6, tokensIn: 412_000, tokensOut: 18_400, events: 14 },
      { stageType: "repairing", kind: "model", usd: total * 0.3, tokensIn: 388_000, tokensOut: 9_100, events: 8 },
      { stageType: "provisioning", kind: "sandbox", usd: total * 0.1, tokensIn: null, tokensOut: null, events: 2 },
    ],
    spendCapUsd: 10,
    runRowCost: total,
  };
}

export function evidence(id: string): Page<EvidenceEntry> {
  const s = find(id);
  if (!s) return page([]);
  return page(
    reportOf(s).verifications.map((v) => ({
      verificationRunId: v.id,
      candidateSha: v.candidateSha,
      verdict: v.verdict,
      state: "stored" as const,
      prunedAt: null,
      manifestDigest: v.evidence.manifestDigest,
      files: ["manifest.json", "evidence.json", "transcripts/checks.log", "transcripts/review.md"],
    })),
  );
}

export function tasks(filter: { repository?: string }): Page<TaskRow> {
  return page(
    all()
      .map(taskOf)
      .filter((t) => !filter.repository || t.repositoryId === filter.repository)
      .map(({ criteria: _lifted, ...row }) => row),
  );
}

export function task(id: string): Task | null {
  const s = all().find((x) => `task-${x.id}` === id);
  return s ? taskOf(s) : null;
}

export function repositories(): Page<RepositorySummary> {
  return page([REPO, REPO_DOCS]);
}

export function messages(id: string): Page<GuidanceMessage> {
  if (id !== "b81e0d44") return page([]);
  return page([
    {
      id: "g1",
      cursor: "1",
      at: minutesAgo(12),
      actor: "operator",
      message: "Keep the fix inside run-service.ts; don't touch the state machine.",
      state: "delivered",
      deliveredAt: minutesAgo(10),
      undeliverableReason: null,
      deliveryAttempts: 1,
    },
    {
      id: "g2",
      cursor: "2",
      at: minutesAgo(1),
      actor: "operator",
      message: "Add the regression test before changing the handler.",
      state: "queued",
      deliveredAt: null,
      undeliverableReason: null,
      deliveryAttempts: 0,
    },
  ]);
}

export function secrets(repositoryId: string): Page<RepositorySecret> {
  if (repositoryId !== REPO.id) return page([]);
  return page([
    { key: "NPM_TOKEN", note: "read-only, rotates 2027-01", setBy: "operator", createdAt: minutesAgo(60 * 24 * 3), updatedAt: minutesAgo(60 * 24 * 3) },
  ]);
}

export function environment(repositoryId: string): RepositoryEnvironment {
  if (repositoryId !== REPO.id) return { items: [], current: null, pendingRequest: null, proposedSetup: null };
  const ready = {
    id: "7e1a9c40-0000-4000-8000-000000000001",
    status: "ready" as const,
    sandboxProvider: "vercel",
    cacheKey: "3f9c2a7be1d04c55a6e2f7b81c0d9e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d",
    baseSha: "9d2f0c4a7be1d04c55a6e2f7b81c0d9e4f3a2b1c",
    sizeBytes: 812_000_000,
    detail: "package-lock.json → npm ci (with repository secrets: NPM_TOKEN); setup ran bootstrap; secret scan clean over 1 secret(s)",
    setupLogRef: null,
    builtBy: "system",
    createdAt: minutesAgo(60 * 26),
    readyAt: minutesAgo(60 * 25),
    expiresAt: minutesAgo(-60 * 24 * 13),
    lastUsedAt: minutesAgo(40),
  };
  return {
    items: [
      ready,
      {
        ...ready,
        id: "7e1a9c40-0000-4000-8000-000000000002",
        status: "failed" as const,
        sizeBytes: null,
        detail: "a repository secret's value was found on disk after setup: NPM_TOKEN in .npmrc",
        createdAt: minutesAgo(60 * 50),
        readyAt: null,
        expiresAt: null,
        lastUsedAt: null,
      },
    ],
    current: ready,
    pendingRequest: null,
    proposedSetup: {
      setup: { commands: [{ name: "bootstrap", run: "make bootstrap", timeoutSec: 900 }], services: [], secrets: [], egress: [], cacheKeyFiles: ["Makefile"] },
      reasons: ["Makefile has a `bootstrap` target: suggested `make bootstrap` as a setup command"],
    },
  };
}

export function metrics(): Record<string, unknown> {
  return {
    runs_by_outcome: { completed: 12, failed: 3, cancelled: 2, max_repair_attempts_reached: 1 },
    first_pass_verification_rate: 0.58,
    median_repair_attempts: 1,
    median_cost_usd: 2.12,
    human_commits_after_pr: null,
  };
}

const ALL_PERMISSIONS = ["runs.read", "runs.write", "runs.approve", "secrets.manage", "repositories.manage", "members.manage", "tokens.manage", "integrations.manage", "schedules.manage", "models.read", "models.manage", "runs.takeover", "playbooks.read", "playbooks.manage", "batches.manage"];

export function self(): SelfView {
  return {
    principal: { id: "p-you", kind: "user", displayName: "Jyothidhar", githubLogin: "jyothepro" },
    account: { id: "acct-1", name: "jyothepro" },
    organizations: [
      { id: "org-platform", name: "Platform", role: "Admin", permissions: ALL_PERMISSIONS },
      { id: "org-product", name: "Product", role: "Member", permissions: ["runs.read", "runs.write", "runs.approve", "models.read", "runs.takeover", "playbooks.read"] },
    ],
    token: null,
    subject: "jyothepro",
    scopes: [],
    features: { takeover: true },
  };
}

export function tokens(): ApiToken[] {
  return [
    {
      id: "tok-1",
      name: "jy-macbook (windkeel login)",
      prefix: "orq_7Hk2",
      organizationId: null,
      permissions: ["runs.read", "runs.write", "runs.approve", "secrets.manage"],
      ownerPrincipalId: "p-you",
      createdBy: "jyothepro",
      createdAt: minutesAgo(60 * 24 * 12),
      lastUsedAt: minutesAgo(40),
      expiresAt: null,
      revokedAt: null,
    },
    {
      id: "tok-2",
      name: "old laptop",
      prefix: "orq_Qa9x",
      organizationId: null,
      permissions: null,
      ownerPrincipalId: "p-you",
      createdBy: "jyothepro",
      createdAt: minutesAgo(60 * 24 * 90),
      lastUsedAt: minutesAgo(60 * 24 * 60),
      expiresAt: null,
      revokedAt: minutesAgo(60 * 24 * 30),
    },
  ];
}

export function members(): Member[] {
  return [
    { principalId: "p-you", displayName: "Jyothidhar", githubLogin: "jyothepro", role: "admin", createdAt: minutesAgo(60 * 24 * 30) },
    { principalId: "p-2", displayName: "Priya", githubLogin: "priya-dev", role: "member", createdAt: minutesAgo(60 * 24 * 8) },
    { principalId: "p-3", displayName: "Sam", githubLogin: "samk", role: "viewer", createdAt: minutesAgo(60 * 24 * 2) },
  ];
}

export function invitations(): Invitation[] {
  return [{ id: "inv-1", githubLogin: "alexr", role: "member", invitedBy: "p-you", invitedByName: "jyothepro", createdAt: minutesAgo(60 * 5), expiresAt: minutesAgo(-60 * 24 * 7), acceptedAt: null }];
}

export function grants(): RepositoryGrant[] {
  return [
    { repositoryId: REPO.id, fullName: REPO.fullName, intake: true, createdAt: minutesAgo(60 * 24 * 30) },
    { repositoryId: REPO_DOCS.id, fullName: REPO_DOCS.fullName, intake: false, createdAt: minutesAgo(60 * 24 * 9) },
  ];
}

export function deviceRequest(userCode: string): DeviceRequest | null {
  const code = userCode.toUpperCase();
  if (code !== "WDJB-MJHT" && code !== "ADMN-2F9Q") return null;
  const admin = code === "ADMN-2F9Q";
  return {
    userCode: code,
    machineName: "jy-macbook",
    requestedPermissions: admin ? ALL_PERMISSIONS : ["runs.read", "runs.write", "runs.approve", "secrets.manage"],
    admin,
    expiresAt: minutesAgo(-8),
    state: "pending",
  };
}

export function integrations(): Integration[] {
  return [
    {
      id: "int-slack",
      provider: "slack",
      installationId: "icfg_slack_7Hk2",
      externalTenantId: "T0ACME",
      externalTenantName: "Acme",
      status: "active",
      createdByPrincipalId: "p-you",
      createdAt: minutesAgo(60 * 24 * 6),
      disconnectedAt: null,
      routes: [
        { id: "rt-slack-default", scopeKind: "default", scopeValue: null, repositoryId: REPO.id, triggerLabel: "orqon", enabled: true, createdAt: minutesAgo(60 * 24 * 6) },
        { id: "rt-slack-docs", scopeKind: "slack_channel", scopeValue: "C0DOCS9", repositoryId: REPO_DOCS.id, triggerLabel: "orqon", enabled: false, createdAt: minutesAgo(60 * 24 * 2) },
      ],
    },
    {
      id: "int-linear",
      provider: "linear",
      installationId: "icfg_linear_Qa9x",
      externalTenantId: "lin-org-1",
      externalTenantName: "Acme Engineering",
      status: "active",
      createdByPrincipalId: "p-2",
      createdAt: minutesAgo(60 * 24 * 4),
      disconnectedAt: null,
      routes: [{ id: "rt-linear-eng", scopeKind: "linear_team", scopeValue: "ENG", repositoryId: REPO.id, triggerLabel: "orqon", enabled: true, createdAt: minutesAgo(60 * 24 * 4) }],
    },
    {
      id: "int-jira",
      provider: "jira",
      installationId: "icfg_jira_3Lm0",
      externalTenantId: "cloud-acme",
      externalTenantName: "acme.atlassian.net",
      status: "disconnected",
      createdByPrincipalId: "p-you",
      createdAt: minutesAgo(60 * 24 * 20),
      disconnectedAt: minutesAgo(60 * 24 * 3),
      routes: [],
    },
  ];
}

export function schedules(): Page<Schedule> {
  const base = { spendCapUsd: null, wallClockCapSeconds: null, createdByPrincipalId: "p-you", updatedAt: minutesAgo(60 * 24) };
  const nightly = previewTimes("0 3 * * *", "America/Los_Angeles", 3);
  return page([
    {
      ...base,
      id: "sch-nightly",
      name: "Nightly dependency bump",
      repositoryId: REPO.id,
      cron: "0 3 * * *",
      timezone: "America/Los_Angeles",
      title: "Bump patch-level dependencies",
      description: "Update every dependency to its newest patch release.\n\n- [ ] npm test passes\n- [ ] the lockfile changes only patch versions",
      riskLevel: "low",
      enabled: true,
      nextFireAt: nightly[0]!,
      nextFireTimes: nightly,
      lastFiredAt: minutesAgo(60 * 26),
      lastOutcome: "created",
      createdAt: minutesAgo(60 * 24 * 14),
    },
    {
      ...base,
      id: "sch-flaky",
      name: "Weekly flaky-test sweep",
      repositoryId: REPO.id,
      cron: "30 9 * * 1",
      timezone: "UTC",
      title: "Quarantine tests that failed intermittently this week",
      description: "- [ ] every test that failed and then passed on retry is listed in the PR",
      riskLevel: "medium",
      enabled: false,
      nextFireAt: previewTimes("30 9 * * 1", "UTC", 1)[0]!,
      nextFireTimes: [],
      lastFiredAt: minutesAgo(60 * 24 * 5),
      lastOutcome: "ignored:previous_run_in_flight",
      createdAt: minutesAgo(60 * 24 * 30),
    },
  ]);
}

export function webhookEndpoints(): WebhookEndpoint[] {
  return [
    {
      id: "whe-pagerduty",
      name: "pagerduty",
      repositoryId: REPO.id,
      enabled: true,
      defaultRiskLevel: "medium",
      secretVersion: 2,
      path: "/api/intake/webhook/whe-pagerduty",
      createdAt: minutesAgo(60 * 24 * 10),
      rotatedAt: minutesAgo(60 * 24 * 2),
    },
    {
      id: "whe-ci",
      name: "nightly CI failures",
      repositoryId: REPO_DOCS.id,
      enabled: false,
      defaultRiskLevel: "low",
      secretVersion: 1,
      path: "/api/intake/webhook/whe-ci",
      createdAt: minutesAgo(60 * 24 * 3),
      rotatedAt: null,
    },
  ];
}

export function servicePrincipals(): ServicePrincipal[] {
  const sp = (id: string, displayName: string, role: string, systemPurpose: string | null, days: number): ServicePrincipal => ({
    id,
    kind: "service",
    organizationId: "org-platform",
    displayName,
    role,
    permissions: role === "admin" ? ALL_PERMISSIONS : ["runs.read", "runs.write", "runs.approve"],
    system: systemPurpose !== null,
    systemPurpose,
    createdAt: minutesAgo(60 * 24 * days),
    deactivatedAt: null,
  });
  return [
    sp("sp-ci", "release-ci", "member", null, 12),
    sp("sp-sched", "Schedules", "member", "schedule", 14),
    sp("sp-webhook", "Webhook intake", "member", "webhook", 10),
    sp("sp-linear", "Linear intake", "member", "linear", 4),
  ];
}

export function serviceTokens(principalId: string): ApiToken[] {
  if (principalId !== "sp-ci") return [];
  return [
    {
      id: "stok-1",
      name: "GitHub Actions",
      prefix: "orq_Zp4c",
      organizationId: "org-platform",
      permissions: ["runs.read", "runs.write"],
      ownerPrincipalId: "sp-ci",
      createdBy: "jyothepro",
      createdAt: minutesAgo(60 * 24 * 12),
      lastUsedAt: minutesAgo(90),
      expiresAt: minutesAgo(-60 * 24 * 78),
      revokedAt: null,
    },
  ];
}

export function sampleSecret(prefix: "whsec_" | "orq_"): string {
  return `${prefix}SAMPLE_not_a_real_secret_${Math.random().toString(36).slice(2, 10)}`;
}

function cronField(spec: string, min: number, max: number): Set<number> | null {
  if (spec === "*") return null;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new ApiError(422, "invalid_cron", `Sample data reads numeric cron fields only; “${spec}” isn't one.`);
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    const step = m[4] ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new ApiError(422, "invalid_cron", `“${part}” is out of range (${min}–${max}).`);
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export function previewTimes(cron: string, timezone: string, count: number): string[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new ApiError(422, "invalid_cron", "A cron expression has five fields: minute hour day-of-month month day-of-week.");
  const [minute, hour, dom, month, dow] = [
    cronField(fields[0]!, 0, 59),
    cronField(fields[1]!, 0, 23),
    cronField(fields[2]!, 1, 31),
    cronField(fields[3]!, 1, 12),
    cronField(fields[4]!, 0, 7),
  ];
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  } catch {
    throw new ApiError(422, "invalid_timezone", `“${timezone}” isn't an IANA time zone.`);
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const has = (set: Set<number> | null, v: number) => set === null || set.has(v);
  const out: string[] = [];
  let t = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
  for (let i = 0; i < 35 * 24 * 60 && out.length < count; i++, t += 60_000) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const wd = days.indexOf(p["weekday"]!);
    const dayOk = dom !== null && dow !== null ? dom.has(Number(p["day"])) || dow.has(wd) : has(dom, Number(p["day"])) && has(dow, wd);
    if (has(minute, Number(p["minute"])) && has(hour, Number(p["hour"])) && has(month, Number(p["month"])) && dayOk) out.push(new Date(t).toISOString());
  }
  if (out.length === 0) throw new ApiError(422, "invalid_cron", `“${cron}” doesn't fire in the next 35 days (sample data looks no further).`);
  return out;
}

const CRED_ROUTER = "5b0c2a3e-8f1d-4c7a-9e6b-2d4f8a1c3e70";
const CRED_OPENAI = "9e7d6c5b-4a3f-4e2d-8c1b-0a9f8e7d6c5b";
const CRED_VLLM = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";

export function modelCredentials(): ModelCredential[] {
  const base = { keypairId: "kp_7Hk2", createdByPrincipalId: "p-you", revokedAt: null, declaredVendor: null, baseUrl: null };
  return [
    { ...base, id: CRED_OPENAI, provider: "openai", label: "prod", last4: "x9Qa", status: "valid", statusReason: null, validatedAt: minutesAgo(60 * 24 * 3), createdAt: minutesAgo(60 * 24 * 3), updatedAt: minutesAgo(60 * 24 * 3) },
    { ...base, id: CRED_ROUTER, provider: "openrouter", label: "router", last4: "f00d", status: "unverified", statusReason: null, validatedAt: null, createdAt: minutesAgo(1), updatedAt: minutesAgo(1) },
    {
      ...base,
      id: CRED_VLLM,
      provider: "openai-compatible",
      baseUrl: "https://llm.acme.dev/v1",
      declaredVendor: "meta",
      label: "vllm",
      last4: "3kQz",
      status: "invalid",
      statusReason: "the provider refused the key (HTTP 401 from GET /models)",
      validatedAt: minutesAgo(60 * 5),
      createdAt: minutesAgo(60 * 24),
      updatedAt: minutesAgo(60 * 5),
    },
  ];
}

const policyRow = (fields: Omit<ModelPolicyEntry, "id" | "keySource" | "updatedByPrincipalId" | "createdAt" | "updatedAt">): ModelPolicyEntry => ({
  ...fields,
  id: `pol-${fields.repositoryId ?? "org"}-${fields.role}`,
  keySource: fields.credentialId ? "customer" : "orqon",
  updatedByPrincipalId: "p-you",
  createdAt: minutesAgo(60 * 24 * 2),
  updatedAt: minutesAgo(60 * 24 * 2),
});

export function modelPolicy(repositoryId: string | null = null): ModelPolicyLayer {
  const org = [
    policyRow({ repositoryId: null, role: "maker", provider: "openai", model: "gpt-5-codex", credentialId: CRED_OPENAI, declaredVendor: null }),
    policyRow({ repositoryId: null, role: "checker", provider: "openrouter", model: "anthropic/claude-sonnet-4.5", credentialId: CRED_ROUTER, declaredVendor: null }),
  ];
  const docs = [policyRow({ repositoryId: REPO_DOCS.id, role: "maker", provider: "openai", model: "gpt-5-mini", credentialId: null, declaredVendor: null })];
  return {
    repositoryId,
    items: repositoryId === REPO_DOCS.id ? [...org, ...docs] : org,
    presets: modelPresets(),
    harnesses: [{ id: "codex", label: "OpenAI's Codex CLI", default: true }],
  };
}

export function modelPresets(): ModelPreset[] {
  const at = minutesAgo(60 * 24);
  return [
    {
      id: "7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      name: "Fast",
      harness: null,
      maker: { model: "gpt-5-mini", provider: "openai", credentialId: null },
      checker: [{ model: "anthropic/claude-sonnet-4.5", credentialId: CRED_ROUTER }],
      createdByPrincipalId: "p-you",
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "8e2f3041-5b6c-4d7e-9f0a-1b2c3d4e5f60",
      name: "Thorough",
      harness: "codex",
      maker: { model: "gpt-5-codex", credentialId: CRED_OPENAI },
      checker: [{ model: "claude-opus-4-1", provider: "anthropic", credentialId: null }],
      createdByPrincipalId: "p-you",
      createdAt: at,
      updatedAt: at,
    },
  ];
}

function modelConfigOf(runId: string): RunModelConfig | null {
  if (runId !== "7f3a2c10") return null;
  return {
    version: 1,
    maker: { provider: "openai", vendor: "openai", model: "gpt-5-codex", credentialId: CRED_OPENAI, credentialLabel: "prod", keySource: "customer", source: "organization", worker: "codex" },
    checker: [
      { provider: "openrouter", vendor: "anthropic", model: "anthropic/claude-sonnet-4.5", credentialId: CRED_ROUTER, credentialLabel: "router", keySource: "customer", source: "organization" },
      { provider: "anthropic", vendor: "anthropic", model: "claude-opus-4-1", keySource: "orqon", source: "operator" },
    ],
    resolvedAt: minutesAgo(30),
    policyIds: ["pol-org-maker", "pol-org-checker"],
  };
}

export function playbooks(): Playbook[] {
  return [
    {
      id: null,
      slug: "dependency-upgrade",
      name: "Dependency upgrade",
      kind: "dependency-upgrade",
      version: 1,
      builtin: true,
      makerInstructions: "This task upgrades a dependency.\n- Upgrade only the package(s) named in the description.",
      criteria: [{ text: "Lockfile is updated consistently with the manifest" }, { text: "Existing test suite passes" }],
      verifier: { checksRequired: true, requireStages: ["security"] },
      defaultRiskLevel: null,
      modelPresetId: null,
      verifierAdds: ["fail when the repository declares no checks", "require the security stage to run (a skip blocks)"],
      addedCriteria: [
        { id: "PB1", text: "Lockfile is updated consistently with the manifest" },
        { id: "PB2", text: "Existing test suite passes" },
      ],
    },
    {
      id: null,
      slug: "test-writing",
      name: "Test writing",
      kind: "test-writing",
      version: 1,
      builtin: true,
      makerInstructions: "This task adds tests.\n- Add tests only.",
      criteria: [{ text: "New tests exercise the described behaviour" }],
      verifier: { checksRequired: true },
      defaultRiskLevel: null,
      modelPresetId: null,
      verifierAdds: ["fail when the repository declares no checks"],
      addedCriteria: [{ id: "PB1", text: "New tests exercise the described behaviour" }],
    },
    {
      id: "pb-lint-strict",
      slug: "strict-lint",
      name: "Strict lint",
      kind: "custom",
      version: 3,
      builtin: false,
      makerInstructions: "Fix every lint warning you touch.",
      criteria: [],
      verifier: { extraChecks: [{ name: "lint-strict", command: "npm run lint -- --max-warnings 0" }] },
      defaultRiskLevel: "low",
      modelPresetId: null,
      verifierAdds: ["run check playbook.lint-strict (`npm run lint -- --max-warnings 0`)"],
      addedCriteria: [],
    },
  ];
}

export function screenshots(_id: string): MakerScreenshot[] {
  return [];
}
