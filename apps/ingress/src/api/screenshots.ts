

import { runInOrganization } from "@windkeel/factory/tenancy";
import type { Page } from "@windkeel/factory/runs";
import { notFound, ok, type ApiDeps, type ApiError, type ApiResult, type Scope } from "./handlers.js";

export interface MakerScreenshotStore {
  read(engineeringRunId: string, sha256: string): Promise<Buffer>;
}

export interface MakerScreenshotView {
  id: string;
  name: string | null;
  url: string | null;
  pageTitle: string | null;
  consoleErrors: string[];
  capturedAt: string;
  bytes: number;

  evidence: false;
}

export async function runScreenshots(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  const { listMakerScreenshots } = await import("@windkeel/factory/runs");
  const items: MakerScreenshotView[] = (await listMakerScreenshots(deps.pool, runId)).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    pageTitle: s.pageTitle,
    consoleErrors: s.consoleErrors,
    capturedAt: new Date(s.capturedAt).toISOString(),
    bytes: s.bytes,
    evidence: false,
  }));
  return ok({ items, endCursor: null, hasNextPage: false } satisfies Page<MakerScreenshotView>);
}

const SCREENSHOT_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "image/png",
  "content-disposition": "inline",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "private, max-age=300",
};

export async function runScreenshotFile(
  deps: ApiDeps,
  scope: Scope,
  runId: string,
  screenshotId: string,
): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  const { getMakerScreenshot, isPng } = await import("@windkeel/factory/runs");
  const shot = await getMakerScreenshot(deps.pool, runId, screenshotId);
  if (!shot) return notFound("screenshot");
  if (!deps.makerScreenshots) {
    return {
      status: 503,
      body: {
        error: "this deployment has no object store configured, so screenshots cannot be served",
        code: "storage_unconfigured",
      } satisfies ApiError,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await deps.makerScreenshots.read(runId, shot.sha256);
  } catch {
    return notFound("screenshot file");
  }
  if (!isPng(bytes)) {
    return { status: 415, body: { error: "the stored screenshot is not a PNG", code: "not_png" } satisfies ApiError };
  }
  return { status: 200, body: bytes, headers: { ...SCREENSHOT_HEADERS, "content-length": String(bytes.length) } };
}
