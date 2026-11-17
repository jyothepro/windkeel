export interface EnvironmentSnapshotView {
  id: string;
  status: "building" | "ready" | "failed" | "invalidated" | "expired";
  sandboxProvider: string;
  cacheKey: string;
  baseSha: string;
  sizeBytes: number | null;
  detail: string | null;
  setupLogRef: string | null;
  builtBy: string;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface RepositoryEnvironment {
  items: EnvironmentSnapshotView[];
  current: EnvironmentSnapshotView | null;
  pendingRequest: { requestedBy: string; reason: string; requestedAt: string } | null;
  proposedSetup: { setup: Record<string, unknown>; reasons: string[] } | null;
}

export function environmentHeadline(env: RepositoryEnvironment): string {
  const building = env.items.find((s) => s.status === "building");
  if (env.current) {
    return `Runs start warm from a snapshot built at ${env.current.baseSha.slice(0, 7)}.` + (building ? " A newer one is building." : "");
  }
  if (building) return "A snapshot is building. Runs start cold until it's ready.";
  if (env.pendingRequest) return "A build is queued. Runs start cold until it's ready.";
  const failed = env.items[0]?.status === "failed" ? env.items[0] : null;
  if (failed) return "The last build failed. Runs start cold.";
  return "No snapshot. Runs start cold.";
}

export function statusLabel(status: EnvironmentSnapshotView["status"]): string {
  return { building: "Building", ready: "Ready", failed: "Failed", invalidated: "Invalidated", expired: "Expired" }[status];
}

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function suggestedPatch(env: RepositoryEnvironment): string | null {
  const setup = env.proposedSetup?.setup as { commands?: unknown[]; services?: unknown[] } | undefined;
  if (!setup || (!setup.commands?.length && !setup.services?.length)) return null;
  return JSON.stringify({ setup: env.proposedSetup!.setup }, null, 2);
}

export function workspaceEnvironmentLabel(mode: "snapshot" | "cold" | null | undefined, snapshotId?: string | null): string | null {
  if (!mode) return null;
  return mode === "snapshot" ? `warm (snapshot ${(snapshotId ?? "").slice(0, 8)})` : "cold";
}
