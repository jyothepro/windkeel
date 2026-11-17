import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.8.0";
const URL_ = `https://github.com/tlaplus/tlaplus/releases/download/v${VERSION}/tla2tools.jar`;
const SHA256 = "e1f11b75c4b5bc4478ba0ac5cb6ae28e40a01b0016bc33e0aa97da22dfdbcd7f";
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
