import type { Pool, PoolClient } from "pg";
import { DEFAULT_HUMAN_CYCLES_CAP } from "./rails.js";
import { listAgentRuns } from "./repositories.js";
import type { RunState } from "./run-state-machine.js";
import { withTransaction } from "./db/transaction.js";
import { lockEngineeringRunRow } from "./stores/run-store.js";
import {
  expireRequestedTakeovers,
  incrementHumanCyclesRow,
  insertHumanSessionRow,
  queueHumanIntentRow,
  selectHumanCyclesRow,
  selectHumanSessionRow,
  selectHumanSessionRows,
  selectLiveHumanSessionRow,
  selectPendingHandbackRow,
  selectPrincipalGithubIdentityRow,
  selectTaskSessionModeRow,
  updateHumanSessionRow,
  updateTaskSessionModeRow,
} from "./stores/human-session-store.js";

type Db = Pool | PoolClient;

export function takeoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env["WINDKEEL_TAKEOVER"] ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

export type HumanSessionOrigin = "takeover" | "pair" | "make_changes";
export type HumanSessionState =
  | "requested"
  | "provisioning"
  | "ready"
  | "sleeping"
  | "submitting"
  | "handing_back"
  | "ended"
  | "failed";
export type HumanIntent = "submit" | "handback";
export type HumanSessionOutcome = "submitted" | "handed_back" | "cancelled" | "blocked" | "expired" | "failed";

export interface HumanCommit {
  sha: string;
  parentSha: string;
  kind: HumanIntent;
  at: string;
  authorEmail: string;
}

export interface HumanSession {
  id: string;
  engineeringRunId: string;
  principalId: string | null;
  actor: string;
  githubUserId: number;
  githubLogin: string;
  displayName: string | null;
  origin: HumanSessionOrigin;
  requestedFrom: RunState;
  state: HumanSessionState;
  intent: HumanIntent | null;
  intentAt: Date | null;
  seedSha: string | null;
  baseSha: string | null;
  sandboxProvider: string | null;
  sandboxName: string | null;
  workspaceOrigin: string | null;
  processBaseline: unknown;
  commits: HumanCommit[];
  pushSha: string | null;
  installNote: string | null;
  outcome: HumanSessionOutcome | null;
  error: string | null;
  chargedCpuMs: number;
  chargedEgressBytes: number;
  resumeAgentRunId: string | null;
  resumedAt: Date | null;
  requestedAt: Date;
  startedAt: Date | null;
  lastActiveAt: Date | null;
  endedAt: Date | null;
}

function rowToSession(row: Record<string, unknown>): HumanSession {
  return {
    id: row["id"] as string,
    engineeringRunId: row["engineering_run_id"] as string,
    principalId: (row["principal_id"] as string | null) ?? null,
    actor: row["actor"] as string,
    githubUserId: Number(row["github_user_id"]),
    githubLogin: row["github_login"] as string,
    displayName: (row["display_name"] as string | null) ?? null,
    origin: row["origin"] as HumanSessionOrigin,
    requestedFrom: row["requested_from"] as RunState,
    state: row["state"] as HumanSessionState,
    intent: (row["intent"] as HumanIntent | null) ?? null,
    intentAt: (row["intent_at"] as Date | null) ?? null,
    seedSha: (row["seed_sha"] as string | null) ?? null,
    baseSha: (row["base_sha"] as string | null) ?? null,
    sandboxProvider: (row["sandbox_provider"] as string | null) ?? null,
    sandboxName: (row["sandbox_name"] as string | null) ?? null,
    workspaceOrigin: (row["workspace_origin"] as string | null) ?? null,
    processBaseline: row["process_baseline"] ?? null,
    commits: (row["commits"] as HumanCommit[] | null) ?? [],
    pushSha: (row["push_sha"] as string | null) ?? null,
    installNote: (row["install_note"] as string | null) ?? null,
    outcome: (row["outcome"] as HumanSessionOutcome | null) ?? null,
    error: (row["error"] as string | null) ?? null,
    chargedCpuMs: Number(row["charged_cpu_ms"] ?? 0),
    chargedEgressBytes: Number(row["charged_egress_bytes"] ?? 0),
    resumeAgentRunId: (row["resume_agent_run_id"] as string | null) ?? null,
    resumedAt: (row["resumed_at"] as Date | null) ?? null,
    requestedAt: row["requested_at"] as Date,
    startedAt: (row["started_at"] as Date | null) ?? null,
    lastActiveAt: (row["last_active_at"] as Date | null) ?? null,
    endedAt: (row["ended_at"] as Date | null) ?? null,
  };
}

