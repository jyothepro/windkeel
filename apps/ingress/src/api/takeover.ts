

import {
  conflict,
  currentCursor,
  notFound,
  repositoryNoLongerGranted,
  type ApiDeps,
  type ApiResult,
  type Scope,
  auditOf,
  audited,
} from "./handlers.js";
import { recordAuditEvent } from "@windkeel/factory/tenancy";
import { runInOrganization, runRepositoryGranted } from "@windkeel/factory/tenancy";
import { TERMINAL_STATES } from "@windkeel/factory/runs";
import { FEED_START } from "@windkeel/factory/runs";
import { transact } from "./transact.js";
import { lockRunStatus } from "../stores/run-store.js";

type HumanSessionModule = typeof import("@windkeel/factory/tenancy");

async function sessions(): Promise<HumanSessionModule> {
  return import("@windkeel/factory/tenancy");
}

function disabled(): ApiResult {
  return conflict("take over is not enabled on this deployment (WINDKEEL_TAKEOVER)", "takeover_disabled");
}

async function accepted202(
  deps: ApiDeps,
  runId: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<ApiResult> {
  const cursor = await currentCursor(deps.pool, runId, FEED_START);
  return { status: 202, body: { accepted: true, engineeringRunId: runId, ...body, cursor }, ...(headers ? { headers } : {}) };
}

export async function takeoverRun(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  if (deps.takeover?.enabled !== true) return disabled();
  const row = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!row) return notFound("run");
  if (!(await runRepositoryGranted(deps.pool, runId))) return repositoryNoLongerGranted();
  const m = await sessions();
  const identity = await m.principalGithubIdentity(deps.pool, scope.principalId);

  const taken = await transact(deps.pool, async (client, rollback: (answer: ApiResult) => never) => {
    const status = (await lockRunStatus(client, runId)) ?? row.status;
    const refused = takeoverRefusal(status, identity);
    if (refused) return rollback(refused);
    const origin: "takeover" | "make_changes" = status === "IMPLEMENTING" || status === "REPAIRING" ? "takeover" : "make_changes";
    const cycles = await m.humanCycles(client, runId);
    if (cycles.used >= cycles.cap) {
      return rollback(conflict(`this run has used all ${cycles.cap} of its human cycles`, "human_cycle_cap"));
    }
    let session;
    try {
      session = await m.requestHumanSession(client, {
        engineeringRunId: runId,
        principalId: scope.principalId,
        actor: scope.actor,
        githubUserId: identity!.githubUserId,
        githubLogin: identity!.githubLogin,
        displayName: identity!.displayName,
        origin,
        requestedFrom: status as Parameters<HumanSessionModule["requestHumanSession"]>[1]["requestedFrom"],
      });
    } catch (error) {
      if (error instanceof m.AlreadyEditingError) return rollback(conflict("someone is already editing this run", "already_editing"));
      throw error;
    }
    await recordAuditEvent(client, {
      organizationId: scope.organizationId,
      ...auditOf(scope),
      action: "run.takeover_requested",
      target: { type: "run", id: runId },
      detail: { humanSessionId: session.id, origin, from: status },
    });
    return { session, origin };
  });
  if (!("session" in taken)) return taken;
  const { session, origin } = taken;
  await deps.control.wake?.(runId, "takeover", scope.actor);
  return accepted202(deps, runId, {
    outcome: origin === "takeover" ? "queued" : "making_changes",
    humanSessionId: session.id,

    ...(origin === "takeover" ? { note: "Windkeel will stop after its current turn, commit its work, and open your workspace" } : {}),
  });
}

function takeoverRefusal(status: string, identity: unknown): ApiResult | null {
  if (TERMINAL_STATES.has(status as never)) return conflict(`run is ${status}; there is nothing to take over`, "run_terminal");
  const allowed = status === "IMPLEMENTING" || status === "REPAIRING" || status === "WAITING_FOR_HUMAN" || status === "PR_READY";
  if (!allowed) {
    return conflict(
      status === "VERIFYING"
        ? "the run is being verified; take over once verification ends"
        : `run is ${status}; take over while IMPLEMENTING or REPAIRING, or make changes on a verified pull request`,
      "not_takeover_state",
    );
  }
  if (!identity) {
    return conflict(
      "your account has no linked GitHub identity, and your commits are authored as it (<id>+<login>@users.noreply.github.com)",
      "no_github_identity",
    );
  }
  return null;
}

async function editingSession(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
): Promise<{ session: Awaited<ReturnType<HumanSessionModule["liveHumanSession"]>> & object; m: HumanSessionModule } | ApiResult> {
  if (deps.takeover?.enabled !== true) return disabled();
  const row = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!row) return notFound("run");
  if (!(await runRepositoryGranted(deps.pool, runId))) return repositoryNoLongerGranted();
  if (row.status !== "HUMAN_EDITING") return conflict(`run is ${row.status}; nobody is editing it`, "not_editing");
  const m = await sessions();
  const session = await m.liveHumanSession(deps.pool, runId);
  if (!session) return conflict("run has no live human session", "not_editing");
  if (session.principalId !== scope.principalId) {
    return conflict(`${session.githubLogin} is editing this run; only they can submit, hand back or open it`, "not_your_session");
  }
  return { session, m };
}

