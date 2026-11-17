/**
 * A running factory, for the end-to-end suites — what `createFactoryWorker` used to be.
 *
 * ## Why this replaced a container
 *
 * Until #200 the e2e suites built an `apps/worker` container: it owned a
 * `PgBossWorkflowProvider`, a retention scheduler, a health server, and a SIGTERM path that
 * destroyed every sandbox it still held. ADR-0020 deletes that container, so a suite that keeps
 * building one is testing a topology that no longer exists.
 *
 * What is left is the part that was never container-shaped: a stage-handler graph and a provider.
 * `src/factory/workflow/deployed-runner.ts` assembles exactly these two things on the deployed
 * control plane, and this module assembles the same pair — so the suites now drive the code a
 * deployment runs, rather than a container wrapper around it.
 *
 * ## What deliberately disappeared with the container, and where it went
 *
 * | The container did | Now |
 * |---|---|
 * | Ran the ADR-0015 retention sweep on an interval | `apps/ingress/api/sweep.ts`, hourly cron (#226) |
 * | Destroyed its live sandboxes on SIGTERM | The sandbox reaper (#198), on the same cron |
 * | Served a health endpoint | Nothing — liveness is "are runs progressing" (ADR-0020) |
 *
 * The middle row is a real behaviour change and the suites assert the new shape rather than the
 * old one. A process that goes away mid-run **no longer tears its sandboxes down**, because on a
 * step-per-invocation backing there is no process that outlives a stage to do it in. A sandbox
 * nobody holds is destroyed by the reaper, and "no sandbox is left billing" is now a statement
 * about the reaper rather than about a shutdown handler. That is strictly more honest: the old
 * teardown only ever worked for a graceful stop, and the e2e suite's own abrupt-kill case
 * documented that an abruptly-killed container leaked until `expires_at`.
 */

import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import { buildStageDeps, registerStageHandlers } from "../dist/factory/stage-wiring.js";
import { workflowRuntime } from "./workflow-runtime.js";

/**
 * Builds and starts one factory against the shared loopback runtime.
 *
 * `config` is a `WorkerConfig` — the same shape `loadWorkerConfig()` produces, because the
 * handler graph reads it and a test that invented a narrower shape would drift from what a
 * deployment actually passes.
 *
 * `overrides` goes straight to `buildStageDeps`: `sandboxes`, `worker`, `github`, `log`.
 *
 * `applicationSchema` is the per-test Postgres schema. It is passed to the provider explicitly
 * rather than being left to a `search_path` in the connection string, because the provider opens
 * its **own** pool and only honours the option it is given.
 */
export async function startFactory(config, { applicationSchema, ...overrides } = {}) {
  const { world } = await workflowRuntime();
  const wiring = buildStageDeps(config, { log: () => {}, ...overrides });

  const provider = new VercelWorkflowProvider({
    connectionString: config.databaseUrl,
    ...(applicationSchema ? { applicationSchema } : {}),
    world,
    // A parked run must not hold a suite open for five minutes. `wakeUp` still does the real
    // work; this only bounds the case where nothing ever arrives.
    //
    // It travels with the execution, so it applies only to runs **this** provider starts. A run
    // the ingress enqueues (`runEnqueuer`) is started with the production 300 s, which is what
    // made a lost wake in `e2e-github-loop` a two-minute timeout rather than a 2 s hiccup (#279).
    waitSleepMs: 2_000,
    retrySleepMs: 50,
  });
  registerStageHandlers(provider, wiring.deps);
  await provider.start();

  return {
    provider,
    deps: wiring.deps,
    pool: wiring.pool,
    registry: wiring.registry,

    /**
     * Lets go of this process's half of the factory.
     *
     * Deliberately **not** a teardown of anything the run owns: no sandbox is destroyed and no
     * workspace row is marked. That is the reaper's job now, and a stop that quietly did it here
     * would hide the very gap the reaper exists to fill.
     */
    async stop() {
      await provider.stop().catch(() => {});
      await wiring.pool.end().catch(() => {});
    },
  };
}
