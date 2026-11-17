import type { Pool } from "pg";
import { listRunsPage } from "@windkeel/factory/runs";
import { grantedRepository, taskInOrganization, taskRepositoryGranted } from "@windkeel/factory/tenancy";
import type { RailsOptions } from "@windkeel/factory/runs";
import { claimIdempotencyKey, invalidIdempotencyKey, requestHash, storeIdempotentResponse, type IdempotencyClaim } from "@windkeel/factory/intake";
import { recordDelivery } from "@windkeel/factory/intake";
import { defaultLog, describeError } from "@windkeel/factory/intake";
import { type ApiDeps, type ApiError, type ApiResult, type Scope, accepted, badRequest, conflict, field, notFound, refusedHarness, repositoryNoLongerGranted, stringField } from "./common.js";
import { refusedCredential } from "./repository-config.js";
import { transact } from "./transact.js";
import { firstRunOfTask } from "../stores/run-store.js";

export async function createTask(
  deps: ApiDeps,
  scope: Scope,
  body: unknown,
  idempotencyKey?: string,
): Promise<ApiResult> {
  const repositoryId = stringField(body, "repositoryId");
  const title = stringField(body, "title");
  const description = stringField(body, "description");
  if (!repositoryId || !title || !description) {
    return badRequest("repositoryId, title and description are required", "missing_field");
  }

  const playbookRef = (body as Record<string, unknown> | null)?.["playbook"];
  let chosenPlaybook: import("@windkeel/factory/repositories").Playbook | null = null;
  if (playbookRef !== undefined && playbookRef !== null) {
    if (typeof playbookRef !== "string" || !playbookRef) {
      return badRequest("playbook must be a playbook slug or id", "invalid_playbook");
    }
    const { getPlaybook } = await import("@windkeel/factory/repositories");
    chosenPlaybook = await getPlaybook(deps.pool, scope.organizationId, playbookRef);
    if (!chosenPlaybook) {
      return { status: 404, body: { error: `no playbook ${JSON.stringify(playbookRef)} in this organization`, code: "unknown_playbook" } };
    }
  }
  const riskLevel = stringField(body, "riskLevel") ?? chosenPlaybook?.defaultRiskLevel ?? "low";
  if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") {
    return badRequest(`riskLevel must be low, medium or high (got ${riskLevel})`, "invalid_field");
  }
  const rails = railsFrom(body);
  if ("status" in rails) return rails;

  const mode = stringField(body, "mode") ?? "autonomous";
  if (mode !== "autonomous" && mode !== "pair") {
    return badRequest(`mode must be autonomous or pair (got ${mode})`, "invalid_mode");
  }
  if (mode === "pair" && deps.takeover?.enabled !== true) {
    return conflict("Pair mode needs take over, which this deployment does not enable (WINDKEEL_TAKEOVER)", "takeover_disabled");
  }
  if (mode === "pair") {

    if (!(scope.permissions ?? []).includes("runs.takeover")) {
      return {
        status: 403,
        body: { error: "Pair mode needs runs.takeover: the workspace it opens after the first turn is yours to act in", code: "forbidden", missing: "runs.takeover" },
      };
    }
    const { principalGithubIdentity } = await import("@windkeel/factory/tenancy");
    if (!(await principalGithubIdentity(deps.pool, scope.principalId))) {
      return conflict(
        "Pair mode needs a linked GitHub identity: your commits in the workspace are authored as it (<id>+<login>@users.noreply.github.com)",
        "no_github_identity",
      );
    }
  }
  const pair = async (db: Pool | import("pg").PoolClient, taskId: string): Promise<void> => {
    if (mode !== "pair") return;
    const { setTaskSessionMode } = await import("@windkeel/factory/tenancy");
    await setTaskSessionMode(db, taskId, "pair", scope.principalId);
  };

  const { parseTaskModelOverride } = await import("@windkeel/factory/models");
  let modelOverride = parseTaskModelOverride((body as Record<string, unknown> | null)?.["models"]);
  if (!modelOverride && chosenPlaybook?.modelPresetId) {

    const { getModelPreset } = await import("@windkeel/factory/models");
    const preset = await getModelPreset(deps.pool, scope.organizationId, chosenPlaybook.modelPresetId);
    if (preset) {
      const { harness: _inner, ...maker } = preset.maker;
      modelOverride = { maker: { ...maker, ...(preset.harness ? { harness: preset.harness } : {}) }, checker: preset.checker };
    }
  }
  if (modelOverride) {
    const refused = refusedHarness(deps, modelOverride) ?? (await refusedCredential(deps, scope, modelOverride));
    if (refused) return refused;
  }
  if (idempotencyKey !== undefined) {
    const invalid = invalidIdempotencyKey(idempotencyKey);
    if (invalid) return badRequest(invalid, "invalid_idempotency_key");
  }

  const { createTaskFromIntake } = await import("@windkeel/factory/intake");
  const { snapshotPlaybook } = await import("@windkeel/factory/repositories");
  const sourceReference = `api:${scope.actor}:${Date.now()}`;

  const input = {
    organizationId: scope.organizationId,
    repositoryId,
    sourceType: "api",
    sourceReference,
    title,
    description,
    riskLevel,
    rails,

    createdByPrincipalId: scope.principalId,
    ...(modelOverride ? { modelOverride } : {}),
    ...(chosenPlaybook ? { playbook: snapshotPlaybook(chosenPlaybook) } : {}),
  } as const;
  const startRun = { startRun: (runId: string) => deps.control.enqueue(runId) };

  if (idempotencyKey === undefined) {
    const repository = await grantedRepository(deps.pool, scope.organizationId, repositoryId);
    if (!repository) return notFound("repository");
    const created = await createTaskFromIntake(deps.pool, input, startRun);
    await pair(deps.pool, created.taskId);
    return handOver(deps, { taskId: created.taskId, engineeringRunId: created.runId }, created.afterCommit);
  }

  const hash = requestHash(body);
  type Outcome =
    | { kind: "replay"; claim: Extract<IdempotencyClaim, { claimed: false }> }
    | { kind: "refused"; result: ApiResult }
    | { kind: "created"; deliveryKey: string; created: Awaited<ReturnType<typeof createTaskFromIntake>> };

  const outcome: Outcome = await transact<Outcome>(deps.pool, async (client, rollback) => {
    const claim = await claimIdempotencyKey(client, {
      principalId: scope.principalId,
      key: idempotencyKey,
      organizationId: scope.organizationId,
      requestHash: hash,
    });
    if (!claim.claimed) return rollback({ kind: "replay", claim });
    if (!(await grantedRepository(client, scope.organizationId, repositoryId))) {
      return rollback({ kind: "refused", result: notFound("repository") });
    }
    const created = await createTaskFromIntake(client, input, startRun);
    await pair(client, created.taskId);
    await recordDelivery(client, "api", claim.deliveryKey, { engineeringTaskId: created.taskId });

    await storeIdempotentResponse(
      client,
      claim.deliveryKey,
      accepted({ taskId: created.taskId, engineeringRunId: created.runId, enqueued: false }),
    );
    return { kind: "created", deliveryKey: claim.deliveryKey, created };
  });

  if (outcome.kind === "refused") return outcome.result;
  if (outcome.kind === "replay") return replayIdempotent(deps, outcome.claim, hash);

  const { created, deliveryKey } = outcome;
  const result = await handOver(deps, { taskId: created.taskId, engineeringRunId: created.runId }, created.afterCommit);
  if (result.status === 202) {

    await storeIdempotentResponse(deps.pool, deliveryKey, { status: result.status, body: result.body }).catch(
      (err: unknown) => logLine("idempotent response not stored", { deliveryKey, ...describeError(err) }),
    );
  }
  return result;
}

