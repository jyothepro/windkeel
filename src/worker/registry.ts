import type { WorkerAdapter } from "./adapter.js";

export type WorkerRegistry = ReadonlyMap<string, WorkerAdapter>;

export const LEGACY_HARNESS_ID = "codex";

export const UNVERSIONED = "unversioned";

export interface RunHarness {
  id: string;
  version: string;
}

export class HarnessUnavailableError extends Error {
  override readonly name = "HarnessUnavailableError";
  constructor(
    readonly harnessId: string,
    registered: readonly string[],
  ) {
    super(
      `the run's maker harness is ${harnessId}, and this deployment registers ` +
        `${registered.length > 0 ? registered.join(", ") : "no maker harness"}; it will not run on ` +
        "another agent instead (ADR-0027 §2)",
    );
  }
}

export function singleWorkerRegistry(worker: WorkerAdapter): WorkerRegistry {
  return new Map([[worker.name, worker]]);
}

export interface HasWorkers {
  readonly workers?: WorkerRegistry | undefined;
  readonly worker?: WorkerAdapter | undefined;
}

export function registryOf(deps: HasWorkers): WorkerRegistry {
  if (deps.workers) return deps.workers;
  const { worker } = deps;
  return worker ? singleWorkerRegistry(worker) : new Map();
}

export function harnessOf(
  snapshot: { maker: { worker?: string | undefined; harness?: RunHarness | undefined } } | null | undefined,
  fallbackVersion: (id: string) => string = () => UNVERSIONED,
): RunHarness {
  const frozen = snapshot?.maker.harness;
  if (frozen && typeof frozen.id === "string" && typeof frozen.version === "string") return frozen;
  const id = snapshot?.maker.worker ?? LEGACY_HARNESS_ID;
  return { id, version: fallbackVersion(id) };
}

export function workerFor(
  deps: HasWorkers,
  snapshot: { maker: { worker?: string | undefined; harness?: RunHarness | undefined } } | null | undefined,
): WorkerAdapter {
  const { workers: registered, worker: legacy } = deps;
  if (!registered && legacy) return legacy;
  const workers = registryOf(deps);
  const named = snapshot?.maker.harness?.id ?? snapshot?.maker.worker;
  if (named === undefined && workers.size === 1) return workers.values().next().value!;
  const id = named ?? LEGACY_HARNESS_ID;
  const worker = workers.get(id);
  if (!worker) throw new HarnessUnavailableError(id, [...workers.keys()]);
  return worker;
}

export function defaultHarnessId(workers: WorkerRegistry, preferred?: string): string {
  if (preferred && workers.has(preferred)) return preferred;
  return workers.keys().next().value ?? LEGACY_HARNESS_ID;
}

export function makerIneligibility(capabilities: WorkerAdapter["capabilities"]): string[] {
  const required = [
    ["resumableSessions", "a repair must resume the same session (ADR-0011 §2)"],
    ["reattachableSessions", "stages are separate invocations (#196)"],
    ["reattachedSessionsAcceptNewTurns", "a repair turn is send() on a reattached session"],
    ["pollable", "a live harness must not block a step for the whole session (#197)"],
    ["reportsUsage", "the spend rail needs token counts"],
  ] as const;
  return required.flatMap(([flag, why]) => (capabilities[flag] === true ? [] : [`${flag}: ${why}`]));
}
