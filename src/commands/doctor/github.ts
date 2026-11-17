
import type {
  GitHubClient,
  InstallationPermissions,
  RepositoryRef,
} from "../../github/client.js";
import { type DeliveryVerdict } from "../../github/app-deliveries.js";
import {
  ADR_0009_PERMISSIONS,
  type CheckResult,
  MAKER_PERMISSIONS,
  SecretRegistry,
  VERIFIER_PERMISSIONS,
  fail,
  pass,
  skip,
} from "./report.js";

export const PERMISSION_CHECK = { id: "github-permissions", title: "GitHub App permissions (ADR-0009)" };
export const SCOPING_CHECK = { id: "github-scoping", title: "Per-role token scoping (ADR-0014 §2)" };

export function comparePermissions(granted: InstallationPermissions): {
  missing: string[];
  extra: string[];
} {
  const missing: string[] = [];
  const extra: string[] = [];
  const wanted = ADR_0009_PERMISSIONS as Record<string, string>;
  const has = granted as Record<string, string | undefined>;

  for (const [name, level] of Object.entries(wanted)) {
    const actual = has[name];
    if (actual === undefined) missing.push(`${name}: ${level} is not granted`);
    else if (actual !== level && !(level === "read" && actual === "write")) {
      missing.push(`${name}: granted ${actual}, ADR-0009 §1 needs ${level}`);
    }
  }
  for (const [name, level] of Object.entries(has)) {
    if (level === undefined) continue;
    if (!(name in wanted)) extra.push(`${name}: ${level} is granted and ADR-0009 §1 does not ask for it`);
    else if (wanted[name] === "read" && level === "write") {
      extra.push(`${name}: granted write where ADR-0009 §1 asks only for read`);
    }
  }
  return { missing, extra };
}

export async function checkAppPermissions(
  github: GitHubClient,
  repository: RepositoryRef,
): Promise<CheckResult> {
  const repo = await github.getRepository(repository);
  const { missing, extra } = comparePermissions(repo.permissions);
  if (missing.length === 0 && extra.length === 0) {
    return pass(
      PERMISSION_CHECK.id,
      PERMISSION_CHECK.title,
      `the installation on ${repository.owner}/${repository.name} grants exactly ADR-0009 §1's set`,
    );
  }
  return fail(
    PERMISSION_CHECK.id,
    PERMISSION_CHECK.title,
    `${missing.length} missing, ${extra.length} beyond ADR-0009 §1`,
    [
      ...missing,
      ...extra,
      ...(extra.length > 0
        ? [
            "An over-broad grant buys nothing: a run fails loudly on a missing permission " +
              "rather than degrading, so the extra access only widens what a compromised " +
              "installation could reach.",
          ]
        : []),
    ],
  );
}

export async function checkTokenScoping(
  github: GitHubClient,
  repository: RepositoryRef,
  secrets: SecretRegistry,
): Promise<CheckResult> {
  const maker = await github.mintInstallationToken({ repository, permissions: MAKER_PERMISSIONS });
  secrets.add(maker.token);
  const verifier = await github.mintInstallationToken({
    repository,
    permissions: VERIFIER_PERMISSIONS,
  });
  secrets.add(verifier.token);

  const findings: string[] = [];
  if (maker.permissions.contents !== "write") {
    findings.push(`the maker's token was granted contents: ${maker.permissions.contents ?? "none"}`);
  }
  if (verifier.permissions.contents !== "read") {
    findings.push(
      `the verifier's token was granted contents: ${verifier.permissions.contents ?? "none"}`,
    );
  }
  if (maker.token === verifier.token) {
    findings.push(
      "the two roles were handed the same token — one token per workspace is what makes " +
        "revoking or expiring one not affect another run",
    );
  }
  if (findings.length > 0) {
    return fail(
      SCOPING_CHECK.id,
      SCOPING_CHECK.title,
      "the two roles are not scoped as ADR-0014 §2 requires",
      [
        ...findings,
        "The verifier being *unable* to push — rather than merely forbidden to — is the " +
          "property independent verification rests on.",
      ],
    );
  }
  return pass(
    SCOPING_CHECK.id,
    SCOPING_CHECK.title,
    "maker minted contents: write, verifier contents: read, and the two tokens differ",
  );
}

export const DELIVERY_CHECK = { id: "github-deliveries", title: "GitHub App webhook deliveries" };

export function reportDeliveries(verdict: DeliveryVerdict): CheckResult {
  if (verdict.status === "pass") {
    return pass(DELIVERY_CHECK.id, DELIVERY_CHECK.title, verdict.summary, verdict.details);
  }
  if (verdict.status === "skip") {
    return skip(DELIVERY_CHECK.id, DELIVERY_CHECK.title, verdict.summary, verdict.details);
  }
  return fail(DELIVERY_CHECK.id, DELIVERY_CHECK.title, verdict.summary, verdict.details);
}
