import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_REF = "attestation/bundle.sigstore.json";

export interface SignResult {
  signed: boolean;
  reason: string;
}

export interface VerifyResult {
  ok: boolean;
  inconclusive: boolean;
  detail: string;
  identity?: string;
  issuer?: string;
}

const cosign = (args: string[], cwd: string) =>
  spawnSync("cosign", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const available = (): boolean => spawnSync("cosign", ["version"], { encoding: "utf8" }).status === 0;

export function canSignKeyless(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] || env["SIGSTORE_ID_TOKEN"]);
}

export function signPackage(dir: string, env: NodeJS.ProcessEnv = process.env): SignResult {
  if (!canSignKeyless(env)) {
    return { signed: false, reason: "no ambient OIDC identity (not running in CI)" };
  }
  if (!available()) return { signed: false, reason: "cosign is not installed" };

  const result = cosign(
    ["sign-blob", "--yes", "--bundle", BUNDLE_REF, "attestation/statement.dsse.json"],
    dir,
  );
  return result.status === 0
    ? { signed: true, reason: "keyless (Fulcio certificate + Rekor entry) via cosign" }
    : { signed: false, reason: `cosign sign-blob failed: ${result.stderr.trim().split("\n").at(-1)}` };
}

export const GITHUB_ACTIONS_ISSUER_REGEXP = "^https://token\\.actions\\.githubusercontent\\.com$";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function githubWorkflowIdentityRegexp(repository: string, serverUrl = "https://github.com"): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`not an OWNER/REPO: ${JSON.stringify(repository)}`);
  }
  return `^${escapeRegExp(serverUrl.replace(/\/+$/, ""))}/${escapeRegExp(repository)}/\\.github/workflows/`;
}

export function anchorStart(regexp: string): string {
  return regexp.startsWith("^") ? regexp : `^${regexp}`;
}

export function verifySignature(
  dir: string,
  identity: string | undefined,
  issuer: string | undefined,
): VerifyResult {
  if (!existsSync(join(dir, BUNDLE_REF))) {
    return { ok: true, inconclusive: true, detail: "unsigned (no Sigstore bundle)" };
  }
  if (!identity || !issuer) {
    return {
      ok: true,
      inconclusive: true,
      detail:
        "signed, but no expected signer given — pass --certificate-identity and --certificate-oidc-issuer to check it",
    };
  }
  if (!available()) {
    return {
      ok: true,
      inconclusive: true,
      detail: "signed, but cosign is not installed so the signature was not checked",
    };
  }

  const result = cosign(
    [
      "verify-blob",
      "--bundle",
      BUNDLE_REF,
      "--offline",
      "--certificate-identity-regexp",
      anchorStart(identity),
      "--certificate-oidc-issuer-regexp",
      anchorStart(issuer),
      "attestation/statement.dsse.json",
    ],
    dir,
  );
  return result.status === 0
    ? {
        ok: true,
        inconclusive: false,
        detail: `Sigstore bundle verified offline against ${identity} (${issuer})`,
        identity,
        issuer,
      }
    : {
        ok: false,
        inconclusive: false,
        detail: `Sigstore verification failed: ${(result.stderr || result.stdout).trim().split("\n").at(-1)}`,
      };
}
