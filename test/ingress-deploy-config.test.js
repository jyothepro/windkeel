/**
 * The deployment configuration for `apps/ingress`, and what can be checked about it without a
 * Vercel account.
 *
 * ## What changed in #213, and why this file changed with it
 *
 * This app used to deploy through Vercel's `api/` convention: `vercel.json` named
 * `api/webhook.ts` as a function, and Vercel's **file tracing** worked out which of the
 * repository's files to upload with it. The dangerous failure was a function that built, deployed
 * and then could not resolve `windkeel/dist/...` on its first delivery, because a workspace symlink
 * did not survive packaging — so most of this file used to be a graph walk proving every import
 * was a static literal, plus a reconstruction of the deployed tree with the symlinks replaced by
 * real directories.
 *
 * ADR-0020 needs the same deployment to serve the Workflow runtime, and that cannot be expressed
 * in `vercel.json` at all — the flow function has to declare a queue subscription, which only the
 * Build Output API can carry (see `test/workflow-deploy-build.test.js`). So the app now emits
 * `.vercel/output` itself, and both functions are **esbuild bundles**: self-contained, with no
 * tracing, no symlinks and no resolution to get wrong.
 *
 * That retires an entire class of failure, and with it most of the old file. What replaces it is
 * better, because it reads the artifact rather than predicting it: the bundle is imported as
 * deployed, and its *contents* are asserted.
 *
 * ## The invariant worth having now
 *
 * ADR-0002 §3 says the ingress "never orchestrates", and ADR-0020's hardest consequence is that
 * one deployment now holds both halves. The environment cannot separate them — Vercel scopes
 * variables per project, not per function, and the Vercel World forces producer and consumer into
 * one deployment (ADR-0020, as amended by #213). **The code still can**, and that is what the
 * middle tests here pin: the internet-facing webhook's bundle contains no sandbox SDK, no object
 * store client and no agent adapter, while the flow function's contains all three.
 *
 * It holds for a reason rather than by luck. `vercel-flow.ts`'s `tick` reaches the stage graph
 * through `import("./deployed-runner.js")` inside the step body; the webhook imports `startRun`
 * and never references `tick`, so esbuild eliminates the step body and everything under it.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

const INGRESS = join(repoRoot, "apps", "ingress");
const OUTPUT = join(INGRESS, ".vercel", "output");
const WEBHOOK_FUNC = join(OUTPUT, "functions", "api", "webhook.func");
const FLOW_FUNC = join(OUTPUT, "functions", ".well-known", "workflow", "v1", "flow.func");

/**
 * The emitted directory, built once for this file. `test/workflow-deploy-build.test.js` builds it
 * too; both files need it and neither can assume the other ran first, so each builds. It is a few
 * seconds and it is the only honest way to assert on an artifact.
 */
test("the deployment build emits both functions", () => {
  execFileSync("npm", ["run", "-w", "@windkeel/ingress", "build:vercel"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  assert.ok(existsSync(join(WEBHOOK_FUNC, "index.mjs")), "no webhook function was emitted");
  assert.ok(existsSync(join(FLOW_FUNC, "index.mjs")), "no flow function was emitted");
});

test("vercel.json builds from the repository root and then emits the Build Output", () => {
  const config = JSON.parse(readFileSync(join(INGRESS, "vercel.json"), "utf8"));

  // `apps/ingress/src` imports `windkeel/dist/factory/...`, which the ingress's own tsc does not
  // produce. Building only this workspace is the single most likely way to get a deploy that
  // fails at build with a module-not-found — or worse, succeeds against a stale dist.
  assert.match(
    config.buildCommand,
    /cd \.\.\/\.\.\s*&&\s*npm run build/,
    "buildCommand must build from the repository root: the ingress imports windkeel/dist/*, which " +
      "only the root build produces, and the root build sequences @windkeel/verification first.",
  );
  assert.match(
    config.buildCommand,
    /build:vercel/,
    "without build:vercel there is no .vercel/output, so Vercel falls back to the api/ " +
      "convention: the webhook would deploy, the flow function would not exist, and runs " +
      "started against the deployment would never execute.",
  );
  assert.match(config.installCommand, /cd \.\.\/\.\.\s*&&\s*npm install/);

  /**
   * Both are ignored under the Build Output API and were removed rather than left as decoration.
   * A stale `functions` block naming a `maxDuration` that is silently not applied is exactly the
   * sort of thing someone later reads as the truth.
   */
  assert.equal(config.functions, undefined);
  assert.equal(config.outputDirectory, undefined);

  assert.ok(
    readFileSync(join(INGRESS, "public", "index.html"), "utf8").includes("/api/webhook"),
    "public/index.html is the cheapest 'did this deploy route' check, and should say what this " +
      "deployment is.",
  );
});

const bundleOf = (dir) => readFileSync(join(dir, "index.mjs"), "utf8");

/**
 * ADR-0002 §3's seam, at the only level where it still exists.
 *
 * A sandbox SDK, an S3 client or a Codex adapter appearing in the *webhook's* bundle would mean
 * the function GitHub can reach has acquired the ability to do the work of a run — which is both
 * the architectural leak ADR-0002 §3 forbids and a materially larger internet-facing attack
 * surface than the deployment already has.
 */
test("the webhook's bundle cannot execute a stage", () => {
  const webhook = bundleOf(WEBHOOK_FUNC);
  for (const marker of ["@vercel/sandbox", "@aws-sdk/client-s3", "CodexWorkerAdapter"]) {
    assert.equal(
      webhook.includes(marker),
      false,
      `${marker} reached the webhook bundle. The ingress starts runs and never executes them ` +
        "(ADR-0002 §3). Check whether something now imports the stage graph at module scope — " +
        "`tick`'s import() of deployed-runner.js is what keeps this out, and it only works " +
        "while nothing the webhook imports references `tick`.",
    );
  }
});

/**
 * The other half, and the reason the test above is a boundary rather than a coincidence: the
 * things absent from the webhook are present *somewhere*, because a stage genuinely needs them.
 */
test("the flow function's bundle can", () => {
  const flow = bundleOf(FLOW_FUNC);
  for (const marker of ["@vercel/sandbox", "@aws-sdk/client-s3", "CodexWorkerAdapter"]) {
    assert.ok(flow.includes(marker), `${marker} is missing from the flow bundle`);
  }
});

/** One Node release for both functions, pinned where the Build Output API actually reads it. */
test("both functions pin the same Node runtime", () => {
  for (const dir of [WEBHOOK_FUNC, FLOW_FUNC]) {
    const config = JSON.parse(readFileSync(join(dir, ".vc-config.json"), "utf8"));
    assert.equal(config.runtime, "nodejs22.x");
  }
});

/**
 * The substance, and the direct descendant of the old symlink-reconstruction test: the thing that
 * gets deployed is imported exactly as deployed. Whatever this says is what a real deployment
 * would return a 500 for, on GitHub's first delivery and every retry after it.
 *
 * Much stronger than the version it replaces, and much shorter, for the same reason: the bundle
 * is self-contained, so there is no deployed tree left to reconstruct and get subtly wrong.
 */
test("the emitted webhook function imports as deployed", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const script =
    `import(${JSON.stringify(join(WEBHOOK_FUNC, "index.mjs"))})` +
    `.then((m) => process.stdout.write(typeof m.default === "function" ? "OK" : "NO HANDLER"))` +
    `.catch((error) => process.stdout.write("FAILED: " + error.message))`;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: WEBHOOK_FUNC,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      DATABASE_URL: "postgresql://user:password@localhost:5432/windkeel",
      GITHUB_WEBHOOK_SECRET: "a-webhook-secret",
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  });

  assert.equal(output, "OK", output);
});

