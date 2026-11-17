import { ApiError, type WindkeelApi } from "../client/api.js";
import { printRefusal, type RemoteIo } from "./remote.js";

export const ENV_USAGE =
  "usage: windkeel env status     --repo <owner/name|repository-id> [--json]\n" +
  "       windkeel env rebuild    --repo <owner/name|repository-id>\n" +
  "       windkeel env invalidate --repo <owner/name|repository-id>\n";

export interface EnvironmentSnapshotView {
  id: string;
  status: string;
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

export interface EnvironmentView {
  items: EnvironmentSnapshotView[];
  current: EnvironmentSnapshotView | null;
  pendingRequest: { requestedBy: string; reason: string; requestedAt: string } | null;
  proposedSetup: { setup: Record<string, unknown>; reasons: string[] } | null;
}

export type EnvAction =
  | { kind: "status"; repo: string; json?: boolean }
  | { kind: "rebuild"; repo: string }
  | { kind: "invalidate"; repo: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveRepositoryId(api: WindkeelApi, repo: string): Promise<string | null> {
  if (UUID.test(repo)) return repo;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const listed = await api.listRepositories(cursor);
    const found = listed.items.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
    if (found) return found.id;
    if (!listed.hasNextPage || !listed.endCursor) return null;
    cursor = listed.endCursor;
  }
  return null;
}

const short = (value: string | null | undefined, n = 12) => (value ? value.slice(0, n) : "—");
const size = (bytes: number | null) =>
  bytes === null ? "—" : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;

export async function envCommand(api: WindkeelApi, io: RemoteIo, action: EnvAction): Promise<number> {
  try {
    const repositoryId = await resolveRepositoryId(api, action.repo);
    if (!repositoryId) {
      io.err(`no repository ${action.repo} is granted to this organization`);
      return 1;
    }
    const path = `/v1/repositories/${repositoryId}/environment`;
    if (action.kind === "rebuild") {
      const answer = await api.post<{ started?: boolean }>(`${path}/rebuild`);
      io.out(
        answer.started
          ? `Rebuild started for ${action.repo}; the next run after it finishes restores it.`
          : `Rebuild requested for ${action.repo}; the next sweep starts it.`,
      );
      return 0;
    }
    if (action.kind === "invalidate") {
      const answer = await api.post<{ invalidated: number }>(`${path}/invalidate`);
      io.out(`Invalidated ${answer.invalidated} snapshot(s) of ${action.repo}; the next run is cold.`);
      return 0;
    }
    const view = await api.get<EnvironmentView>(path);
    if (action.json) {
      io.out(JSON.stringify(view, null, 2));
      return 0;
    }
    io.out(view.current ? `Current: ${view.current.id} (ready ${view.current.readyAt ?? "—"})` : "Current: none — runs are cold");
    if (view.pendingRequest) io.out(`Pending build: ${view.pendingRequest.reason}`);
    if (view.items.length) {
      io.out("");
      io.out(`${"STATUS".padEnd(13)}${"KEY".padEnd(14)}${"COMMIT".padEnd(14)}${"SIZE".padEnd(10)}DETAIL`);
      for (const s of view.items) {
        io.out(`${s.status.padEnd(13)}${short(s.cacheKey).padEnd(14)}${short(s.baseSha).padEnd(14)}${size(s.sizeBytes).padEnd(10)}${(s.detail ?? "").slice(0, 120)}`);
      }
    }
    if (view.proposedSetup && (view.proposedSetup.reasons.length || Object.keys(view.proposedSetup.setup).length)) {
      io.out("");
      io.out("Suggested windkeel.config.json `setup` (a draft — review it, then commit it on the default branch):");
      io.out(JSON.stringify({ setup: view.proposedSetup.setup }, null, 2));
      for (const reason of view.proposedSetup.reasons) io.out(`  · ${reason}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      printRefusal(io, err);
      return 1;
    }
    throw err;
  }
}
