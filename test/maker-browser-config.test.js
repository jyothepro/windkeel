import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, loadMakerBrowserConfig, parseMakerBrowser } from "../packages/verification/dist/config.js";
import { LocalExecutionEnvironment } from "../packages/verification/dist/exec/local.js";
import { InvalidConfigError, loadWorkerConfig, makerBrowserFromEnv } from "../dist/factory/worker-config.js";
import { tempDir } from "./helpers.js";

/**
 * `makerBrowser` in `windkeel.config.json` (#392) and the operator's kill switch. The repository
 * decides whether its maker gets a browser; the operator can turn it off for every repository; and
 * the verifier's own configuration does not change either way.
 */

function repoWith(config) {
  const dir = tempDir("maker-browser-config");
  if (config !== undefined) writeFileSync(join(dir, "windkeel.config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

const FLOWS = [{ name: "checkout", command: "npx playwright test" }];

test("absent: on for a repository with flows, off without", () => {
  assert.deepEqual(parseMakerBrowser(undefined, true), { enabled: true, rejected: [] });
  assert.deepEqual(parseMakerBrowser(undefined, false), { enabled: false, rejected: [] });
});

test("declared: enabled wins over the flows default, and startCommand/port are carried", () => {
  assert.deepEqual(parseMakerBrowser({ enabled: false }, true), { enabled: false, rejected: [] });
  assert.deepEqual(parseMakerBrowser({ enabled: true, startCommand: "npm run dev", port: 5173 }, false), {
    enabled: true,
    startCommand: "npm run dev",
    port: 5173,
    rejected: [],
  });
  assert.equal(parseMakerBrowser({ port: 3000 }, false).enabled, true, "configuring it is asking for it");
});

test("bad types are rejected by name and never honoured", () => {
  const notObject = parseMakerBrowser("yes", true);
  assert.equal(notObject.enabled, true, "the default stands");
  assert.match(notObject.rejected[0], /must be an object/);

  const bad = parseMakerBrowser({ enabled: "true", startCommand: "a\nrm -rf /", port: 70000 }, false);
  assert.equal(bad.enabled, false);
  assert.equal(bad.startCommand, undefined);
  assert.equal(bad.port, undefined);
  assert.equal(bad.rejected.length, 3);
  assert.match(bad.rejected.join(" "), /enabled.*true or false/);
  assert.match(bad.rejected.join(" "), /startCommand.*one line/);
  assert.match(bad.rejected.join(" "), /port.*1 to 65535/);

  assert.equal(parseMakerBrowser({ port: 3000.5 }, false).port, undefined);
  assert.equal(parseMakerBrowser({ startCommand: "x".repeat(501) }, false).startCommand, undefined);
});

test("loaded from a checkout: no config is off, flows turn it on, unreadable JSON is off and says why", async () => {
  const env = new LocalExecutionEnvironment();
  assert.equal((await loadMakerBrowserConfig(env, repoWith(undefined))).enabled, false);
  assert.equal((await loadMakerBrowserConfig(env, repoWith({ flows: FLOWS }))).enabled, true);
  assert.equal((await loadMakerBrowserConfig(env, repoWith({ flows: [{ name: "../x", command: "y" }] }))).enabled, false, "only valid flows count");
  assert.equal((await loadMakerBrowserConfig(env, repoWith({ flows: FLOWS, makerBrowser: { enabled: false } }))).enabled, false);
  const broken = await loadMakerBrowserConfig(env, repoWith("{not json"));
  assert.equal(broken.enabled, false);
  assert.match(broken.rejected[0], /not JSON/);
});

test("the verifier's configuration is the same with or without makerBrowser", async () => {
  const env = new LocalExecutionEnvironment();
  const base = { checks: [{ name: "tests", command: "npm test" }], flows: FLOWS };
  const without = await loadConfig(env, repoWith(base));
  const withIt = await loadConfig(env, repoWith({ ...base, makerBrowser: { enabled: true, startCommand: "npm run dev", port: 3000 } }));
  assert.deepEqual(withIt, without);
  assert.equal("makerBrowser" in withIt, false);
});

test("WINDKEEL_MAKER_BROWSER is the kill switch: on by default, off turns it off, nonsense is refused", () => {
  assert.deepEqual(makerBrowserFromEnv({}), { makerBrowser: true, makerScreenshotMax: 50 });
  assert.equal(makerBrowserFromEnv({ WINDKEEL_MAKER_BROWSER: "off" }).makerBrowser, false);
  assert.equal(makerBrowserFromEnv({ WINDKEEL_MAKER_BROWSER: "on" }).makerBrowser, true);
  assert.throws(() => makerBrowserFromEnv({ WINDKEEL_MAKER_BROWSER: "maybe" }), InvalidConfigError);
  assert.equal(makerBrowserFromEnv({ WINDKEEL_MAKER_SCREENSHOT_MAX: "7" }).makerScreenshotMax, 7);
  assert.throws(() => makerBrowserFromEnv({ WINDKEEL_MAKER_SCREENSHOT_MAX: "0" }), /positive integer/);
  assert.throws(() => makerBrowserFromEnv({ WINDKEEL_MAKER_SCREENSHOT_MAX: "2.5" }), /positive integer/);

  const config = loadWorkerConfig({ DATABASE_URL: "postgres://x", WINDKEEL_REPOSITORY_URL: "https://github.com/o/r", OPENAI_API_KEY: "sk-not-a-real-key", WINDKEEL_MAKER_BROWSER: "off" });
  assert.equal(config.makerBrowser, false);
});