// --- the schedule tick (M8-4, #296) -----------------------------------------------------------

const SCHEDULES_FUNC = join(OUTPUT, "functions", "api", "schedules.func");

/**
 * Every five minutes: a slot fires at most five minutes late (docs/schedules.md). Declared beside
 * the hourly sweep, not in place of it — merging `config.json` must keep both crons and the SDK's
 * workflow routes.
 */
test("the schedule tick is its own function on a five-minute cron, beside the sweep", () => {
  assert.ok(existsSync(join(SCHEDULES_FUNC, "index.mjs")), "schedules.func missing: a declared cron would be a scheduled 404");
  const config = JSON.parse(readFileSync(join(OUTPUT, "config.json"), "utf8"));
  const crons = config.crons ?? [];
  assert.deepEqual(
    crons.filter((c) => c.path === "/api/schedules"),
    [{ path: "/api/schedules", schedule: "*/5 * * * *" }],
  );
  assert.ok(crons.some((c) => c.path === "/api/sweep"), "the sweep cron was lost");
  assert.ok(config.routes.some((r) => String(r.dest ?? "").includes("workflow")), "the workflow routes were lost");
  const vc = JSON.parse(readFileSync(join(SCHEDULES_FUNC, ".vc-config.json"), "utf8"));
  assert.equal(vc.runtime, "nodejs22.x");
});

/** It creates tasks and enqueues runs; like the webhook, it never executes one (ADR-0002 §3). */
test("the schedule tick's bundle cannot execute a stage", () => {
  const bundle = bundleOf(SCHEDULES_FUNC);
  for (const marker of ["@vercel/sandbox", "@aws-sdk/client-s3", "CodexWorkerAdapter"]) {
    assert.equal(bundle.includes(marker), false, `${marker} reached the schedules bundle`);
  }
});

/** It creates tasks that spend money, so it fails closed exactly as the sweep does. */
test("the schedule tick refuses without the cron secret, before touching a database", async () => {
  const { default: handler } = await import("../apps/ingress/dist/api/schedules.js");
  const previous = process.env.CRON_SECRET;
  const call = async (headers) => {
    const out = {};
    const res = {
      status(code) {
        out.code = code;
        return res;
      },
      json(body) {
        out.body = body;
      },
    };
    await handler({ headers }, res);
    return out;
  };
  try {
    delete process.env.CRON_SECRET;
    assert.deepEqual(await call({ authorization: "Bearer " }), { code: 401, body: { ok: false } });
    assert.deepEqual(await call({}), { code: 401, body: { ok: false } });
    process.env.CRON_SECRET = "the-cron-secret";
    assert.deepEqual(await call({ authorization: "Bearer wrong-secret" }), { code: 401, body: { ok: false } });
    assert.deepEqual(await call({ authorization: "the-cron-secret" }), { code: 401, body: { ok: false } });
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
