

import { describeError, defaultLog } from "@windkeel/factory/intake";
import {
  BYPASS_REASON,
  evaluateMerge,
  firstFailing,
  type EligibilityResult,
  type PullRequestFacts,
} from "@windkeel/factory/runs";
import {
  getAllowMerge,
  insertRunMerge,
  latestRunMerge,
  loadMergeContext,
  MergeInProgressError,
  MERGE_METHODS,
  completeRunMerge,
  setAllowMerge,
  type MergeContext,
  type MergeMethod,
  type RunMerge,
} from "@windkeel/factory/runs";
import {
  deleteGithubUserAuthorization,
  getGithubUserAuthorization,
  putGithubUserAuthorization,
  type GithubUserAuthorization,
} from "@windkeel/factory/tenancy";
import {
  exchangeAuthorizationCode,
  githubWebBase,
  revokeUserToken,
  userClient,
  UserAuthorizationError,
  type FetchLike,
} from "@windkeel/factory/github";
import type { AppPullRequestFacts, PullRequestFactsReader } from "@windkeel/factory/github";
import { accepted, audited, badRequest, conflict, notFound, ok, type ApiDeps, type ApiResult, type Scope } from "./handlers.js";
import type { Caller } from "./router.js";

export interface MergePort {

  enabled: boolean;

  start(runMergeId: string): Promise<void>;

  pullRequestFacts?: PullRequestFactsReader | undefined;

  githubApp?: { clientId: string; clientSecret: string } | undefined;

  apiBase?: string | undefined;

  fetchImpl?: FetchLike | undefined;
}

function port(deps: ApiDeps): MergePort | null {
  const merge = deps.merge;
  return merge && merge.enabled ? merge : null;
}

function disabled(): ApiResult {
  return {
    status: 404,
    body: { error: "merging from Windkeel is not enabled on this deployment", code: "merging_disabled" },
  };
}