export async function liveHumanSession(db: Db, engineeringRunId: string): Promise<HumanSession | null> {
  const row = await selectLiveHumanSessionRow(db, engineeringRunId);
  return row ? rowToSession(row) : null;
}

export async function listHumanSessions(db: Db, engineeringRunId: string): Promise<HumanSession[]> {
  return (await selectHumanSessionRows(db, engineeringRunId)).map(rowToSession);
}

export async function getHumanSession(db: Db, id: string): Promise<HumanSession | null> {
  const row = await selectHumanSessionRow(db, id);
  return row ? rowToSession(row) : null;
}

export class AlreadyEditingError extends Error {
  override readonly name = "AlreadyEditingError";
}

export async function requestHumanSession(
  db: Db,
  input: {
    engineeringRunId: string;
    principalId: string | null;
    actor: string;
    githubUserId: number;
    githubLogin: string;
    displayName: string | null;
    origin: HumanSessionOrigin;
    requestedFrom: RunState;
  },
): Promise<HumanSession> {
  try {
    return rowToSession(await insertHumanSessionRow(db, input));
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new AlreadyEditingError("someone is already editing this run");
    throw error;
  }
}

const COLUMNS: Record<string, string> = {
  state: "state",
  intent: "intent",
  intentAt: "intent_at",
  seedSha: "seed_sha",
  baseSha: "base_sha",
  sandboxProvider: "sandbox_provider",
  sandboxName: "sandbox_name",
  workspaceOrigin: "workspace_origin",
  processBaseline: "process_baseline",
  outcome: "outcome",
  error: "error",
  chargedCpuMs: "charged_cpu_ms",
  chargedEgressBytes: "charged_egress_bytes",
  resumeAgentRunId: "resume_agent_run_id",
  resumedAt: "resumed_at",
  startedAt: "started_at",
  lastActiveAt: "last_active_at",
  endedAt: "ended_at",
  commits: "commits",
  pushSha: "push_sha",
  installNote: "install_note",
};

export type HumanSessionPatch = Partial<
  Pick<
    HumanSession,
    | "state"
    | "intent"
    | "intentAt"
    | "seedSha"
    | "baseSha"
    | "sandboxProvider"
    | "sandboxName"
    | "workspaceOrigin"
    | "processBaseline"
    | "outcome"
    | "error"
    | "chargedCpuMs"
    | "chargedEgressBytes"
    | "resumeAgentRunId"
    | "resumedAt"
    | "startedAt"
    | "lastActiveAt"
    | "endedAt"
    | "commits"
    | "pushSha"
    | "installNote"
  >
>;

export async function updateHumanSession(db: Db, id: string, patch: HumanSessionPatch): Promise<HumanSession> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = COLUMNS[key];
    if (!column || value === undefined) continue;
    values.push(key === "commits" || key === "processBaseline" ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return (await getHumanSession(db, id))!;
  values.push(id);
  return rowToSession(await updateHumanSessionRow(db, sets, values));
}

export async function queueHumanIntent(db: Db, sessionId: string, intent: HumanIntent): Promise<HumanSession | null> {
  const row = await queueHumanIntentRow(db, sessionId, intent);
  return row ? rowToSession(row) : null;
}

export async function pendingTakeover(db: Db, engineeringRunId: string): Promise<HumanSession | null> {
  const live = await liveHumanSession(db, engineeringRunId);
  return live && live.state === "requested" && live.origin === "takeover" ? live : null;
}

export const TAKEOVER_MISSED_BOUNDARY = "The turn ended before Windkeel could stop — take over again.";

export async function claimPendingTakeover(pool: Pool, engineeringRunId: string, seedSha: string): Promise<HumanSession | null> {
  return withTransaction(pool, async (client) => {
    await lockEngineeringRunRow(client, engineeringRunId);
    const pending = await pendingTakeover(client, engineeringRunId);
    return pending ? await updateHumanSession(client, pending.id, { seedSha, state: "provisioning" }) : null;
  });
}

