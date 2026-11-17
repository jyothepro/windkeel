import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Pin a stable release. Upstream's v1.8.0 is a rolling pre-release whose tla2tools.jar is
// rebuilt in place, so its hash changes without notice and this check would fail on every PR.
const VERSION = "1.7.4";
const URL_ = `https://github.com/tlaplus/tlaplus/releases/download/v${VERSION}/tla2tools.jar`;
const SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const CACHE = process.env.WINDKEEL_TLA_CACHE ?? join(homedir(), ".cache", "windkeel-tla");
const JAR = join(CACHE, `tla2tools-${VERSION}.jar`);

const MODELS = [
  { spec: "RunLifecycle.tla", config: "RunLifecycle.cfg" },
  { spec: "CreditLedger.tla", config: "CreditLedger.cfg" },
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function ensureJar() {
  if (existsSync(JAR) && sha256(JAR) === SHA256) return;
  mkdirSync(CACHE, { recursive: true });
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`formal-check: downloading ${URL_} failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== SHA256) throw new Error(`formal-check: tla2tools.jar sha256 ${got}, expected ${SHA256}`);
  writeFileSync(JAR, bytes);
}

await ensureJar();

let failed = false;
for (const { spec, config } of MODELS) {
  console.log(`formal-check: TLC ${spec} with ${config}`);
  const run = spawnSync(
    "java",
    [
      "-XX:+UseParallelGC",
      "-cp",
      JAR,
      "tlc2.TLC",
      "-workers",
      "auto",
      "-deadlock",
      "-cleanup",
      "-config",
      config,
      spec,
    ],
    { cwd: fileURLToPath(new URL("../formal/", import.meta.url)), stdio: "inherit" },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    console.error(`formal-check: ${spec} failed (TLC exit ${run.status})`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
