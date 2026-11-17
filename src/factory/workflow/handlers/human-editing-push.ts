
import { getEngineeringRun, getEngineeringTask, listWorkspaces } from "../../repositories.js";
import { chargeSandboxUsage } from "../../workspace-service.js";
import {
  commitAndBundle,
  HumanPushError,
  pushVerifiedBundle,
  verifyBundle,
  type ProcInfo,
  type PushTokenIssuer,
} from "../../human-push.js";
import {
  getHumanSession,
  incrementHumanCycles,
  updateHumanSession,
  type HumanSession,
} from "../../human-session.js";
import type { HumanWorkspaceHandle } from "../../../sandbox/human-workspace.js";
import { assertSafeGitConfig, hardenedGit } from "../../../sandbox/git-hardening.js";
import { SandboxGoneError, type SandboxHandle } from "../../../sandbox/provider.js";
import type { StageDeps } from "../stage-deps.js";
import { resolveRepositoryTarget } from "../repository-target.js";
import { runBranchFor } from "../branch.js";
import { acquireWorkspaceHandle } from "./attach-workspace.js";
import { makerWorkspaceOf } from "./maker-workspace.js";
import { continues, ends, type StageResult } from "./loop-exit.js";

const LOCAL_ISSUER: PushTokenIssuer = {
  async mint() {
    return { username: "x-access-token", token: "", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  },
  async revoke() {},
};

export function nowOf(deps: StageDeps): Date {
  return deps.humanEditing?.now?.() ?? new Date();
}

export async function pushIntent(deps: StageDeps, session: HumanSession, intent: "submit" | "handback"): Promise<StageResult> {
  const { pool, config } = deps;
  const runId = session.engineeringRunId;
  const human = deps.humanEditing!;
  await updateHumanSession(pool, session.id, { state: intent === "submit" ? "submitting" : "handing_back" });

  let handle: HumanWorkspaceHandle;
  try {
    handle = await human.workspaces.attach(session.sandboxName ?? "", { resume: true });
  } catch (error) {
    if (!(error instanceof SandboxGoneError)) throw error;
    return workspaceGone(deps, session);
  }

  const run = await getEngineeringRun(pool, runId);
  const task = run ? await getEngineeringTask(pool, run.taskId) : null;
  const target = await resolveRepositoryTarget(pool, runId, config.repository);
  const branch = runBranchFor(runId, task);
  const person = { githubId: session.githubUserId, login: session.githubLogin, name: session.displayName ?? undefined };
  const windkeel = { name: config.gitAuthorName, email: config.gitAuthorEmail };

  let pushed: { sha: string; bundle: Buffer | null; revokeError: string | null };
  try {
    const bundled = await commitAndBundle({
      runId,
      workspace: handle,
      processes: handle.processes,
      policy: { personUids: handle.personUids, baseline: (session.processBaseline as ProcInfo[] | null) ?? null },
      checkoutPath: handle.checkoutPath,
      seedSha: session.seedSha!,
      person,
      windkeel,
      closeSession: () => handle.stopServer(),

      date: session.intentAt ?? undefined,
      message:
        intent === "submit"
          ? `Changes by ${session.githubLogin} for run ${runId}\n\nSubmitted for verification from Windkeel's human workspace.\n`
          : `Changes by ${session.githubLogin} for run ${runId}\n\nHanded back to Windkeel from the human workspace.\n`,
    });
    if (bundled.kind === "empty") {
      pushed = { sha: session.seedSha!, bundle: null, revokeError: null };
    } else {
      const verified = await verifyBundle({ bundle: bundled.bundle, seedSha: session.seedSha!, person, windkeel, ...(human.host ? { host: human.host } : {}) });

      const landed = session.pushSha;
      if (session.pushSha !== verified.sha) await updateHumanSession(pool, session.id, { pushSha: verified.sha });
      const result = await pushVerifiedBundle({
        verified,
        seedSha: session.seedSha!,
        repositoryUrl: target.url,
        branch,
        runId,
        tokens: human.pushTokens ?? LOCAL_ISSUER,
        landed,
        ...(human.host ? { host: human.host } : {}),
      });
      pushed = { sha: result.sha, bundle: bundled.bundle, revokeError: result.revokeError };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateHumanSession(pool, session.id, {
      state: "ready",
      intent: null,
      intentAt: null,
      error: `${intent === "submit" ? "Submit" : "Hand back"} refused: ${message}`,
    });
    if (error instanceof HumanPushError && error.stage === "branch-moved") {
      return continues({ kind: "wait", reason: `the ${intent} was refused: the run branch moved` });
    }
    return continues({ kind: "wait", reason: `the ${intent} was refused: ${message}` });
  }

  const commits = pushed.bundle && !session.commits.some((c) => c.sha === pushed.sha)
    ? [
        ...session.commits,
        { sha: pushed.sha, parentSha: session.seedSha!, kind: intent, at: nowOf(deps).toISOString(), authorEmail: `${session.githubUserId}+${session.githubLogin}@users.noreply.github.com` },
      ]
    : session.commits;
  await updateHumanSession(pool, session.id, {
    commits,
    ...(pushed.revokeError ? { error: `the push token could not be revoked and lives out its hour: ${pushed.revokeError}` } : {}),
  });
  await incrementHumanCycles(pool, runId);

  if (intent === "handback") {
    const maker = makerWorkspaceOf(await listWorkspaces(pool, runId));
    const makerHandle = maker ? await acquireWorkspaceHandle(deps, maker) : undefined;
    if (!makerHandle) {
      await endSession(deps, (await getHumanSession(pool, session.id))!, "failed", "the agent's sandbox is gone, so there is nothing to hand back to; submit for verification instead");
      return ends({ kind: "transition", to: "BLOCKED", reason: "hand back: the maker sandbox could not be re-acquired" });
    }
    if (pushed.bundle) await applyBundleToMaker(makerHandle, pushed.bundle, pushed.sha);
    await endSession(deps, (await getHumanSession(pool, session.id))!, "handed_back", null);
    return continues({
      kind: "transition",
      to: "IMPLEMENTING",
      reason: `${session.githubLogin} handed back to Windkeel${pushed.bundle ? ` with commit ${pushed.sha}` : " with no changes"}`,
    });
  }

  await endSession(deps, (await getHumanSession(pool, session.id))!, "submitted", null);
  return continues({
    kind: "transition",
    to: "VERIFYING",
    reason: `${session.githubLogin} submitted ${pushed.bundle ? `candidate ${pushed.sha}` : `the unchanged candidate ${pushed.sha}`} for verification`,
  });
}

async function applyBundleToMaker(handle: SandboxHandle, bundle: Buffer, sha: string): Promise<void> {
  const exec = handle.exec.bind(handle);
  await assertSafeGitConfig(exec, handle.checkoutPath);
  const dir = await handle.mkdtemp("windkeel-handback-");
  try {
    const file = `${dir}/human.bundle`;
    await handle.writeFile(file, bundle);
    const fetched = await hardenedGit(exec, ["fetch", "-q", file, "refs/windkeel/human-candidate"], { cwd: handle.checkoutPath });
    if (fetched.status !== 0) throw new Error(`the maker could not fetch the person's commit: ${fetched.stderr.trim()}`);
    const reset = await hardenedGit(exec, ["reset", "-q", "--hard", sha], { cwd: handle.checkoutPath });
    if (reset.status !== 0) throw new Error(`the maker could not move to the person's commit: ${reset.stderr.trim()}`);
  } finally {
    await handle.exec("rm", { args: ["-rf", dir] }).catch(() => undefined);
  }
}

export async function workspaceGone(deps: StageDeps, session: HumanSession): Promise<StageResult> {
  await endSession(deps, session, "failed", "the human workspace is gone (expired or deleted); uncommitted work is lost");
  return ends({ kind: "transition", to: "BLOCKED", reason: "the human workspace is gone; uncommitted work is lost" });
}

export async function endSession(
  deps: StageDeps,
  session: HumanSession,
  outcome: "submitted" | "handed_back" | "cancelled" | "blocked" | "expired" | "failed",
  error: string | null,
): Promise<void> {
  if (session.sandboxName && deps.humanEditing) {
    try {
      const handle = await deps.humanEditing.workspaces.attach(session.sandboxName);
      await chargeSandboxUsage(deps.pool, handle as unknown as SandboxHandle, session.id, session.engineeringRunId, {
        usdPerCpuMs: deps.config.usdPerCpuMs,
        usdPerEgressByte: deps.config.usdPerEgressByte,
      }).catch(() => 0);
      await handle.destroy();
    } catch {

    }
  }
  await updateHumanSession(deps.pool, session.id, {
    state: outcome === "failed" ? "failed" : "ended",
    outcome,
    intent: null,
    endedAt: nowOf(deps),
    ...(error ? { error } : {}),
  });
}
