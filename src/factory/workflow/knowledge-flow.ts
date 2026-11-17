import { defaultLog, describeError } from "../log.js";
import type { SandboxHandle } from "../../sandbox/provider.js";
import {
  getDigest,
  hasDigest,
  knowledgeSettings,
  listNotes,
  listRunKnowledge,
  putDigest,
  recordRunKnowledge,
  type KnowledgeSettings,
} from "../knowledge.js";
import { learnFromRun } from "../knowledge-learn.js";
import { renderEntry, renderKnowledgeSection, type KnowledgeEntry } from "../knowledge-render.js";
import { selectKnowledge } from "../knowledge-select.js";
import { buildDigest, gitTreeReader } from "../repo-digest.js";
import { listWorkspaces, type EngineeringTask, type Workspace } from "../repositories.js";
import type { StageDeps } from "./stage-deps.js";
import { repositoryExists } from "./stores/workflow-misc-store.js";

function makerWorkspaceOf(workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find((w) => w.role === "maker");
}

function settingsOf(deps: StageDeps): KnowledgeSettings {
  return deps.config.knowledge ?? knowledgeSettings();
}

export function taskText(task: Pick<EngineeringTask, "title" | "description" | "acceptanceCriteria">): string {
  return [task.title, task.description, ...task.acceptanceCriteria.map((c) => c.text)].join("\n");
}

export async function makerKnowledge(deps: StageDeps, engineeringRunId: string, task: EngineeringTask): Promise<string> {
  const settings = settingsOf(deps);
  if (!settings.enabled) return "";
  try {
    const frozen = await listRunKnowledge(deps.pool, engineeringRunId);
    if (frozen.length > 0) return renderKnowledgeSection(frozen);

    const notes = await listNotes(deps.pool, {
      organizationId: task.organizationId,
      repositoryId: task.repositoryId,
      status: "active",
    });
    const workspace = makerWorkspaceOf(await listWorkspaces(deps.pool, engineeringRunId));
    const digest = await getDigest(deps.pool, task.repositoryId, workspace?.baseSha ?? null);
    const { injected } = selectKnowledge({
      notes,
      digest,
      taskText: taskText(task),
      budgetChars: settings.maxChars,
    });
    if (injected.length === 0) return "";
    const recorded = await recordRunKnowledge(deps.pool, engineeringRunId, injected, (entry: KnowledgeEntry) =>
      renderEntry(entry).length,
    );
    return renderKnowledgeSection(recorded);
  } catch (error) {
    defaultLog("knowledge unavailable for this run; the maker starts without it", {
      engineeringRunId,
      ...describeError(error),
    });
    return "";
  }
}

export async function recordDigest(
  deps: StageDeps,
  engineeringRunId: string,
  task: EngineeringTask,
  handle: SandboxHandle,
): Promise<void> {
  if (!settingsOf(deps).enabled) return;
  try {
    const workspace = makerWorkspaceOf(await listWorkspaces(deps.pool, engineeringRunId));
    const sha = workspace?.baseSha ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return;
    if (!(await repositoryExists(deps.pool, task.repositoryId))) return;
    if (await hasDigest(deps.pool, task.repositoryId, sha)) return;
    const digest = await buildDigest(gitTreeReader((cmd, opts) => handle.exec(cmd, opts), handle.checkoutPath, sha));
    if (digest.body.trim() === "") return;
    await putDigest(deps.pool, { repositoryId: task.repositoryId, commitSha: sha, ...digest });
  } catch (error) {
    defaultLog("codebase digest not generated; the run continues", { engineeringRunId, ...describeError(error) });
  }
}

export async function learnAfterLoop(deps: StageDeps, engineeringRunId: string): Promise<void> {
  try {
    await learnFromRun(deps.pool, engineeringRunId, settingsOf(deps));
  } catch (error) {
    defaultLog("learning from this run failed; nothing was learned", { engineeringRunId, ...describeError(error) });
  }
}
