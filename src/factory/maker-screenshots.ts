

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { isSafeArtifactPath } from "@windkeel/verification/evidence/paths.js";
import type { SandboxHandle } from "../sandbox/provider.js";
import { MAKER_BROWSER_OUT_DIR } from "../sandbox/maker-browser/install.js";
import { capAgentText } from "./agent-events.js";
import type { EvidenceStorage } from "./evidence-storage.js";
import { withTransaction } from "./db/transaction.js";
import { lockEngineeringRunRow } from "./stores/run-store.js";
import {
  insertMakerScreenshotRow,
  insertScreenshotAgentEvent,
  selectMakerScreenshotRow,
  selectMakerScreenshotRows,
  selectMakerScreenshotShas,
} from "./stores/maker-screenshot-store.js";

export const MAKER_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MAKER_SCREENSHOT_MAX = 50;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const INDEX_FILE = "index.jsonl";
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_CONSOLE_ERRORS = 20;
const NAME_LIMIT = 200;
const URL_LIMIT = 2000;
const TITLE_LIMIT = 500;
const CONSOLE_ERROR_LIMIT = 500;

export function makerScreenshotPrefix(engineeringRunId: string): string {
  return `maker-browser/${engineeringRunId}`;
}

export function makerScreenshotObjectKey(engineeringRunId: string, sha256: string): string {
  return `${makerScreenshotPrefix(engineeringRunId)}/${sha256}.png`;
}

export type DropReason = "unsafe_path" | "not_png" | "too_large" | "over_cap";

export interface HarvestResult {
  uploaded: Array<{ id: string; sha256: string; path: string }>;
  dropped: Array<{ path: string; reason: DropReason }>;

  skipped?: string;
}

export interface HarvestOptions {
  handle: SandboxHandle;
  engineeringRunId: string;
  agentRunId: string;
  storage: { storage: EvidenceStorage; bucket: string } | undefined;

  max?: number | undefined;
}

interface IndexEntry {
  name: string | null;
  url: string | null;
  title: string | null;
  consoleErrors: string[];
}

const str = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.length ? capAgentText(value, limit) : null;

function parseIndex(text: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || typeof raw["file"] !== "string") continue;
    const errors = Array.isArray(raw["consoleErrors"]) ? raw["consoleErrors"] : [];
    entries.set(raw["file"], {
      name: str(raw["name"], NAME_LIMIT),
      url: str(raw["url"], URL_LIMIT),
      title: str(raw["title"], TITLE_LIMIT),
      consoleErrors: errors
        .filter((e): e is string => typeof e === "string")
        .slice(0, MAX_CONSOLE_ERRORS)
        .map((e) => capAgentText(e, CONSOLE_ERROR_LIMIT)),
    });
  }
  return entries;
}

