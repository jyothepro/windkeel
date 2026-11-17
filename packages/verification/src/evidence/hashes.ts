import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Hashes } from "./format.js";

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function packageFiles(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      if (statSync(p).isDirectory()) return walk(p);
      const rel = relative(dir, p).split(sep).join("/");
      if (rel === "hashes.json" || rel.startsWith("attestation/")) return [];
      return [rel];
    });
  return walk(dir).sort();
}

export function computeHashes(dir: string): Hashes {
  const files: Record<string, string> = {};
  for (const rel of packageFiles(dir)) files[rel] = sha256(readFileSync(join(dir, rel)));
  return { algorithm: "sha256", files };
}
