import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PREDICATE_TYPE, type EvidenceItem, type Manifest } from "./format.js";
import { computeHashes, sha256 } from "./hashes.js";

export const SPINE_FILES = ["manifest.json", "intent.json", "mapping.json", "verdict.json"];

export function isEvidencePackage(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return SPINE_FILES.some((file) => existsSync(join(dir, file)));
}

export function readJson<T>(dir: string, rel: string): T {
  return JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;
}

export class PackagePathError extends Error {
  constructor(rel: string, why: string) {
    super(`refusing to write ${JSON.stringify(rel)} into the evidence package: ${why}`);
    this.name = "PackagePathError";
  }
}

export function confinedPath(dir: string, rel: string): string {
  if (!rel || rel.includes("\0")) throw new PackagePathError(rel, "empty or NUL-bearing path");
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new PackagePathError(rel, "absolute path");
  const root = resolve(dir);
  const target = resolve(root, rel);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new PackagePathError(rel, "resolves outside the package directory");
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new PackagePathError(rel, "the package directory is a symlink");

  let current = root;
  const parts = fromRoot.split(sep);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current) && !isDanglingLink(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new PackagePathError(rel, `${relative(root, current)} is a symlink`);
    if (!stat.isDirectory()) throw new PackagePathError(rel, `${relative(root, current)} is not a directory`);
  }
  if (existsSync(target) || isDanglingLink(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new PackagePathError(rel, "the target is a symlink");
  }
  return target;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function preparePackageDir(out: string, repo?: string): void {
  const target = resolve(out);
  if (repo) {
    const root = resolve(repo);
    const inside = relative(root, target);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) {
      let current = root;
      for (const part of inside.split(sep)) {
        current = join(current, part);
        if ((existsSync(current) || isDanglingLink(current)) && lstatSync(current).isSymbolicLink()) {
          throw new PackagePathError(
            relative(root, target),
            `${relative(root, current)} in the checkout is a symlink; the evidence package will not be written through it`,
          );
        }
      }
    }
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}

export function writeJson(dir: string, rel: string, value: unknown): void {
  writeFileSync(confinedPath(dir, rel), JSON.stringify(value, null, 2) + "\n");
}

export function writeText(dir: string, rel: string, text: string): void {
  writeFileSync(confinedPath(dir, rel), text);
}

export function writeBytes(dir: string, rel: string, data: Buffer): void {
  writeFileSync(confinedPath(dir, rel), data);
}

export function readEvidence(dir: string, manifest: Manifest): EvidenceItem[] {
  const evidenceDir = join(dir, manifest.evidence_dir);
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(evidenceDir, f), "utf8")) as EvidenceItem);
}

export function seal(dir: string): void {
  const manifest = readJson<Manifest>(dir, "manifest.json");
  writeJson(dir, "hashes.json", computeHashes(dir));
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "orqon-evidence-package",
        digest: { sha256: sha256(readFileSync(join(dir, "hashes.json"))) },
      },
      { name: "git:head", digest: { sha1: manifest.subject.head_sha } },
    ],
    predicateType: PREDICATE_TYPE,
    predicate: {
      format: manifest.format,
      verdict: readJson<{ verdict: string }>(dir, manifest.verdict_ref).verdict,
      pr: manifest.subject.pr,
      repo: manifest.subject.repo,
    },
  };
  writeJson(dir, "attestation/statement.json", statement);
  writeJson(dir, "attestation/statement.dsse.json", {
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ keyid: "unsigned-local", sig: "" }],
  });
}
