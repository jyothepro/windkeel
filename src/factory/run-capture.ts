import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Pool } from "pg";
import { loadSessionBinding } from "./workflow/session-binding.js";
import { listWorkspaces } from "./repositories.js";
import type { SandboxHandle, SandboxProvider } from "../sandbox/provider.js";
import { providersFromEnv } from "./sandbox-providers.js";

const MAX_ARTEFACT_BYTES = 32 * 1024 * 1024;

export function captureObjectKey(engineeringRunId: string): string {
  return `captures/${engineeringRunId}`;
}

export interface CaptureRunOptions {
  pool: Pool;
  runId: string;
  out: string;
  providers?: Record<string, SandboxProvider>;
  maxBytes?: number;
}

export type CaptureResult =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "captured";
      providerHandle: string;
      scratchDir: string;
      maxBytes: number;
      files: CapturedFile[];
    };

export interface CapturedFile {
  path: string;
  bytes: number;
  written: boolean;
  escaped?: boolean;
}

function containedIn(root: string, rel: string): boolean {
  const target = resolve(root, rel);
  return target === root || target.startsWith(root + sep);
}

async function writeArtefact(out: string, rel: string, data: Buffer | string): Promise<void> {
  const target = join(out, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

async function captureScratch(
  handle: SandboxHandle,
  scratchDir: string,
  out: string,
  maxBytes: number,
): Promise<CapturedFile[]> {
  const listed = await handle.listFiles(scratchDir);
  const captured: CapturedFile[] = [];
  for (const entry of listed.sort((a, b) => a.path.localeCompare(b.path))) {
    if (!containedIn(join(out, "sandbox"), entry.path)) {
      captured.push({ path: entry.path, bytes: entry.bytes, written: false, escaped: true });
      continue;
    }
    if (entry.bytes > maxBytes) {
      captured.push({ path: entry.path, bytes: entry.bytes, written: false });
      continue;
    }
    const data = await handle.readFile(`${scratchDir}/${entry.path}`);
    await writeArtefact(out, join("sandbox", entry.path), data);
    captured.push({ path: entry.path, bytes: entry.bytes, written: true });
  }
  return captured;
}

export async function captureRun(options: CaptureRunOptions): Promise<CaptureResult> {
  const out = resolve(options.out);
  const { pool, runId } = options;
  const unavailable = (reason: string): CaptureResult => ({ kind: "unavailable", reason });

  const binding = await loadSessionBinding(pool, runId);
  if (!binding) {
    return unavailable(
      `no worker session binding for run ${runId} — either the run never started a worker ` +
        "session, or it finished and released it (session-binding.ts deletes the row when the " +
        "run releases the session). Nothing to capture.",
    );
  }

  const scratchDir = binding.sessionRef.adapterState["scratchDir"];
  if (typeof scratchDir !== "string") {
    return unavailable(
      `the "${binding.workerType}" session reference for run ${runId} records no scratch ` +
        "directory, so there is no transcript to read. Only the Codex adapter keeps one.",
    );
  }

  const workspaces = await listWorkspaces(pool, runId);
  const maker = workspaces.find((w) => w.role === "maker");
  if (!maker) return unavailable(`run ${runId} has no maker workspace recorded`);
  if (!maker.providerHandle) {
    return unavailable(
      `the maker workspace for run ${runId} has no provider handle, so there is nothing to ` +
        "attach to — the sandbox was never recorded, or has already been reaped",
    );
  }

  const provider = (options.providers ?? providersFromEnv())[maker.sandboxProvider];
  if (!provider) {
    return unavailable(
      `the maker workspace was made by the "${maker.sandboxProvider}" provider, which is not ` +
        "configured in this deployment (for Vercel: WINDKEEL_SANDBOX_TOKEN, WINDKEEL_SANDBOX_TEAM_ID, " +
        "WINDKEEL_SANDBOX_PROJECT_ID)",
    );
  }
  if (!provider.capabilities.reattachable) {
    return unavailable(`the "${maker.sandboxProvider}" provider cannot reattach to a sandbox from another process`);
  }

  let handle: SandboxHandle;
  try {
    handle = await provider.attach({ role: "maker", handleId: maker.providerHandle });
  } catch (error) {
    return unavailable(
      `could not attach to the maker sandbox (${maker.providerHandle}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "A reaped sandbox is the common reason, and its transcript is gone with it.",
    );
  }

  const maxBytes = options.maxBytes ?? MAX_ARTEFACT_BYTES;
  const files = await captureScratch(handle, scratchDir, out, maxBytes);
  await writeArtefact(
    out,
    "session-ref.json",
    `${JSON.stringify(
      {
        engineeringRunId: runId,
        workerType: binding.workerType,
        resumable: binding.resumable,
        workerSessionId: binding.sessionRef.workerSessionId ?? null,
        adapterState: binding.sessionRef.adapterState,
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { kind: "captured", providerHandle: maker.providerHandle, scratchDir, maxBytes, files };
}
