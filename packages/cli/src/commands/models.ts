import type { ModelCredentialView, ModelPolicyView, WindkeelApi } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const MODELS_USAGE =
  "usage: windkeel models credentials list [--all] [--json]\n" +
  "       windkeel models credentials add --provider <openai|anthropic|openrouter|openai-compatible>\n" +
  "                                    --label <label> [--base-url <https-url>] [--vendor <vendor>]\n" +
  "                                    [--from-env <VAR>] [--json]   (key on stdin otherwise)\n" +
  "       windkeel models credentials rotate <credential-id> [--from-env <VAR>] [--json]\n" +
  "       windkeel models credentials revoke <credential-id> [--json]\n" +
  "       windkeel models credentials validate <credential-id> [--json]\n" +
  "       windkeel models policy show [--repo <repository-id>] [--json]\n" +
  "       windkeel models policy set --role <maker|checker> --model <model> [--provider <p>]\n" +
  "                               [--credential <credential-id>] [--vendor <vendor>]\n" +
  "                               [--repo <repository-id>] [--json]\n" +
  "       windkeel models policy clear [--role <maker|checker>] [--repo <repository-id>]\n" +
  "         Policy is the organization's default, or with --repo that repository's override;\n" +
  "         a task's --maker-model/--checker-model wins over both. No --credential means\n" +
  "         Windkeel-managed. Each run freezes what applied when it started.\n" +
  "         The key is read from stdin (`windkeel models credentials add … < key.txt`) or from the\n" +
  "         environment variable --from-env names. It is never accepted as a flag or argument.\n";

export type ModelsAction =
  | { kind: "list"; all?: boolean; json?: boolean }
  | {
      kind: "add";
      provider: string;
      label: string;
      baseUrl?: string;
      vendor?: string;
      fromEnv?: string;
      json?: boolean;
    }
  | { kind: "rotate"; credentialId: string; fromEnv?: string; json?: boolean }
  | { kind: "revoke"; credentialId: string; json?: boolean }
  | { kind: "validate"; credentialId: string; json?: boolean }
  | { kind: "policy-show"; repositoryId?: string; json?: boolean }
  | {
      kind: "policy-set";
      role: "maker" | "checker";
      model: string;
      provider?: string;
      credentialId?: string;
      vendor?: string;
      repositoryId?: string;
      json?: boolean;
    }
  | { kind: "policy-clear"; role?: "maker" | "checker"; repositoryId?: string };

export interface ValueSource {
  env: Record<string, string | undefined>;
  stdinIsTty: boolean;
  readStdin(): Promise<string>;
}

