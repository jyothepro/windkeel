
import type { ErrorBody } from "@windkeel/api-contract";
import { presetFor } from "./permissions.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,

    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  get missingPermission(): string | undefined {
    const missing = this.body["missing"];
    return this.code === "forbidden" && typeof missing === "string" ? missing : undefined;
  }

  get transient(): boolean {
    return this.status >= 500 || this.code === "maker_not_listening";
  }
}

export class ApiDisabledError extends ApiError {}

export function adviceFor(err: ApiError): string | null {
  const missing = err.missingPermission;
  if (missing) {
    return `this token lacks ${missing}; create one with \`windkeel token create --name <name> --scope ${presetFor(missing)}\``;
  }
  switch (err.code) {
    case "organization_required": {
      const orgs = Array.isArray(err.body["organizations"]) ? (err.body["organizations"] as unknown[]) : [];
      return (
        "you belong to more than one organization, so say which: `windkeel org use <id>`, --org <id> or WINDKEEL_ORG" +
        (orgs.length ? `. Yours: ${describeOrgs(orgs)}` : "")
      );
    }
    case "not_a_member":
      return "you are not a member of that organization; `windkeel org list` shows the ones you are";
    case "console_unconfigured":
      return "this deployment has no console to approve a login in; use `windkeel login --with-token`";
    case "github_user_not_found":
      return "GitHub has no user with that login; check the spelling (it is the handle, not a display name)";
    case "unauthenticated":
      return "the credential was not accepted; run `windkeel login` again";
    default:
      return null;
  }
}

function describeOrgs(orgs: unknown[]): string {
  return orgs
    .map((o) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {}))
    .map((o) => `${String(o["id"])} (${String(o["name"])})`)
    .join(", ");
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {

    return undefined;
  }
}

export function fieldOf(value: unknown, field: keyof ErrorBody & ("code" | "error")): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const found = (value as Partial<ErrorBody>)[field];
  return typeof found === "string" ? found : undefined;
}
