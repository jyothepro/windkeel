import { lstatSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function privateConsoleStateDirectory(cwd) {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const path = join(tmpdir(), `windkeel-console-private-${hash}`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  const wrongOwner = typeof process.getuid === "function" && stat.uid !== process.getuid();
  if (!stat.isDirectory() || wrongOwner || (stat.mode & 0o077) !== 0) {
    throw new Error(`refusing unsafe console state directory: ${path}`);
  }
  return path;
}