export async function modelsCommand(
  api: WindkeelApi,
  io: RemoteIo,
  action: ModelsAction,
  source: ValueSource = processValueSource(),
): Promise<number> {
  switch (action.kind) {
    case "list": {
      const page = await api.listModelCredentials({ includeRevoked: action.all === true });
      if (action.json) {
        io.out(JSON.stringify(page.items, null, 2));
        return 0;
      }
      if (page.items.length === 0) {
        io.out("no model credentials; add one with `windkeel models credentials add --provider <p> --label <l> < key.txt`");
        return 0;
      }
      for (const credential of page.items) io.out(formatCredential(credential));
      io.out("\nKeys are not listed and cannot be: they are sealed to a key only the stage deployment holds.");
      return 0;
    }
    case "add":
    case "rotate": {
      const value = await readValue(io, source, action.fromEnv);
      if (value === null) return 2;
      const { credential, validation } =
        action.kind === "add"
          ? await api.createModelCredential({
              provider: action.provider,
              label: action.label,
              value,
              ...(action.baseUrl ? { baseUrl: action.baseUrl } : {}),
              ...(action.vendor ? { declaredVendor: action.vendor } : {}),
            })
          : await api.rotateModelCredential(action.credentialId, value);
      if (action.json) {
        io.out(JSON.stringify({ credential, validation }, null, 2));
        return 0;
      }
      io.out(`${action.kind === "add" ? "stored" : "rotated"} ${formatCredential(credential)}`);
      io.out(validationNote(validation, credential.id));
      return 0;
    }
    case "revoke": {
      const { credential } = await api.revokeModelCredential(action.credentialId);
      if (action.json) io.out(JSON.stringify({ credential }, null, 2));
      else io.out(`revoked ${formatCredential(credential)}`);
      return 0;
    }
    case "validate": {
      const { credential, validation } = await api.validateModelCredential(action.credentialId);
      if (action.json) io.out(JSON.stringify({ credential, validation }, null, 2));
      else io.out(validationNote(validation, credential.id));
      return 0;
    }
    case "policy-show": {
      const { items } = await api.modelPolicy(action.repositoryId);
      if (action.json) {
        io.out(JSON.stringify(items, null, 2));
        return 0;
      }
      if (items.length === 0) {
        io.out("no model policy; runs use the deployment's own models (Windkeel-managed)");
        return 0;
      }
      for (const entry of items) io.out(formatPolicy(entry));
      return 0;
    }
    case "policy-set": {
      const { items } = await api.setModelPolicy(
        {
          [action.role]: {
            model: action.model,
            ...(action.provider ? { provider: action.provider } : {}),
            credentialId: action.credentialId ?? null,
            ...(action.vendor ? { declaredVendor: action.vendor } : {}),
          },
        },
        action.repositoryId,
      );
      if (action.json) io.out(JSON.stringify(items, null, 2));
      else for (const entry of items) io.out(`set ${formatPolicy(entry)}`);
      return 0;
    }
    case "policy-clear": {
      const { deleted } = await api.clearModelPolicy({
        ...(action.repositoryId ? { repositoryId: action.repositoryId } : {}),
        ...(action.role ? { role: action.role } : {}),
      });
      io.out(`cleared ${deleted} policy row${deleted === 1 ? "" : "s"}`);
      return 0;
    }
  }
}

export function formatPolicy(p: ModelPolicyView): string {
  const layer = p.repositoryId ? `repository ${p.repositoryId}` : "organization";
  const key = p.credentialId ? `credential ${p.credentialId}` : "Windkeel-managed";
  const vendor = p.declaredVendor ? `  (vendor ${p.declaredVendor})` : "";
  return `${p.role}  ${p.provider}/${p.model}  ${key}  [${layer}]${vendor}`;
}

async function readValue(io: RemoteIo, source: ValueSource, fromEnv: string | undefined): Promise<string | null> {
  if (fromEnv !== undefined) {
    const value = source.env[fromEnv]?.trim();
    if (!value) {
      io.err(`--from-env ${fromEnv}: that environment variable is not set or is empty`);
      return null;
    }
    return value;
  }
  if (source.stdinIsTty) {
    io.err(
      "the key is read from stdin or --from-env, never typed or passed as a flag:\n" +
        "  windkeel models credentials add --provider openai --label prod < key.txt\n" +
        "  windkeel models credentials add --provider openai --label prod --from-env OPENAI_API_KEY",
    );
    return null;
  }
  const value = (await source.readStdin()).trim();
  if (value === "") {
    io.err("read nothing from stdin; pipe the key in, or use --from-env <VAR>");
    return null;
  }
  return value;
}

export function formatCredential(c: ModelCredentialView): string {
  const where = c.baseUrl ? `  ${c.baseUrl}` : "";
  const reason = c.statusReason ? `  (${c.statusReason})` : "";
  return `${c.id}  ${c.label}  ${c.provider}${where}  …${c.last4}  ${c.status}${reason}`;
}

function validationNote(validation: string, credentialId: string): string {
  switch (validation) {
    case "started":
      return "Checking the key with the provider now; `windkeel models credentials list` shows the result.";
    case "failed":
      return `The check could not be started. Run \`windkeel models credentials validate ${credentialId}\` to try again.`;
    default:
      return "This deployment does not check keys yet; the credential stays unverified.";
  }
}

function processValueSource(): ValueSource {
  return {
    env: process.env,
    stdinIsTty: process.stdin.isTTY === true,
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
