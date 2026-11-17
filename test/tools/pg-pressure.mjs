#!/usr/bin/env node
/**
 * Measures what the Postgres-gated test suite actually does to a database while it runs, so that
 * "the suite is flaky under parallelism" can be answered with numbers rather than a hypothesis.
 *
 * #140's leading hypothesis was connection pressure: neither the `PgBossWorkflowProvider`'s pool
 * nor pg-boss's own bounds itself, ~14 test files run concurrently, and 14 × ~20 comfortably
 * exceeds a default `max_connections = 100`. The evidence against it was that no failing run ever
 * printed `too many clients` — and the issue is explicit that this is why it is a hypothesis and
 * not a diagnosis, and that the mechanism has to be established before anything is changed.
 *
 * This is the instrument. It samples `pg_stat_activity` while `npm test` runs and reports the
 * peaks, so the hypothesis can be confirmed or refuted from data.
 *
 * ```sh
 * TEST_DATABASE_URL=postgres://… node test/tools/pg-pressure.mjs           # run the suite under it
 * TEST_DATABASE_URL=postgres://… node test/tools/pg-pressure.mjs --repeat 10
 * TEST_DATABASE_URL=postgres://… node test/tools/pg-pressure.mjs --watch   # attach to a run in progress
 * ```
 *
 * What it reports, and why each number is here:
 *
 * - **peak connections** against `max_connections`. Directly confirms or refutes the hypothesis.
 * - **peak active**, and how much of the peak was merely idle. An idle connection costs a slot
 *   and no CPU; the two failure modes look completely different in this column.
 * - **peak lock waits**, and the wait events behind them. A stalled pg-boss fetch shows here.
 * - **connection errors**, scraped from the suite's own output. If connections were genuinely
 *   exhausted, something should have said so.
 * - **wall clock per run**, because "far too slow to meet their own deadlines" is the symptom and
 *   a fix that does not move this number has not fixed it.
 */

import { spawn } from "node:child_process";
import { Client } from "pg";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? true);
};

const url = process.env["TEST_DATABASE_URL"];
if (!url) {
  process.stderr.write("TEST_DATABASE_URL is not set — there is nothing to measure.\n");
  process.exit(2);
}

const repeat = Number(flag("repeat", 1));
const intervalMs = Number(flag("interval", 200));
const watchOnly = args.includes("--watch");

/** Everything a connection-pressure diagnosis needs, in one round trip per sample. */
const SAMPLE = `
  select
    count(*)                                                        as total,
    count(*) filter (where state = 'active')                        as active,
    count(*) filter (where state = 'idle')                          as idle,
    count(*) filter (where state = 'idle in transaction')           as idle_in_transaction,
    count(*) filter (where wait_event_type = 'Lock')                as lock_waits,
    (select setting::int from pg_settings where name = 'max_connections') as max_connections
  from pg_stat_activity
  where datname = current_database()
`;

async function sampleLoop(client, stop, peaks) {
  while (!stop.done) {
    try {
      const { rows } = await client.query(SAMPLE);
      const row = rows[0];
      peaks.samples++;
      peaks.maxConnections = Number(row.max_connections);
      for (const key of ["total", "active", "idle", "idle_in_transaction", "lock_waits"]) {
        peaks[key] = Math.max(peaks[key], Number(row[key]));
      }
      if (Number(row.lock_waits) > 0) {
        const { rows: waits } = await client.query(
          `select wait_event_type, wait_event, count(*) as n
             from pg_stat_activity
            where datname = current_database() and wait_event_type is not null
            group by 1, 2 order by 3 desc limit 5`,
        );
        for (const wait of waits) {
          const key = `${wait.wait_event_type}/${wait.wait_event}`;
          peaks.waits.set(key, Math.max(peaks.waits.get(key) ?? 0, Number(wait.n)));
        }
      }
    } catch {
      // A sample that fails is a sample lost, not a run lost. Losing the instrument to a
      // transient error would be the worst possible way to end a measurement.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Connection-exhaustion messages, which the issue notes were absent from every failing run. */
const CONNECTION_ERRORS =
  /too many clients|remaining connection slots|Connection terminated|ECONNRESET|ETIMEDOUT|sorry, too many/i;

function runSuite(peaks) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["test"], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split("\n")) {
        if (CONNECTION_ERRORS.test(line)) peaks.connectionErrors.push(line.trim());
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("close", (code) => {
      const failures = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
      const summary = /^# fail (\d+)$/m.exec(output);
      resolve({ code, failures, failed: summary ? Number(summary[1]) : failures.length });
    });
  });
}

function newPeaks() {
  return {
    samples: 0,
    total: 0,
    active: 0,
    idle: 0,
    idle_in_transaction: 0,
    lock_waits: 0,
    maxConnections: 0,
    waits: new Map(),
    connectionErrors: [],
  };
}

function report(label, peaks, result, elapsedMs) {
  const lines = [
    `--- ${label} ---`,
    `wall clock            ${(elapsedMs / 1000).toFixed(1)}s`,
    `samples               ${peaks.samples} at ${intervalMs}ms`,
    `peak connections      ${peaks.total} of max_connections=${peaks.maxConnections}`,
    `  peak active         ${peaks.active}`,
    `  peak idle           ${peaks.idle}`,
    `  peak idle in tx     ${peaks.idle_in_transaction}`,
    `peak lock waits       ${peaks.lock_waits}`,
  ];
  if (peaks.waits.size > 0) {
    lines.push("wait events seen      " + [...peaks.waits].map(([k, n]) => `${k}×${n}`).join(", "));
  }
  lines.push(
    `connection errors     ${peaks.connectionErrors.length}` +
      (peaks.connectionErrors.length > 0 ? `\n  ${peaks.connectionErrors[0]}` : ""),
  );
  if (result) {
    lines.push(`suite                 exit ${result.code}, ${result.failed} failing`);
    for (const failure of result.failures.slice(0, 10)) lines.push(`  not ok ${failure}`);
  }
  process.stdout.write(`${lines.join("\n")}\n\n`);
  return peaks.connectionErrors.length === 0 && (!result || result.failed === 0);
}

const client = new Client({ connectionString: url, application_name: "windkeel-pg-pressure" });
await client.connect();

let allClean = true;
for (let run = 1; run <= repeat; run++) {
  const peaks = newPeaks();
  const stop = { done: false };
  const sampling = sampleLoop(client, stop, peaks);
  const startedAt = Date.now();

  let result = null;
  if (watchOnly) {
    process.stdout.write("watching; press Ctrl-C to stop\n");
    await new Promise((resolve) => process.once("SIGINT", resolve));
  } else {
    result = await runSuite(peaks);
  }

  stop.done = true;
  await sampling;
  allClean = report(`run ${run} of ${repeat}`, peaks, result, Date.now() - startedAt) && allClean;
}

await client.end();
process.exit(allClean ? 0 : 1);