function authorizationView(a: GithubUserAuthorization | null) {
  if (!a) return null;
  return {
    githubLogin: a.githubLogin,
    githubUserId: a.githubUserId,
    status: a.status,
    statusReason: a.statusReason,
    accessExpiresAt: a.accessExpiresAt?.toISOString() ?? null,
    refreshExpiresAt: a.refreshExpiresAt?.toISOString() ?? null,
    connectedAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function runMergeView(m: RunMerge | null) {
  if (!m) return null;
  return {
    id: m.id,
    principalId: m.principalId,
    prNumber: m.prNumber,
    verifiedSha: m.verifiedSha,
    mergedSha: m.mergedSha,
    verdict: m.verdict,
    verdictDigest: m.verdictDigest,
    acknowledgements: m.acknowledgements,
    markReady: m.markReady,
    mergeMethod: m.mergeMethod,
    status: m.status,
    reason: m.reason,
    githubLogin: m.githubLogin,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt?.toISOString() ?? null,
  };
}

export async function merging(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const merge = port(deps);
  if (!merge) return disabled();
  return ok({
    allowMerge: await getAllowMerge(deps.pool, scope.organizationId),
    canManage: (scope.permissions ?? []).includes("members.manage"),
    canMerge: (scope.permissions ?? []).includes("runs.merge"),
    githubConnect: { configured: Boolean(merge.githubApp && deps.secretPublicKey) },
    authorization: authorizationView(await getGithubUserAuthorization(deps.pool, scope.principalId)),
  });
}

export async function setMerging(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  if (!port(deps)) return disabled();
  const allow = objectBody(body)["allowMerge"];
  if (typeof allow !== "boolean") return badRequest("allowMerge must be true or false");
  const allowMerge = await audited(
    deps,
    scope,
    (tx) => setAllowMerge(tx, scope.organizationId, allow),
    (now) => ({ action: "merging.changed", target: { type: "organization", id: scope.organizationId }, detail: { allowMerge: now } }),
  );
  return ok({ allowMerge });
}

export async function githubAuthorization(deps: ApiDeps, caller: Caller): Promise<ApiResult> {
  if (!port(deps)) return disabled();
  return ok({ authorization: authorizationView(await getGithubUserAuthorization(deps.pool, caller.principal.id)) });
}

const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

export async function connectGithub(deps: ApiDeps, caller: Caller, body: unknown): Promise<ApiResult> {
  const merge = port(deps);
  if (!merge) return disabled();
  if (!merge.githubApp) {
    return {
      status: 503,
      body: {
        error: "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are not set, so this deployment cannot finish a GitHub authorization",
        code: "github_authorization_unconfigured",
      },
    };
  }
  if (!deps.secretPublicKey) {
    return {
      status: 503,
      body: { error: "WINDKEEL_SECRET_PUBLIC_KEY is not set, so this deployment cannot seal a GitHub token", code: "secrets_disabled" },
    };
  }
  const fields = objectBody(body);
  const code = fields["code"];
  const verifier = fields["codeVerifier"];
  const redirectUri = typeof fields["redirectUri"] === "string" ? fields["redirectUri"] : undefined;
  if (typeof code !== "string" || code === "" || code.length > 200) return badRequest("code is required");
  if (typeof verifier !== "string" || !VERIFIER_SHAPE.test(verifier)) return badRequest("codeVerifier must be a PKCE verifier (43-128 characters)");
  if (caller.principal.githubUserId === null) {
    return conflict("your Windkeel account is not linked to a GitHub account, so there is nothing to match the authorization against", "github_account_unlinked");
  }

  const fetchImpl = merge.fetchImpl;
  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      clientId: merge.githubApp.clientId,
      clientSecret: merge.githubApp.clientSecret,
      code,
      codeVerifier: verifier,
      redirectUri,

      webBase: githubWebBase(merge.apiBase),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  } catch (err) {
    if (err instanceof UserAuthorizationError) return badRequest(err.message, "github_authorization_failed");
    throw err;
  }

  const apiBase = merge.apiBase ?? "https://api.github.com";
  const me = await userClient({ token: tokens.accessToken, apiBase, ...(fetchImpl ? { fetchImpl } : {}) }).call("GET", "/user");
  const id = Number(me.body?.id);
  const login = typeof me.body?.login === "string" ? me.body.login : "";
  if (me.status !== 200 || !Number.isInteger(id) || login === "") {
    return { status: 502, body: { error: `GitHub answered ${me.status} asking who authorized`, code: "github_unavailable" } };
  }
  if (id !== caller.principal.githubUserId) {
    await revokeUserToken({
      clientId: merge.githubApp.clientId,
      clientSecret: merge.githubApp.clientSecret,
      accessToken: tokens.accessToken,
      apiBase,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return conflict(
      `you authorized as @${login}, but you sign in to Windkeel as ${caller.principal.githubLogin ? `@${caller.principal.githubLogin}` : "another GitHub account"}; authorize as yourself`,
      "github_account_mismatch",
    );
  }

  const stored = await putGithubUserAuthorization(deps.pool, {
    principalId: caller.principal.id,
    githubUserId: id,
    githubLogin: login,
    tokens,
    publicKey: deps.secretPublicKey,
  });
  return { status: 201, body: { authorization: authorizationView(stored) } };
}

export async function disconnectGithub(deps: ApiDeps, caller: Caller): Promise<ApiResult> {
  if (!port(deps)) return disabled();
  return ok({ deleted: await deleteGithubUserAuthorization(deps.pool, caller.principal.id) });
}

interface Judged {
  context: MergeContext;
  result: EligibilityResult;
  pr: AppPullRequestFacts | null;
  githubError: string | null;
  latest: RunMerge | null;
}

async function judge(
  deps: ApiDeps,
  merge: MergePort,
  scope: Scope,
  runId: string,
  options: { acknowledgements: string[] | "all"; markReady: boolean | "if-draft" },
): Promise<Judged | null> {
  const context = await loadMergeContext(deps.pool, {
    organizationId: scope.organizationId,
    engineeringRunId: runId,
    principalId: scope.principalId,
  });
  if (!context) return null;
  let pr: AppPullRequestFacts | null = null;
  let githubError: string | null = null;
  if (context.repository && context.prNumber !== null && merge.pullRequestFacts) {
    try {
      pr = await merge.pullRequestFacts({ owner: context.repository.owner, name: context.repository.name }, context.prNumber);
    } catch (error) {
      githubError = "GitHub couldn't be read just now; try again in a moment";
      defaultLog("merge eligibility: reading the pull request failed", { runId, ...describeError(error) });
    }
  }
  const facts: PullRequestFacts | undefined = pr
    ? {
        state: pr.state,
        headSha: pr.headSha,
        isDraft: pr.isDraft,
        mergeStateStatus: pr.mergeStateStatus,
        changedPaths: pr.changedPaths,
        changedPathsComplete: pr.changedPathsComplete,

      }
    : context.prNumber === null
      ? { state: "CLOSED" }
      : undefined;
  const acks = options.acknowledgements === "all" ? (context.verdictOfRecord?.needsALook ?? []).map((i) => i.id) : options.acknowledgements;
  const markReady = options.markReady === "if-draft" ? pr?.isDraft === true : options.markReady;
  const latest = await latestRunMerge(deps.pool, context.engineeringRunId);

  const bypassSeenAtLastMerge =
    latest !== null &&
    latest.principalId === scope.principalId &&
    latest.status === "refused" &&
    latest.verifiedSha.toLowerCase() === (context.verdictOfRecord?.candidateSha ?? "").toLowerCase() &&
    (latest.reason ?? "").includes(BYPASS_REASON);
  const result = evaluateMerge({
    deploymentEnabled: merge.enabled,
    verdictOfRecord: context.verdictOfRecord,
    acknowledgements: acks,
    ...(facts ? { pr: facts } : {}),
    principal: { permissions: context.permissions },
    org: { allowMergingFromWindkeel: context.allowMerge },
    app: { workflowsPermission: null },
    markReady,
    seenBy: "app",
    bypassSeenAtLastMerge,
    authorization: context.authorization
      ? { status: context.authorization.status, githubUserId: context.authorization.githubUserId, githubLogin: context.authorization.githubLogin }
      : null,
    linkedGithubUserId: context.linkedGithubUserId,
  });
  if (context.prNumber === null) {
    const open = result.rules.find((r) => r.id === "pr-open");
    if (open) open.reason = "This run has no pull request";
  }
  return { context, result, pr, githubError, latest };
}

export async function mergeEligibility(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const merge = port(deps);
  if (!merge) return disabled();
  const judged = await judge(deps, merge, scope, runId, { acknowledgements: "all", markReady: "if-draft" });
  if (!judged) return notFound("run");
  const { context, result, pr, githubError, latest } = judged;
  const needs = context.verdictOfRecord?.needsALook ?? [];
  if (needs.length > 0) {
    const ack = result.rules.find((r) => r.id === "warn-acknowledged");
    if (ack) ack.reason = `${needs.length} Needs-a-look item${needs.length === 1 ? "" : "s"} to acknowledge when you merge`;
  }
  return ok({
    eligible: result.eligible,
    rules: result.rules,
    flags: result.flags,
    failing: firstFailing(result),
    needsAcknowledgement: needs,
    verifiedSha: context.verdictOfRecord?.candidateSha ?? null,
    verdict: context.verdictOfRecord?.verdict ?? null,
    verdictDigest: context.verdictOfRecord?.digest ?? null,
    prNumber: context.prNumber,
    prUrl: pr?.htmlUrl ?? null,
    isDraft: pr?.isDraft ?? null,
    authorization: authorizationView(context.authorization),
    merge: runMergeView(latest),
    githubError,
    seenBy: "app",
  });
}

export async function mergeRun(deps: ApiDeps, scope: Scope, runId: string, body: unknown): Promise<ApiResult> {
  const merge = port(deps);
  if (!merge) return disabled();
  const fields = objectBody(body);
  const rawAcks = fields["acknowledgements"] ?? [];
  if (!Array.isArray(rawAcks) || !rawAcks.every((a) => typeof a === "string")) {
    return badRequest("acknowledgements must be a list of Needs-a-look item ids");
  }
  const markReady = fields["markReady"] ?? false;
  if (typeof markReady !== "boolean") return badRequest("markReady must be true or false");
  const method = fields["mergeMethod"] ?? "squash";
  if (typeof method !== "string" || !(MERGE_METHODS as readonly string[]).includes(method)) {
    return badRequest(`mergeMethod must be one of ${MERGE_METHODS.join(", ")}`);
  }

  const judged = await judge(deps, merge, scope, runId, { acknowledgements: rawAcks, markReady });
  if (!judged) return notFound("run");
  const { context, result, githubError } = judged;
  if (githubError) return { status: 502, body: { error: githubError, code: "github_unavailable" } };
  const failing = firstFailing(result);
  if (failing || !context.verdictOfRecord || !context.repository || context.prNumber === null) {
    return {
      status: 409,
      body: { error: failing?.reason ?? "this run can't be merged", code: "merge_refused", rule: failing?.id ?? null, rules: result.rules },
    };
  }

  const acknowledged = new Set(rawAcks);
  let recorded: RunMerge;
  try {
    const verdict = context.verdictOfRecord;
    const repository = context.repository;
    const prNumber = context.prNumber;
    recorded = await audited(
      deps,
      scope,
      (tx) =>
        insertRunMerge(tx, {
          engineeringRunId: context.engineeringRunId,
          organizationId: scope.organizationId,
          principalId: scope.principalId,
          repositoryId: repository.id,
          prNumber,
          verifiedSha: verdict.candidateSha,
          verificationRunId: verdict.verificationRunId,
          verdict: verdict.verdict as "pass" | "warn",
          verdictDigest: verdict.digest,
          acknowledgements: verdict.needsALook.filter((i) => acknowledged.has(i.id)),
          markReady,
          mergeMethod: method as MergeMethod,
        }),
      (done) => ({
        action: "run.merge_requested",
        target: { type: "run", id: context.engineeringRunId },

        detail: { runMergeId: done.id, prNumber, verificationRunId: done.verificationRunId, verifiedSha: done.verifiedSha, verdict: done.verdict, mergeMethod: done.mergeMethod },
      }),
    );
  } catch (err) {
    if (err instanceof MergeInProgressError) return conflict(err.message, "merge_in_progress");
    throw err;
  }
  try {
    await merge.start(recorded.id);
  } catch (error) {
    defaultLog("merge did not start", { runMergeId: recorded.id, ...describeError(error) });
    await completeRunMerge(deps.pool, recorded.id, { status: "failed", reason: "the merge could not be started; nothing was merged" });
    return { status: 503, body: { error: "the merge could not be started; nothing was merged — try again shortly", code: "merge_unavailable" } };
  }
  return accepted({ merge: runMergeView(recorded) });
}

function objectBody(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

