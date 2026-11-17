import * as fixtures from "./fixtures.ts";
import type { TaskModels } from "./models.ts";
import { ApiError } from "./http.ts";
import { sliceTail } from "./feed.ts";
import { collectPages, mergeRuns } from "./run-pages.ts";
import type { MergeEligibility, MergingSettings } from "./merge.ts";
import type { RepositoryEnvironment } from "./environment.ts";
import type { BatchDetail, BatchView } from "./batches.ts";
import type {
  Accepted,
  CostBreakdown,
  GuidanceMessage,
  RepositorySecret,
  EvidenceEntry,
  EventPage,
  EventTail,
  Page,
  RunEvent,
  RepositorySummary,
  RunDetail,
  RunDiff,
  RunSummary,
  Self,
  Task,
  TaskRow,
  WorkspaceRead,
  MakerScreenshot,
} from "./types.ts";
import {
  apiAuth,
  fixtureRefusal,
  getIdentity,
  live,
  query,
  request,
  sampleOnly,
  slot,
} from "./api-transport.ts";

export async function listRuns(
  filter: { repository?: string; status?: string; task?: string; cursor?: string; limit?: string } = {},
): Promise<Page<RunSummary>> {
  return live() ? request("GET", `/runs${query(filter)}`) : fixtures.runs(filter);
}

export async function listQueue(): Promise<Page<RunSummary>> {
  return live() ? request("GET", "/queue") : fixtures.queue();
}

const WAITING_ON_A_PERSON = ["WAITING_FOR_APPROVAL", "BLOCKED", "PR_READY", "WAITING_FOR_HUMAN", "HUMAN_EDITING"];

export async function listInboxRuns(): Promise<RunSummary[]> {

  const pages = await Promise.all([listRuns(), ...(live() ? [listRuns({ status: WAITING_ON_A_PERSON.join(",") })] : [])]);
  return mergeRuns(pages.map((p) => p.items));
}

const FAILED_STATES = ["FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"];

const FAILED_PAGE_SIZE = 200;
const FAILED_MAX_PAGES = 5;

export async function listInboxRunsWithFailed(): Promise<{ runs: RunSummary[]; failedTruncated: boolean }> {
  const [inbox, failed] = await Promise.all([
    listInboxRuns(),
    live()
      ? collectPages((cursor) => listRuns({ status: FAILED_STATES.join(","), limit: String(FAILED_PAGE_SIZE), cursor }), FAILED_MAX_PAGES)
      : { items: [], truncated: false },
  ]);
  return { runs: mergeRuns([inbox, failed.items]), failedTruncated: failed.truncated };
}