async function queueIntent(deps: ApiDeps, scope: Scope, runId: string, intent: "submit" | "handback"): Promise<ApiResult> {
  const found = await editingSession(deps, scope, runId);
  if ("status" in found) return found;
  const { session, m } = found;
  if (session.intent || session.state === "submitting" || session.state === "handing_back") {
    return conflict(`a ${session.intent ?? (session.state === "submitting" ? "submit" : "hand back")} is already on its way`, "intent_pending");
  }
  if (session.state !== "ready" && session.state !== "sleeping") {
    return conflict("your workspace is still being set up", "workspace_not_ready");
  }
  if (intent === "handback" && session.origin === "make_changes") {
    return conflict("the agent's sandbox ended when the pull request opened; submit for verification instead", "no_maker");
  }
  const queued = await audited(
    deps,
    scope,
    (tx) => m.queueHumanIntent(tx, session.id, intent),
    (done) =>
      done
        ? { action: intent === "submit" ? "run.submitted" : "run.handed_back", target: { type: "run", id: runId }, detail: { humanSessionId: session.id } }
        : null,
  );
  if (!queued) return conflict("another submit or hand back got there first", "intent_pending");
  await deps.control.wake?.(runId, intent, scope.actor);
  return accepted202(deps, runId, { outcome: "queued", humanSessionId: session.id });
}

export function submitRun(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  return queueIntent(deps, scope, runId, "submit");
}

export function handbackRun(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  return queueIntent(deps, scope, runId, "handback");
}

export async function openWorkspaceSession(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const found = await editingSession(deps, scope, runId);
  if ("status" in found) return found;
  const { session, m } = found;
  if (session.intent || session.state === "submitting" || session.state === "handing_back") {
    return conflict("a submit or hand back is on its way; the workspace is closed", "intent_pending");
  }
  if ((session.state !== "ready" && session.state !== "sleeping") || !session.sandboxName) {
    return conflict("your workspace is still being set up", "workspace_not_ready");
  }
  const workspaces = deps.takeover?.workspaces;
  if (!workspaces) {
    return { status: 503, body: { error: "this deployment reaches no human workspace provider", code: "sandbox_unconfigured" } };
  }
  let provider;
  try {
    provider = await workspaces();
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : String(error), code: "sandbox_unconfigured" } };
  }
  const { mintWorkspaceToken, WORKSPACE_TOKEN_TTL_MS, HUMAN_WORKSPACE_MAX_LIFETIME_MS } = await import(
    "@windkeel/factory/sandbox"
  );
  let handle;
  try {
    handle = await provider.attach(session.sandboxName, { resume: true });
  } catch {
    return conflict("your workspace is gone (it expired or was deleted)", "workspace_gone");
  }
  const { token, tokenSha256 } = mintWorkspaceToken();
  const deadline = (session.startedAt ?? session.requestedAt).getTime() + HUMAN_WORKSPACE_MAX_LIFETIME_MS;
  const expiresAt = new Date(Math.min(Date.now() + WORKSPACE_TOKEN_TTL_MS, deadline));
  const { origin } = await handle.startServer({ tokenSha256, expiresAt });
  if (!/^https:\/\//.test(origin)) {
    return { status: 502, body: { error: "the workspace's public origin is not https", code: "workspace_unreachable" } };
  }
  await m.updateHumanSession(deps.pool, session.id, { state: "ready", workspaceOrigin: origin, lastActiveAt: new Date() });
  return accepted202(
    deps,
    runId,
    { outcome: "opened", humanSessionId: session.id, url: `${origin}/__windkeel/open#t=${token}`, expiresAt: expiresAt.toISOString() },

    { "cache-control": "no-store", pragma: "no-cache" },
  );
}

export async function takeoverFields(deps: ApiDeps, scope: Scope, runId: string): Promise<Record<string, unknown>> {
  const m = await sessions();
  const enabled = deps.takeover?.enabled === true;
  const [live, all, cycles, candidates] = await Promise.all([
    m.liveHumanSession(deps.pool, runId),
    m.listHumanSessions(deps.pool, runId),
    m.humanCycles(deps.pool, runId),
    m.runCandidateHistory(deps.pool, runId),
  ]);
  const shown = live ?? all[all.length - 1] ?? null;
  const { HUMAN_WORKSPACE_MAX_LIFETIME_MS } = await import("@windkeel/factory/sandbox");
  return {
    takeover: {
      enabled,
      session: shown
        ? {
            id: shown.id,
            state: shown.state,
            origin: shown.origin,
            editor: { principalId: shown.principalId, login: shown.githubLogin, displayName: shown.displayName ?? shown.githubLogin },
            yours: shown.principalId === scope.principalId,
            awake: shown.state === "ready",
            requestedAt: shown.requestedAt,
            startedAt: shown.startedAt,
            lastActiveAt: shown.lastActiveAt,
            expiresAt: shown.startedAt ? new Date(shown.startedAt.getTime() + HUMAN_WORKSPACE_MAX_LIFETIME_MS) : null,
            seedSha: shown.seedSha,
            intent: shown.intent,
            error: shown.error,
            outcome: shown.outcome,

            installNote: shown.installNote,
            canHandBack: shown.origin !== "make_changes",
          }
        : null,
      cycles,
    },
    candidates: candidates.map((c) => ({
      sha: c.sha,
      parentSha: c.parentSha,
      at: c.at,
      commitAuthor: c.commitAuthor,
      provenance: c.provenance,
      maker: c.maker,
      person: c.person ? { login: c.person.login, principalId: c.person.principalId } : null,
    })),
  };
}