async function replayIdempotent(
  deps: ApiDeps,
  replay: Extract<IdempotencyClaim, { claimed: false }>,
  hash: string,
): Promise<ApiResult> {
  if (replay.requestHash !== hash) {
    return {
      status: 422,
      body: {
        error: "this Idempotency-Key was already used with a different request body",
        code: "idempotency_key_reused",
      } satisfies ApiError,
    };
  }
  if (!replay.response) {

    return conflict("the request this Idempotency-Key made left no answer to replay", "idempotency_key_orphaned");
  }
  if (replay.engineeringTaskId) {
    try {
      const first = await firstRunOfTask(deps.pool, replay.engineeringTaskId);
      if (first?.status === "CREATED") await deps.control.enqueue(first.id);
    } catch (err) {
      logLine("idempotent replay could not re-enqueue its run", {
        engineeringTaskId: replay.engineeringTaskId,
        ...describeError(err),
      });
    }
  }
  return { status: replay.response.status, body: replay.response.body, headers: { "idempotent-replayed": "true" } };
}

export async function createRun(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const taskId = stringField(body, "taskId");
  if (!taskId) return badRequest("taskId is required", "missing_field");
  const rails = railsFrom(body);
  if ("status" in rails) return rails;

  const { parseTaskModelOverride } = await import("@windkeel/factory/models");
  const modelOverride = parseTaskModelOverride((body as Record<string, unknown> | null)?.["models"]);
  const existing = await taskInOrganization(deps.pool, scope.organizationId, taskId);
  if (!existing) return notFound("task");
  if (modelOverride) {
    const refused = refusedHarness(deps, modelOverride) ?? (await refusedCredential(deps, scope, modelOverride));
    if (refused) return refused;
  }

  if (!(await taskRepositoryGranted(deps.pool, taskId))) return repositoryNoLongerGranted();

  const page = await listRunsPage(deps.pool, { organizationId: scope.organizationId, taskId, limit: 200 });
  const live = page.items.find((candidate: { terminal: boolean }) => !candidate.terminal);
  if (live) {

    if (live.status === "CREATED" && !modelOverride) return handOver(deps, { taskId, engineeringRunId: live.id });
    return conflict(`run ${live.id} is still ${live.status}`, "run_in_flight");
  }
  const started = await deps.control.startRun(taskId, scope.actor, rails, modelOverride);
  return handOver(deps, { taskId, engineeringRunId: started.engineeringRunId });
}