export async function getRun(id: string): Promise<RunDetail | null> {
  if (!live()) return fixtures.run(id);
  try {
    return await request("GET", `/runs/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getRunEvents(id: string, after?: string, limit?: number): Promise<EventPage> {
  return live()
    ? request("GET", `/runs/${encodeURIComponent(id)}/events${query({ after, limit: limit ? String(limit) : undefined })}`)
    : fixtures.events(id);
}

const FEED_PAGE = 200;

const FEED_MAX_PAGES = 25;

export const FEED_TAIL = 100;

export async function getRunEventsTail(id: string, before?: string, limit = FEED_TAIL): Promise<EventTail> {
  if (!live()) return sliceTail(fixtures.events(id).items, before, limit);
  const page = await request<EventTail | EventPage>("GET", `/runs/${encodeURIComponent(id)}/events${query({ last: String(limit), before })}`);
  if ("startCursor" in page) return page;

  return sliceTail(await legacyAllRunEvents(id), before, limit);
}

export async function getRunTransitions(id: string): Promise<RunEvent[]> {
  if (!live()) return fixtures.events(id).items.filter((e) => e.kind === "transition");
  const page = await request<EventPage>("GET", `/runs/${encodeURIComponent(id)}/events${query({ kind: "transition", limit: String(FEED_PAGE) })}`);
  return page.items.filter((e) => e.kind === "transition");
}

export const AGENT_TAIL = 200;

export async function getRunAgentEvents(id: string): Promise<RunEvent[]> {
  if (!live()) return fixtures.events(id).items.filter((e) => e.kind === "agent");
  const page = await request<EventTail | EventPage>("GET", `/runs/${encodeURIComponent(id)}/events${query({ kind: "agent", last: String(AGENT_TAIL) })}`);
  return page.items.filter((e) => e.kind === "agent");
}

async function legacyAllRunEvents(id: string): Promise<RunEvent[]> {
  let page = await getRunEvents(id, undefined, FEED_PAGE);
  const items = [...page.items];
  for (let n = 1; page.hasNextPage && page.endCursor && n < FEED_MAX_PAGES; n++) {
    page = await getRunEvents(id, page.endCursor, FEED_PAGE);
    items.push(...page.items);
  }
  return items;
}

export async function getRunCost(id: string): Promise<CostBreakdown> {
  return live() ? request("GET", `/runs/${encodeURIComponent(id)}/cost`) : fixtures.cost(id);
}

export async function getRunDiff(id: string, sha?: string): Promise<RunDiff | { unavailable: string }> {
  if (!live()) return fixtures.diff(id) ?? { unavailable: "This run has no candidate yet: Windkeel hasn't finished a change." };
  try {
    return await request("GET", `/runs/${encodeURIComponent(id)}/diff${sha ? `?sha=${encodeURIComponent(sha)}` : ""}`);
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 503].includes(err.status)) {
      return { unavailable: err.code === "no_route" ? "This control plane doesn't serve diffs yet." : err.message };
    }
    throw err;
  }
}

export async function getRunWorkspace(id: string, path: string): Promise<WorkspaceRead | { refused: { code: string; message: string } }> {
  if (!live()) return fixtures.workspace(id, path);
  try {
    return await request("GET", `/runs/${encodeURIComponent(id)}/workspace${query({ path })}`);
  } catch (err) {
    if (err instanceof ApiError && [400, 404, 409, 413, 415, 503].includes(err.status)) return { refused: { code: err.code, message: err.message } };
    throw err;
  }
}

export async function getRunScreenshots(id: string): Promise<MakerScreenshot[] | { unavailable: string }> {
  if (!live()) return fixtures.screenshots(id);
  try {
    return (await request<Page<MakerScreenshot>>("GET", `/runs/${encodeURIComponent(id)}/screenshots`)).items;
  } catch (err) {
    if (err instanceof ApiError && [404, 503].includes(err.status)) {
      return { unavailable: err.code === "no_route" ? "This control plane doesn't serve maker screenshots yet." : err.message };
    }
    throw err;
  }
}

export async function getRunEvidence(id: string): Promise<Page<EvidenceEntry>> {
  return live() ? request("GET", `/runs/${encodeURIComponent(id)}/evidence`) : fixtures.evidence(id);
}

export async function getRunMessages(id: string): Promise<Page<GuidanceMessage>> {
  return live() ? request("GET", `/runs/${encodeURIComponent(id)}/messages`) : fixtures.messages(id);
}

export async function listRepositorySecrets(repositoryId: string): Promise<Page<RepositorySecret> | null> {
  if (!live()) return fixtures.secrets(repositoryId);
  try {
    return await request("GET", `/repositories/${encodeURIComponent(repositoryId)}/secrets`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getRepositoryEnvironment(repositoryId: string): Promise<RepositoryEnvironment | null> {
  if (!live()) return fixtures.environment(repositoryId);
  try {
    return await request("GET", `/repositories/${encodeURIComponent(repositoryId)}/environment`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

export async function rebuildRepositoryEnvironment(repositoryId: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", `/repositories/${encodeURIComponent(repositoryId)}/environment/rebuild`);
}

export async function invalidateRepositoryEnvironment(repositoryId: string): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", `/repositories/${encodeURIComponent(repositoryId)}/environment/invalidate`);
}

export async function getRunEvidenceOrNull(id: string): Promise<Page<EvidenceEntry> | null> {
  try {
    return await getRunEvidence(id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 503 || err.status === 404)) return null;
    throw err;
  }
}

export async function listTasks(filter: { repository?: string; status?: string; source?: string } = {}): Promise<Page<TaskRow>> {
  return live() ? request("GET", `/tasks${query(filter)}`) : fixtures.tasks(filter);
}

export async function getTask(id: string): Promise<Task | null> {
  if (!live()) return fixtures.task(id);
  try {
    return await request("GET", `/tasks/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function listRepositories(cursor?: string): Promise<Page<RepositorySummary>> {
  return live() ? request("GET", `/repositories${query({ cursor })}`) : fixtures.repositories();
}

export async function listAllRepositories(): Promise<Page<RepositorySummary>> {
  let page = await listRepositories();
  const items = [...page.items];
  for (let n = 1; page.hasNextPage && page.endCursor && n < 20; n++) {
    page = await listRepositories(page.endCursor);
    items.push(...page.items);
  }
  return { items, endCursor: null, hasNextPage: false };
}

export async function getMetrics(): Promise<Record<string, unknown>> {
  return live() ? request("GET", "/metrics") : fixtures.metrics();
}

export async function getSelf(): Promise<Self> {
  return live() ? request("GET", "/self") : { subject: "fixtures", scopes: [] };
}

export async function getHealth(): Promise<{ ok: boolean; database: string }> {
  if (!live()) return { ok: true, database: "fixtures" };
  const { url } = await apiAuth();
  try {
    const res = await slot(() => fetch(`${url}/v1/health`, { cache: "no-store" }));
    const body = (await res.json().catch(() => null)) as { ok?: boolean; database?: string } | null;
    return { ok: body?.ok === true, database: body?.database ?? `answered ${res.status}` };
  } catch {
    return { ok: false, database: "unreachable" };
  }
}

export function databaseState(database: string): string {
  switch (database) {
    case "reachable":
      return "Reachable";
    case "connection_limit":
      return "Reachable, but every connection is taken right now. Pages retry once; if this lasts, idle connections need closing.";
    case "unreachable":
      return "Unreachable";
    case "fixtures":
      return "fixtures";
    default:
      return database;
  }
}

export async function listBatches(filter: { status?: string; cursor?: string } = {}): Promise<Page<BatchView>> {
  return live() ? request("GET", `/batches${query(filter)}`) : { items: [], endCursor: null, hasNextPage: false };
}

export async function getBatch(id: string): Promise<BatchDetail | null> {
  if (!live()) return null;
  try {
    return await request("GET", `/batches/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function batchLifecycle(id: string, action: "pause" | "resume" | "cancel"): Promise<Accepted & BatchDetail> {
  return live() ? request("POST", `/batches/${encodeURIComponent(id)}/${action}`) : fixtureRefusal();
}

export async function approveRun(id: string): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/approve`) : fixtureRefusal();
}

export async function cancelRun(id: string, reason?: string): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/cancel`, { reason }) : fixtureRefusal();
}

export async function sendGuidance(id: string, message: string): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/messages`, { message }) : fixtureRefusal();
}

export async function takeoverRun(id: string): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/takeover`, {}) : fixtureRefusal();
}

export async function submitRun(id: string): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/submit`, {}) : fixtureRefusal();
}

