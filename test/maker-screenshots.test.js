import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { insertAgentRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import {
  MAKER_SCREENSHOT_MAX_BYTES,
  harvestMakerScreenshots,
  listMakerScreenshots,
  makerScreenshotObjectKey,
  makerScreenshotPrefix,
} from "../dist/factory/maker-screenshots.js";
import { listRunEvents } from "../dist/factory/run-events.js";
import { bareFixtureRepo, seedFixtureRepository, tempDir, TEST_POOL, FIXTURE_REPOSITORY_ID } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The maker screenshot harvest (#392) against a real checkout (`FakeSandboxProvider`), real
 * Postgres and an in-memory object store. The maker is hostile (ADR-0014), so most of this is what
 * is *not* uploaded: unsafe paths, files that are not PNGs, oversized files, and files past the
 * per-run cap — each dropped with its reason, none uploaded.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag) => Buffer.concat([SIGNATURE, Buffer.from(`IHDR-fake-${tag}`)]);

class MemoryStorage {
  constructor() {
    this.puts = [];
  }
  async putPackage(localDir, bucket, key) {
    const dest = tempDir("stored-shots");
    cpSync(localDir, dest, { recursive: true });
    this.puts.push({ bucket, key, files: readdirSync(dest).sort() });
  }
  objects() {
    return this.puts.flatMap((p) => p.files.map((f) => `${p.bucket}/${p.key}/${f}`));
  }
}

let counter = 0;
async function withRun(fn) {
  const schema = `windkeel_shots_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node --test" });
  let handle;
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "local",
      sourceReference: "392",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const agentRun = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "scripted", model: "m", role: "implementer", tokenUsage: null });
    handle = await new FakeSandboxProvider().create({ role: "maker", repoUrl: remote.bare });
    const shots = join(handle.checkoutPath, ".windkeel", "browser");
    const write = (name, bytes) => {
      mkdirSync(join(shots, name, ".."), { recursive: true });
      writeFileSync(join(shots, name), bytes);
    };
    const storage = new MemoryStorage();
    const harvest = (overrides = {}) =>
      harvestMakerScreenshots(pool, {
        handle,
        engineeringRunId: run.id,
        agentRunId: agentRun.id,
        storage: { storage, bucket: "evidence" },
        ...overrides,
      });
    await fn({ pool, handle, runId: run.id, agentRunId: agentRun.id, write, storage, harvest, shots });
  } finally {
    await handle?.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("object keys live under maker-browser/<run>/, apart from every evidence key", () => {
  assert.equal(makerScreenshotPrefix("r1"), "maker-browser/r1");
  assert.equal(makerScreenshotObjectKey("r1", "ab".repeat(32)), `maker-browser/r1/${"ab".repeat(32)}.png`);
});

test("a harvest uploads PNGs by content hash, with the helper's index, and puts them on the feed", { skip }, async () => {
  await withRun(async ({ pool, runId, write, storage, harvest }) => {
    write("001-home.png", png("home"));
    write("002-cart.png", png("cart"));
    write(
      "index.jsonl",
      [
        JSON.stringify({ file: "001-home.png", name: "home", url: "http://localhost:3000/", title: "Home <b>", status: 200, consoleErrors: ["boom"] }),
        "not json",
        JSON.stringify({ file: "002-cart.png", name: "cart", url: "http://localhost:3000/cart", title: "Cart", consoleErrors: [] }),
      ].join("\n") + "\n",
    );

    const result = await harvest();
    assert.deepEqual(result.dropped, []);
    assert.equal(result.uploaded.length, 2);

    const rows = await listMakerScreenshots(pool, runId);
    assert.deepEqual(rows.map((r) => r.name), ["home", "cart"]);
    const home = rows.find((r) => r.name === "home");
    assert.equal(home.url, "http://localhost:3000/");
    assert.equal(home.pageTitle, "Home <b>", "stored as text; rendering escapes it");
    assert.deepEqual(home.consoleErrors, ["boom"]);
    assert.equal(home.objectKey, makerScreenshotObjectKey(runId, home.sha256));

    assert.deepEqual(storage.objects().sort(), rows.map((r) => `evidence/${r.objectKey}`).sort());
    for (const key of storage.objects()) assert.match(key, /^evidence\/maker-browser\//);

    const feed = await listRunEvents(pool, runId);
    const shots = feed.items.filter((e) => e.kind === "agent" && e.event.type === "screenshot");
    assert.equal(shots.length, 2);
    assert.deepEqual(shots.map((e) => e.event.name), ["home", "cart"]);
    assert.ok(shots.every((e) => rows.some((r) => r.id === e.event.screenshotId)));

    // A later harvest lists after the earlier one, even when its file name sorts first: the order is
    // the order of capture, never the name and never a tie broken at random.
    write("000-early.png", png("early"));
    assert.equal((await harvest()).uploaded.length, 1);
    assert.deepEqual((await listMakerScreenshots(pool, runId)).map((r) => r.name), ["home", "cart", "000-early"]);
  });
});

test("a replayed harvest uploads nothing new and inserts nothing twice; identical files are one", { skip }, async () => {
  await withRun(async ({ pool, runId, write, harvest }) => {
    write("001-a.png", png("same"));
    write("002-b.png", png("same"));
    const first = await harvest();
    assert.equal(first.uploaded.length, 1, "deduped by sha256");

    const second = await harvest();
    assert.deepEqual(second.uploaded, []);
    assert.deepEqual(second.dropped, []);
    assert.equal((await listMakerScreenshots(pool, runId)).length, 1);
    const feed = await listRunEvents(pool, runId);
    assert.equal(feed.items.filter((e) => e.kind === "agent" && e.event.type === "screenshot").length, 1);
  });
});

test("unsafe paths, non-PNGs, oversized files and files over the cap are dropped with reasons, never uploaded", { skip }, async () => {
  await withRun(async ({ pool, runId, handle, write, storage, harvest }) => {
    write("001-ok.png", png("ok"));
    write("002-ok.png", png("ok2"));
    write("003-third.png", png("third"));
    write("fake.png", Buffer.from("<html><script>alert(1)</script></html>"));
    write("notes.txt", Buffer.from("hello"));
    write("huge.png", Buffer.concat([SIGNATURE, Buffer.alloc(MAKER_SCREENSHOT_MAX_BYTES)]));

    // The listing is the maker's: a path that climbs out is refused before anything reads it.
    const hostile = Object.create(handle);
    hostile.listFiles = async (dir) => [...(await handle.listFiles(dir)), { path: "../../etc/passwd.png", bytes: 10 }, { path: "a\\b.png", bytes: 10 }];
    let readEscape = false;
    hostile.readFile = async (path) => {
      if (path.includes("..")) readEscape = true;
      return handle.readFile(path);
    };

    const result = await harvest({ handle: hostile, max: 2 });
    const reasons = Object.fromEntries(result.dropped.map((d) => [d.path, d.reason]));
    assert.equal(reasons["../../etc/passwd.png"], "unsafe_path");
    assert.equal(reasons["a\\b.png"], "unsafe_path");
    assert.equal(reasons["fake.png"], "not_png");
    assert.equal(reasons["notes.txt"], "not_png");
    assert.equal(reasons["huge.png"], "too_large");
    assert.equal(reasons["003-third.png"], "over_cap");
    assert.equal(readEscape, false, "an unsafe path is never read");

    assert.equal(result.uploaded.length, 2);
    assert.equal((await listMakerScreenshots(pool, runId)).length, 2);
    assert.equal(storage.objects().length, 2, "nothing dropped reached the store");
  });
});

test("no screenshot directory is a no-op, and no object store skips the harvest", { skip }, async () => {
  await withRun(async ({ pool, runId, write, storage, harvest }) => {
    const missing = await harvest();
    assert.match(missing.skipped, /no \.windkeel\/browser directory/);

    write("001.png", png("x"));
    const unstored = await harvest({ storage: undefined });
    assert.match(unstored.skipped, /no object store/);
    assert.equal(storage.puts.length, 0);
    assert.equal((await listMakerScreenshots(pool, runId)).length, 0);
  });
});

test("a screenshot can be read back by its run only", { skip }, async () => {
  await withRun(async ({ pool, runId, write, harvest }) => {
    write("001.png", png("y"));
    const { uploaded } = await harvest();
    const { getMakerScreenshot } = await import("../dist/factory/maker-screenshots.js");
    assert.equal((await getMakerScreenshot(pool, runId, uploaded[0].id)).sha256, uploaded[0].sha256);
    assert.equal(await getMakerScreenshot(pool, "00000000-0000-0000-0000-000000000000", uploaded[0].id), null);
    assert.equal(await getMakerScreenshot(pool, runId, "not-a-uuid"), null);
  });
});

test("the PR comment is the maker's, labelled unverified, with the maker's text neutralised", async () => {
  const { renderMakerScreenshotsComment, findMakerScreenshotsComment, makerScreenshotsMarker } = await import(
    "../dist/github/maker-screenshots-comment.js"
  );
  const { stickyMarker } = await import("../dist/github/summary.js");
  const body = renderMakerScreenshotsComment(
    "run-1",
    [
      { name: "home", url: "https://phish.example/|x", pageTitle: "<img src=x onerror=alert(1)> [click](https://evil.example) <!-- windkeel:run:run-1 -->", consoleErrors: ["a", "b"] },
    ],
    "https://console.example/runs/run-1?tab=browser",
  );
  assert.ok(body.startsWith(makerScreenshotsMarker("run-1")));
  assert.match(body, /Maker screenshots — unverified, not verification evidence/);
  assert.match(body, /did not take, read or check them/);
  assert.doesNotMatch(body, /<img/);
  assert.doesNotMatch(body, /https:\/\/evil/, "no link, not even an autolink, from the maker's title");
  assert.ok(!body.includes(stickyMarker("run-1")), "a title cannot forge the evidence comment's marker");
  assert.match(body, /`https:\/\/phish\.example\/\\\|x`/, "a URL is inline code, never a link");
  assert.match(body, /\| 2 \|$/m, "console error count");
  assert.match(body, /\[run page\]\(https:\/\/console\.example\/runs\/run-1\?tab=browser\)/);

  const comments = [{ id: 1, body: `${stickyMarker("run-1")}\nevidence` }, { id: 2, body }];
  assert.equal(findMakerScreenshotsComment(comments, "run-1").id, 2);
  assert.equal(findMakerScreenshotsComment(comments, "run-2"), undefined);

  // The URL and name are the maker's too (its index.jsonl): neither can carry a marker.
  const forged = renderMakerScreenshotsComment(
    "run-1",
    [
      {
        name: `x ${stickyMarker("run-1")}`,
        url: `http://localhost:3000/${stickyMarker("run-1")}${makerScreenshotsMarker("run-2")}`,
        pageTitle: null,
        consoleErrors: [],
      },
    ],
    null,
  );
  assert.ok(!forged.includes(stickyMarker("run-1")), "a URL or name cannot forge the evidence comment's marker");
  assert.ok(!forged.includes(makerScreenshotsMarker("run-2")), "nor another run's maker marker");
  const { findStickyComment } = await import("../dist/github/summary.js");
  const makerFirst = [{ id: 2, body: forged }, { id: 1, body: `${stickyMarker("run-1")}\nevidence` }];
  assert.equal(findStickyComment(makerFirst, "run-1").id, 1, "the verifier's comment is never mistaken for the maker's");
});

test("a run at its cap reads nothing more, and one harvest reads at most twice the cap", { skip }, async () => {
  await withRun(async ({ pool, runId, handle, write, harvest }) => {
    for (let i = 1; i <= 6; i++) write(`00${i}-x.png`, Buffer.from(`not a png ${i}`));
    write("007-ok.png", png("ok"));
    let reads = 0;
    const counting = Object.create(handle);
    counting.readFile = async (path) => {
      if (path.endsWith(".png")) reads += 1;
      return handle.readFile(path);
    };
    const first = await harvest({ handle: counting, max: 2 });
    assert.equal(reads, 4, "the budget is 2 x max reads");
    assert.equal(first.uploaded.length, 0);
    assert.equal(first.dropped.filter((d) => d.reason === "over_cap").length, 3);

    write("000-a.png", png("a"));
    write("000-b.png", png("b"));
    const second = await harvest({ max: 2 });
    assert.equal(second.uploaded.length, 2);
    reads = 0;
    const third = await harvest({ handle: counting, max: 2 });
    assert.equal(reads, 0, "nothing is read once the run is at its cap");
    assert.match(third.skipped, /already has its 2 screenshot/);
    assert.equal((await listMakerScreenshots(pool, runId)).length, 2);
  });
});
