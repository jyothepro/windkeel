import { Pool } from "pg";
import { redactSecrets } from "./log.js";
import {
  changedPaths,
  githubWebBase,
  MARK_READY_MUTATION,
  readPullRequest,
  redact,
  refreshUserToken,
  rulesetBypass,
  rulesetBypassFacts,
  userClient,
  type FetchLike,
  type LivePullRequest,
  type UserClient,
} from "../github/user-client.js";
import {
  GithubUserTokenError,
  markGithubUserAuthorizationNeedsReauth,
  openGithubUserToken,
} from "./github-user-tokens.js";
import { evaluateMerge, firstFailing, type EligibilityResult, type PullRequestFacts } from "./merge-eligibility.js";
import { completeRunMerge, getRunMerge, heartbeatRunMerge, loadMergeContext, mergeEnabledFromEnv, type MergeContext, type RunMerge } from "./run-merge.js";
import { secretPrivateKeysFromEnv } from "./worker-config.js";

export interface UserMergeDeps {
  pool: Pool;
  privateKeys: readonly string[];
  enabled: boolean;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  apiBase?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type MergeOutcome = { status: "merged" | "refused" | "failed" | "skipped"; reason?: string };

const READY_REREADS = 5;
const READY_REREAD_MS = 2_000;

export async function executeRunMerge(deps: UserMergeDeps, runMergeId: string): Promise<MergeOutcome> {
  const merge = await getRunMerge(deps.pool, runMergeId);
  if (!merge || merge.status !== "pending") return { status: "skipped" };
  if (!(await heartbeatRunMerge(deps.pool, merge.id))) return { status: "skipped" };
  const lost = { status: "skipped" as const, reason: "the attempt was settled elsewhere before this step acted; nothing was changed on GitHub" };

  const settle = async (status: "merged" | "refused" | "failed", reason: string | null, extra: { mergedSha?: string; githubLogin?: string } = {}) => {
    await completeRunMerge(deps.pool, merge.id, { status, reason, ...extra });
    return reason === null ? { status } : { status, reason };
  };

  const context = await loadMergeContext(deps.pool, {
    organizationId: merge.organizationId,
    engineeringRunId: merge.engineeringRunId,
    principalId: merge.principalId,
  });
  if (!context || !context.repository || context.prNumber === null) return settle("refused", "the run or its pull request is gone");
  if (!context.verdictOfRecord || context.verdictOfRecord.verificationRunId !== merge.verificationRunId) {
    return settle("refused", "the verdict of record changed after you asked to merge; review it again");
  }
  if (context.verdictOfRecord.candidateSha.toLowerCase() !== merge.verifiedSha.toLowerCase()) {
    return settle("refused", "the verified candidate changed after you asked to merge; review it again");
  }

  const before = judge(deps, context, merge, null, true);
  const early = before.rules.find((r) => !r.ok && r.checked && r.blocking);
  if (early) return settle("refused", early.reason);

  let token: string;
  let githubUserId: number;
  try {
    const opened = await openGithubUserToken(deps.pool, deps.privateKeys, merge.principalId, {
      refresh: (refreshToken) => {
        if (!deps.clientId) throw new Error("GITHUB_APP_CLIENT_ID is not set, so a GitHub token cannot be refreshed");
        return refreshUserToken({ clientId: deps.clientId, clientSecret: deps.clientSecret, refreshToken, webBase: githubWebBase(deps.apiBase), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      },
      ...(deps.now ? { now: deps.now } : {}),
    });
    token = opened.accessToken;
    githubUserId = opened.githubUserId;
  } catch (err) {
    if (err instanceof GithubUserTokenError) return settle("refused", err.message);
    throw err;
  }

  const scrub = (text: string) => redactSecrets(redact(text, [token]));
  try {
    const client = userClient({ token, ...(deps.apiBase ? { apiBase: deps.apiBase } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });

    const me = await client.call("GET", "/user");
    if (me.status === 401) {
      await markGithubUserAuthorizationNeedsReauth(deps.pool, merge.principalId, "GitHub no longer accepts the token (401)");
      return settle("refused", "GitHub no longer accepts your authorization; connect GitHub again");
    }
    if (me.status !== 200) return settle("failed", `GitHub answered ${me.status} asking who the token is`);
    const login = String(me.body?.login ?? "");
    const tokenUserId = Number(me.body?.id);
    if (tokenUserId !== githubUserId || context.linkedGithubUserId === null || tokenUserId !== context.linkedGithubUserId) {
      await markGithubUserAuthorizationNeedsReauth(deps.pool, merge.principalId, "the token's GitHub account is not the person's linked account");
      return settle("refused", `the GitHub token is for @${login || "another account"}, not the GitHub account you sign in with; connect GitHub again as yourself`, { githubLogin: login });
    }

    const where = { owner: context.repository.owner, name: context.repository.name, number: context.prNumber };
    let live = await readLive(client, where);
    if ("failure" in live) return settle("failed", live.failure, { githubLogin: login });

    if (
      merge.mergeSentAt !== null &&
      live.pr.state === "MERGED" &&
      live.pr.headRefOid.toLowerCase() === merge.verifiedSha.toLowerCase() &&
      live.pr.mergedBy?.login !== undefined &&
      live.pr.mergedBy.login.toLowerCase() === login.toLowerCase()
    ) {
      return settle("merged", null, { mergedSha: live.pr.mergeCommit?.oid ?? "", githubLogin: login });
    }

    let verdict = judge(deps, context, merge, live.facts, merge.markReady);
    let failing = firstFailing(verdict);
    if (failing) return settle("refused", failing.reason, { githubLogin: login });

    if (live.pr.isDraft) {
      if (!(await heartbeatRunMerge(deps.pool, merge.id))) return lost;
      const m = await client.graphql(MARK_READY_MUTATION, { id: live.pr.id });
      if (!m.ok) return settle("failed", `GitHub refused to mark the pull request ready (${m.status})`, { githubLogin: login });
      for (let i = 0; i < READY_REREADS; i++) {
        live = await readLive(client, where);
        if ("failure" in live) return settle("failed", live.failure, { githubLogin: login });
        if (live.pr.mergeStateStatus !== "UNKNOWN" && live.pr.mergeStateStatus !== "DRAFT") break;
        await (deps.sleep ?? defaultSleep)(READY_REREAD_MS);
      }
      verdict = judge(deps, context, merge, live.facts, false);
      failing = firstFailing(verdict);
      if (failing) return settle("refused", `marked ready, then: ${failing.reason}`, { githubLogin: login });
    }

    if (!(await heartbeatRunMerge(deps.pool, merge.id, { mergeSent: true }))) return lost;
    const result = await client.call("PUT", `/repos/${where.owner}/${where.name}/pulls/${where.number}/merge`, {
      sha: merge.verifiedSha,
      merge_method: merge.mergeMethod,
    });
    const message = typeof result.body?.message === "string" ? scrub(result.body.message).slice(0, 200) : "";
    if (result.status === 200 && result.body?.merged !== false) {
      return settle("merged", null, { mergedSha: String(result.body?.sha ?? ""), githubLogin: login });
    }
    if (result.status === 409) return settle("refused", "a commit landed after verification; GitHub refused the merge — verify again", { githubLogin: login });
    if (result.status === 401) {
      await markGithubUserAuthorizationNeedsReauth(deps.pool, merge.principalId, "GitHub no longer accepts the token (401)");
      return settle("refused", "GitHub no longer accepts your authorization; connect GitHub again", { githubLogin: login });
    }
    if (result.status === 403 || result.status === 405 || result.status === 422) {
      return settle("refused", `GitHub refused the merge (${result.status})${message ? `: ${message}` : ""}`, { githubLogin: login });
    }
    return settle("failed", `GitHub answered ${result.status} to the merge${message ? `: ${message}` : ""}`, { githubLogin: login });
  } catch (err) {
    return settle("failed", scrub(err instanceof Error ? err.message : String(err)).slice(0, 300));
  }
}

function judge(deps: UserMergeDeps, context: MergeContext, merge: RunMerge, pr: PullRequestFacts | null, markReady: boolean): EligibilityResult {
  return evaluateMerge({
    deploymentEnabled: deps.enabled,
    verdictOfRecord: context.verdictOfRecord,
    acknowledgements: merge.acknowledgements.map((a) => a.id),
    ...(pr ? { pr } : {}),
    principal: { permissions: context.permissions },
    org: { allowMergingFromWindkeel: context.allowMerge },
    app: { workflowsPermission: null },
    markReady,
    authorization: context.authorization
      ? { status: context.authorization.status, githubUserId: context.authorization.githubUserId, githubLogin: context.authorization.githubLogin }
      : null,
    linkedGithubUserId: context.linkedGithubUserId,
  });
}

async function readLive(
  client: UserClient,
  where: { owner: string; name: string; number: number },
): Promise<{ pr: LivePullRequest; facts: PullRequestFacts } | { failure: string }> {
  const s = await readPullRequest(client, where);
  if (!s.ok) return { failure: `GitHub answered ${s.status} reading the pull request with your token` };
  const f = await changedPaths(client, where);
  if (!f.ok) return { failure: `GitHub answered ${f.status} listing the pull request's files with your token` };
  const b = await rulesetBypass(client, { ...where, branch: s.pr.baseRefName });
  if (!b.ok) return { failure: `GitHub answered ${b.status} reading the base branch's rulesets with your token` };
  return {
    pr: s.pr,
    facts: {
      state: s.pr.state,
      headSha: s.pr.headRefOid,
      isDraft: s.pr.isDraft,
      mergeStateStatus: s.pr.mergeStateStatus,
      viewerCanMergeAsAdmin: s.pr.viewerCanMergeAsAdmin,
      ...rulesetBypassFacts(b),
      changedPaths: f.paths,
      changedPathsComplete: f.complete,
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let stagePool: Pool | undefined;

export async function executeRunMergeFromEnvironment(runMergeId: string): Promise<MergeOutcome> {
  if (!stagePool) {
    const connectionString = process.env["DATABASE_POOL_URL"]?.trim() || process.env["DATABASE_URL"]?.trim();
    if (!connectionString) throw new Error("executeRunMerge: DATABASE_URL is not set");
    stagePool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 5_000 });
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(stagePool);
  }
  return executeRunMerge(
    {
      pool: stagePool,
      privateKeys: secretPrivateKeysFromEnv(),
      enabled: mergeEnabledFromEnv(),
      clientId: process.env["GITHUB_APP_CLIENT_ID"]?.trim() || undefined,
      clientSecret: process.env["GITHUB_APP_CLIENT_SECRET"]?.trim() || undefined,
      apiBase: (process.env["GITHUB_API_BASE_URL"]?.trim() || "https://api.github.com").replace(/\/+$/, ""),
    },
    runMergeId,
  );
}