export async function expireMissedTakeover(db: Db, engineeringRunId: string): Promise<number> {
  return expireRequestedTakeovers(db, engineeringRunId, TAKEOVER_MISSED_BOUNDARY);
}

export async function pendingHandback(db: Db, engineeringRunId: string): Promise<HumanSession | null> {
  const row = await selectPendingHandbackRow(db, engineeringRunId);
  return row ? rowToSession(row) : null;
}

export async function humanCycles(db: Db, engineeringRunId: string): Promise<{ used: number; cap: number }> {
  const row = await selectHumanCyclesRow(db, engineeringRunId);
  return {
    used: Number(row?.["human_cycles"] ?? 0),
    cap: Number(row?.["human_cycles_cap"] ?? DEFAULT_HUMAN_CYCLES_CAP),
  };
}

export async function incrementHumanCycles(db: Db, engineeringRunId: string): Promise<void> {
  await incrementHumanCyclesRow(db, engineeringRunId);
}

export type SessionMode = "autonomous" | "pair";

export async function taskSessionMode(
  db: Db,
  taskId: string,
): Promise<{ mode: SessionMode; pairPrincipalId: string | null }> {
  const row = await selectTaskSessionModeRow(db, taskId);
  return {
    mode: row?.["session_mode"] === "pair" ? "pair" : "autonomous",
    pairPrincipalId: (row?.["pair_principal_id"] as string | null) ?? null,
  };
}

export async function setTaskSessionMode(db: Db, taskId: string, mode: SessionMode, principalId: string | null): Promise<void> {
  await updateTaskSessionModeRow(db, taskId, mode, mode === "pair" ? principalId : null);
}

export async function principalGithubIdentity(
  db: Db,
  principalId: string,
): Promise<{ githubUserId: number; githubLogin: string; displayName: string } | null> {
  const row = await selectPrincipalGithubIdentityRow(db, principalId);
  if (!row || row["github_user_id"] === null || !row["github_login"]) return null;
  return { githubUserId: Number(row["github_user_id"]), githubLogin: row["github_login"] as string, displayName: row["display_name"] as string };
}

export interface CandidateRecord {
  sha: string;
  parentSha: string | null;
  at: Date | null;
  commitAuthor: "maker" | "person";
  provenance: "maker" | "person" | "mixed";
  maker: { harness: string; model: string } | null;
  person: { login: string | null; principalId: string | null; githubUserId: number | null } | null;
}

export async function runCandidateHistory(db: Db, engineeringRunId: string): Promise<CandidateRecord[]> {
  type Entry = Omit<CandidateRecord, "provenance">;
  const entries: Entry[] = [];
  for (const run of await listAgentRuns(db, engineeringRunId)) {
    const sha = (run.result as { candidate?: { candidateSha?: string | null } } | null)?.candidate?.candidateSha ?? null;
    if (!sha) continue;
    entries.push({
      sha,
      parentSha: null,
      at: run.completedAt ?? run.startedAt,
      commitAuthor: "maker",
      maker: { harness: run.workerType, model: run.model },
      person: null,
    });
  }
  for (const session of await listHumanSessions(db, engineeringRunId)) {
    for (const commit of session.commits) {
      entries.push({
        sha: commit.sha,
        parentSha: commit.parentSha,
        at: new Date(commit.at),
        commitAuthor: "person",
        maker: null,
        person: { login: session.githubLogin, principalId: session.principalId, githubUserId: session.githubUserId },
      });
    }
  }
  entries.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  const out: CandidateRecord[] = [];
  let maker = false;
  let person = false;
  for (const entry of entries) {
    if (out.length && out[out.length - 1]!.sha === entry.sha) continue;
    if (entry.commitAuthor === "maker") maker = true;
    else person = true;
    out.push({ ...entry, provenance: maker && person ? "mixed" : person ? "person" : "maker" });
  }
  return out;
}

export async function runCandidateShas(db: Db, engineeringRunId: string): Promise<string[]> {
  return (await runCandidateHistory(db, engineeringRunId)).map((c) => c.sha);
}