export async function handBackRun(id: string): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/handback`, {}) : fixtureRefusal();
}

export async function openWorkspaceSession(id: string): Promise<Accepted & { url: string; expiresAt: string }> {
  return live() ? request("POST", `/runs/${encodeURIComponent(id)}/workspace/session`, {}) : fixtureRefusal();
}

export async function takeoverEnabled(): Promise<boolean> {
  try {
    return (await getIdentity()).features?.takeover === true;
  } catch {
    return false;
  }
}

export async function createTask(input: {
  repositoryId: string;
  title: string;
  description: string;
  riskLevel?: "low" | "medium" | "high";

  mode?: "autonomous" | "pair";

  models?: TaskModels;

  playbook?: string;
}): Promise<Accepted & { taskId: string; engineeringRunId: string }> {

  return live() ? request("POST", "/tasks", input) : fixtureRefusal();
}

export async function createRun(taskId: string, models?: TaskModels): Promise<Accepted> {
  return live() ? request("POST", "/runs", { taskId, ...(models ? { models } : {}) }) : fixtureRefusal();
}

export async function getMergeEligibility(runId: string): Promise<MergeEligibility | null> {
  if (!live()) return null;
  try {
    return await request<MergeEligibility>("GET", `/runs/${encodeURIComponent(runId)}/merge-eligibility`);
  } catch {
    return null;
  }
}

export async function mergeRun(
  runId: string,
  body: { acknowledgements: string[]; markReady: boolean; mergeMethod: string },
): Promise<Accepted> {
  return live() ? request("POST", `/runs/${encodeURIComponent(runId)}/merge`, body) : fixtureRefusal();
}

export async function getMerging(orgId: string): Promise<MergingSettings | null> {
  if (!live()) return null;
  try {
    return await request<MergingSettings>("GET", `/orgs/${encodeURIComponent(orgId)}/merging`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function setMerging(orgId: string, allowMerge: boolean): Promise<void> {
  if (!live()) sampleOnly();
  await request("PUT", `/orgs/${encodeURIComponent(orgId)}/merging`, { allowMerge });
}
