import type { Page } from "@windkeel/api-contract";
import { runInOrganization } from "@windkeel/factory/tenancy";
import { TERMINAL_STATES } from "@windkeel/factory/runs";
import type { SandboxProvider } from "@windkeel/factory/sandbox";
import { type ApiDeps, type ApiError, type ApiResult, type Query, type Scope, badRequest, conflict, notFound, ok, storageUnconfigured } from "./common.js";

const CAPTURE_URL_TTL_SECONDS = 300;

export async function captureRun(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  if (!deps.captures) return storageUnconfigured();
  const reached = await sandboxProviders(deps);
  if ("refused" in reached) return reached.refused;
  const { providers } = reached;

  const [{ captureRun: capture, captureObjectKey }, { mkdtemp, rm }, { tmpdir }, { join }] = await Promise.all([
    import("@windkeel/factory/execution"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  const dir = await mkdtemp(join(tmpdir(), "windkeel-capture-"));
  try {
    const result = await capture({ pool: deps.pool, runId, out: dir, providers });
    if (result.kind === "unavailable") return conflict(result.reason, "capture_unavailable");
    const key = captureObjectKey(runId);
    await deps.captures.put(dir, key);

    const { recordRunCapture } = await import("@windkeel/factory/runs");
    await recordRunCapture(deps.pool, {
      engineeringRunId: runId,
      bucket: deps.captures.bucket,
      objectKey: key,
      byteTotal: await directoryBytes(dir),
    });
    return ok({ engineeringRunId: runId, ...result, stored: (await deps.captures.list(key)).sort() });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function directoryBytes(dir: string): Promise<number> {
  const [{ readdir, stat }, { join }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

export async function runCapture(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  if (!deps.captures) return storageUnconfigured();
  const [{ captureObjectKey }, { getRunCapture, captureExpiresAt }] = await Promise.all([
    import("@windkeel/factory/execution"),
    import("@windkeel/factory/runs"),
  ]);
  const record = await getRunCapture(deps.pool, runId);
  const page = (items: string[]) => ({ items, endCursor: null, hasNextPage: false }) satisfies Page<string>;
  if (record?.prunedAt) {
    return ok({
      ...page([]),
      state: "pruned",
      capturedAt: record.capturedAt,
      prunedAt: record.prunedAt,
      expiresAt: null,
      byteTotal: record.byteTotal,
    });
  }
  const items = (await deps.captures.list(captureObjectKey(runId))).sort();
  return ok({
    ...page(items),
    state: record || items.length > 0 ? "stored" : "never_captured",
    capturedAt: record?.capturedAt ?? null,
    prunedAt: null,
    expiresAt: record ? captureExpiresAt(record) : null,
    byteTotal: record?.byteTotal ?? null,
  });
}

export async function runCaptureFile(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
  path: string,
): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  if (!deps.captures) return storageUnconfigured();
  if (path.split("/").includes("..")) return badRequest("capture path may not contain '..'", "invalid_path");
  const [{ captureObjectKey }, { getRunCapture }] = await Promise.all([
    import("@windkeel/factory/execution"),
    import("@windkeel/factory/runs"),
  ]);
  const record = await getRunCapture(deps.pool, runId);
  if (record?.prunedAt) {

    return conflict("the capture was removed by retention policy (ADR-0015, #288)", "capture_pruned");
  }
  const key = captureObjectKey(runId);
  if (!(await deps.captures.list(key)).includes(path)) return notFound("captured file");
  const url = await deps.captures.presign(key, path, CAPTURE_URL_TTL_SECONDS);
  return { status: 302, body: { url }, headers: { location: url } };
}

export async function runWorkspace(deps: ApiDeps, scope: Scope, runId: string, query: Query): Promise<ApiResult> {
  const row = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!row) return notFound("run");
  const { readWorkspace, workspacePath } = await import("@windkeel/factory/runs");

  const parsed = workspacePath(query.get("path"));
  if ("refused" in parsed) return badRequest(parsed.refused, "invalid_path");

  if (TERMINAL_STATES.has(row.status)) {
    return conflict(`run is ${row.status}; its maker sandbox is torn down when a run ends (ADR-0017)`, "run_terminal");
  }
  const reached = await sandboxProviders(deps);
  if ("refused" in reached) return reached.refused;

  const read = await readWorkspace({ pool: deps.pool, runId, runStatus: row.status, path: parsed.path, providers: reached.providers });
  switch (read.kind) {
    case "unavailable":
      return conflict(read.reason, read.code);
    case "refused": {
      const body: Record<string, unknown> = { error: read.reason, code: read.code };
      if (read.bytes !== undefined) body["bytes"] = read.bytes;
      if (read.cap !== undefined) body["cap"] = read.cap;
      return { status: read.status, body };
    }
    default:

      return ok({ engineeringRunId: runId, ...read }, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
  }
}

export async function sandboxProviders(
  deps: ApiDeps,
): Promise<{ providers: Record<string, SandboxProvider> } | { refused: ApiResult }> {
  const unconfigured = (why: string) => ({
    refused: { status: 503, body: { error: why, code: "sandbox_unconfigured" } satisfies ApiError },
  });
  if (!deps.sandboxes) return unconfigured("this deployment reaches no sandbox provider");
  try {
    return { providers: await deps.sandboxes() };
  } catch (err) {

    return unconfigured(err instanceof Error ? err.message : String(err));
  }
}

export async function runMessages(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const exists = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!exists) return notFound("run");
  const items = await deps.control.listMessages(runId, exists.status);
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<unknown>);
}