async function handOver(
  deps: ApiDeps,
  created: { taskId: string; engineeringRunId: string },
  enqueue: () => Promise<{ enqueued: boolean }> = () => deps.control.enqueue(created.engineeringRunId),
): Promise<ApiResult> {
  let enqueued: boolean;
  try {
    ({ enqueued } = await enqueue());
  } catch (err) {

    logLine("run hand-over failed", { engineeringRunId: created.engineeringRunId, ...describeError(err) });
    return {
      status: 503,
      body: {
        error:
          `run ${created.engineeringRunId} was created but could not be handed to the workflow; ` +
          "POST /v1/runs with this task id retries it",
        code: "enqueue_failed",
        ...created,
      } satisfies ApiError,
    };
  }
  return accepted({ ...created, enqueued });
}

const logLine = defaultLog;

function railsFrom(body: unknown): RailsOptions | ApiResult {
  const spend = field(body, "spendCapUsd");
  const wall = field(body, "wallClockCapSeconds");
  if (spend !== undefined && !(typeof spend === "number" && Number.isFinite(spend) && spend > 0)) {
    return badRequest("spendCapUsd must be a positive number of dollars; runs are never uncapped here", "invalid_field");
  }
  if (wall !== undefined && !(typeof wall === "number" && Number.isInteger(wall) && wall > 0)) {
    return badRequest("wallClockCapSeconds must be a positive whole number of seconds", "invalid_field");
  }
  return {
    ...(spend !== undefined ? { spendCapUsd: spend } : {}),
    ...(wall !== undefined ? { wallClockCapSeconds: wall } : {}),
  };
}
