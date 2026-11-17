import { createHash } from "node:crypto";
import type { SetupSpec } from "@windkeel/verification/config.js";
import { INSTALL_CONFIG_PATHSPECS, INSTALL_INPUT_PATHS } from "./dependencies.js";
import { HARDENED_GIT_ARGS, HARDENED_GIT_ENV } from "./git-hardening.js";
import type { SandboxHandle } from "./provider.js";

export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotKeyInputs {
  formatVersion?: number;
  provider: { name: string; image: string };
  setup: SetupSpec | null;
  blobs: Readonly<Record<string, string>>;
  secrets: ReadonlyArray<{ key: string; updatedAt: Date | string }>;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function computeSnapshotKey(inputs: SnapshotKeyInputs): string {
  const canonical = canonicalJson({
    formatVersion: inputs.formatVersion ?? SNAPSHOT_FORMAT_VERSION,
    provider: inputs.provider,
    setup: inputs.setup,
    blobs: inputs.blobs,
    secrets: [...inputs.secrets]
      .map((s) => ({ key: s.key, updatedAt: new Date(s.updatedAt).toISOString() }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function snapshotKeyPaths(setup: SetupSpec | null): string[] {
  return [
    ...new Set([
      "windkeel.config.json",
      "orqon.config.json",
      ...INSTALL_INPUT_PATHS.map((path) => `:(glob)**/${path}`),
      ...INSTALL_CONFIG_PATHSPECS,
      ...(setup?.cacheKeyFiles ?? []).map((path) => `:(literal)${path}`),
    ]),
  ];
}

function matchesKeyPath(path: string, pathspecs: readonly string[]): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return pathspecs.some((spec) => {
    if (spec.startsWith(":(literal)")) return path === spec.slice(":(literal)".length);
    if (!spec.startsWith(":(glob)")) return path === spec;
    const glob = spec.slice(":(glob)".length);
    if (glob.startsWith("**/")) return base === glob.slice(3);
    if (glob.endsWith("/**")) return path.startsWith(glob.slice(0, -2));
    return path === glob;
  });
}

export async function readKeyBlobs(
  handle: SandboxHandle,
  sha: string,
  setup: SetupSpec | null,
): Promise<Record<string, string>> {
  const listed = await handle.exec("git", {
    args: [...HARDENED_GIT_ARGS, "ls-tree", "-r", "-z", "--full-tree", sha],
    cwd: handle.checkoutPath,
    env: { ...HARDENED_GIT_ENV },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `environment snapshot: could not list the key's files at ${sha}: ${listed.error ?? (listed.stderr.trim() || `exit ${listed.status}`)}`,
    );
  }
  const paths = snapshotKeyPaths(setup);
  const blobs: Record<string, string> = {};
  for (const entry of listed.stdout.split("\0")) {
    const match = /^\d+ (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (match && matchesKeyPath(match[3]!, paths)) blobs[match[3]!] = match[2]!;
  }
  return blobs;
}