export async function harvestMakerScreenshots(pool: Pool, options: HarvestOptions): Promise<HarvestResult> {
  const result: HarvestResult = { uploaded: [], dropped: [] };
  if (!options.storage) return { ...result, skipped: "no object store is configured" };
  const { handle, engineeringRunId, agentRunId } = options;
  const max = options.max ?? DEFAULT_MAKER_SCREENSHOT_MAX;
  const dir = `${handle.checkoutPath.replace(/\/+$/, "")}/${MAKER_BROWSER_OUT_DIR}`;
  if (!(await handle.exists(dir))) return { ...result, skipped: `no ${MAKER_BROWSER_OUT_DIR} directory` };

  const files = (await handle.listFiles(dir)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const indexFile = files.find((f) => f.path === INDEX_FILE);
  const index =
    indexFile && indexFile.bytes <= MAX_INDEX_BYTES
      ? parseIndex((await handle.readFile(`${dir}/${INDEX_FILE}`)).toString("utf8"))
      : new Map<string, IndexEntry>();

  const known = new Set(await selectMakerScreenshotShas(pool, engineeringRunId));
  let kept = known.size;

  if (kept >= max) return { ...result, skipped: `the run already has its ${max} screenshot(s)` };

  let reads = 0;
  const readBudget = 2 * max;

  const accepted: Array<{ path: string; sha256: string; bytes: Buffer; meta: IndexEntry | undefined }> = [];
  for (const file of files) {
    if (file.path === INDEX_FILE) continue;
    if (!isSafeArtifactPath(file.path)) {
      result.dropped.push({ path: capAgentText(file.path, NAME_LIMIT), reason: "unsafe_path" });
      continue;
    }
    if (!file.path.toLowerCase().endsWith(".png")) {
      result.dropped.push({ path: file.path, reason: "not_png" });
      continue;
    }
    if (file.bytes > MAKER_SCREENSHOT_MAX_BYTES) {
      result.dropped.push({ path: file.path, reason: "too_large" });
      continue;
    }
    if (reads >= readBudget) {
      result.dropped.push({ path: file.path, reason: "over_cap" });
      continue;
    }
    reads += 1;
    const bytes = await handle.readFile(`${dir}/${file.path}`);

    if (bytes.length > MAKER_SCREENSHOT_MAX_BYTES) {
      result.dropped.push({ path: file.path, reason: "too_large" });
      continue;
    }
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      result.dropped.push({ path: file.path, reason: "not_png" });
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (known.has(sha256)) continue;
    if (kept >= max) {
      result.dropped.push({ path: file.path, reason: "over_cap" });
      continue;
    }
    known.add(sha256);
    kept += 1;
    accepted.push({ path: file.path, sha256, bytes, meta: index.get(file.path) });
  }
  if (accepted.length === 0) return result;

  const local = await mkdtemp(join(tmpdir(), "windkeel-maker-screenshots-"));
  try {
    for (const shot of accepted) await writeFile(join(local, `${shot.sha256}.png`), shot.bytes);
    await options.storage.storage.putPackage(local, options.storage.bucket, makerScreenshotPrefix(engineeringRunId));
  } finally {
    await rm(local, { recursive: true, force: true });
  }

  await withTransaction(pool, async (client) => {

    await lockEngineeringRunRow(client, engineeringRunId);
    for (const shot of accepted) {
      const name = shot.meta?.name ?? capAgentText(shot.path.replace(/\.png$/i, ""), NAME_LIMIT);
      const id = await insertMakerScreenshotRow(client, {
        engineeringRunId,
        agentRunId,
        sha256: shot.sha256,
        objectKey: makerScreenshotObjectKey(engineeringRunId, shot.sha256),
        bytes: shot.bytes.length,
        name,
        url: shot.meta?.url ?? null,
        pageTitle: shot.meta?.title ?? null,
        consoleErrors: JSON.stringify(shot.meta?.consoleErrors ?? []),
      });
      if (!id) continue;
      await insertScreenshotAgentEvent(
        client,
        engineeringRunId,
        agentRunId,
        JSON.stringify({ screenshotId: id, name, url: shot.meta?.url ?? null }),
      );
      result.uploaded.push({ id, sha256: shot.sha256, path: shot.path });
    }
  });
  return result;
}

export interface MakerScreenshot {
  id: string;
  engineeringRunId: string;
  agentRunId: string | null;
  sha256: string;
  objectKey: string;
  bytes: number;
  name: string | null;
  url: string | null;
  pageTitle: string | null;
  consoleErrors: string[];
  capturedAt: Date;
}

function rowToScreenshot(row: Record<string, unknown>): MakerScreenshot {
  return {
    id: row["id"] as string,
    engineeringRunId: row["engineering_run_id"] as string,
    agentRunId: (row["agent_run_id"] as string | null) ?? null,
    sha256: row["sha256"] as string,
    objectKey: row["object_key"] as string,
    bytes: Number(row["bytes"]),
    name: (row["name"] as string | null) ?? null,
    url: (row["url"] as string | null) ?? null,
    pageTitle: (row["page_title"] as string | null) ?? null,
    consoleErrors: Array.isArray(row["console_errors"]) ? (row["console_errors"] as string[]) : [],
    capturedAt: row["captured_at"] as Date,
  };
}

export async function listMakerScreenshots(pool: Pool, engineeringRunId: string): Promise<MakerScreenshot[]> {
  return (await selectMakerScreenshotRows(pool, engineeringRunId)).map(rowToScreenshot);
}

export async function getMakerScreenshot(
  pool: Pool,
  engineeringRunId: string,
  screenshotId: string,
): Promise<MakerScreenshot | null> {
  if (!/^[0-9a-f-]{36}$/i.test(screenshotId)) return null;
  const row = await selectMakerScreenshotRow(pool, engineeringRunId, screenshotId);
  return row ? rowToScreenshot(row) : null;
}

export function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}
