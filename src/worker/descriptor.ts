import { isModelProvider, PROVIDERS, type ModelProvider } from "@windkeel/verification/providers/catalog.js";

export type HarnessProtocol = "openai-responses" | "anthropic-messages";

export interface HarnessDescriptor {
  readonly id: string;
  readonly binary: string;
  readonly pinnedVersion: string;
  readonly versionEnvVar: string;
  readonly allowDriftEnvVar: string;
  readonly installSpec: string;
  readonly protocols: readonly HarnessProtocol[];
  readonly keyEnvVars: readonly string[];
}

export const PINNED_CODEX_VERSION = "0.163.0";

export const PINNED_CLAUDE_CODE_VERSION = "2.1.304";

export const CODEX_DESCRIPTOR: HarnessDescriptor = {
  id: "codex",
  binary: "codex",
  pinnedVersion: PINNED_CODEX_VERSION,
  versionEnvVar: "WINDKEEL_CODEX_VERSION",
  allowDriftEnvVar: "WINDKEEL_ALLOW_CODEX_VERSION_DRIFT",
  installSpec: "@openai/codex",
  protocols: ["openai-responses"],
  keyEnvVars: ["CODEX_API_KEY", "OPENAI_API_KEY"],
};

export const CLAUDE_CODE_DESCRIPTOR: HarnessDescriptor = {
  id: "claude-code",
  binary: "claude",
  pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
  versionEnvVar: "WINDKEEL_CLAUDE_CODE_VERSION",
  allowDriftEnvVar: "WINDKEEL_ALLOW_CLAUDE_CODE_VERSION_DRIFT",
  installSpec: "@anthropic-ai/claude-code",
  protocols: ["anthropic-messages"],
  keyEnvVars: ["ANTHROPIC_API_KEY"],
};

export const HARNESS_DESCRIPTORS: ReadonlyMap<string, HarnessDescriptor> = new Map(
  [CODEX_DESCRIPTOR, CLAUDE_CODE_DESCRIPTOR].map((descriptor) => [descriptor.id, descriptor]),
);

const CATALOG_PROTOCOL: Readonly<Record<HarnessProtocol, "openai" | "anthropic">> = {
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
};

export function harnessProviders(harnessId: string): ModelProvider[] {
  const protocols: readonly HarnessProtocol[] =
    HARNESS_DESCRIPTORS.get(harnessId)?.protocols ??
    (harnessId === "opencode" ? ["openai-responses", "anthropic-messages"] : []);
  const wanted = new Set(protocols.map((protocol) => CATALOG_PROTOCOL[protocol]));
  return (Object.keys(PROVIDERS) as ModelProvider[]).filter((provider) => wanted.has(PROVIDERS[provider].protocol));
}

export function harnessProviderRefusal(harnessId: string, provider: string): string | null {
  if (!HARNESS_DESCRIPTORS.has(harnessId) && harnessId !== "opencode") return null;
  if (!isModelProvider(provider)) return null;
  const allowed = harnessProviders(harnessId);
  if (allowed.includes(provider)) return null;
  const protocol = PROVIDERS[provider].protocol === "anthropic" ? "Anthropic's Messages API" : "OpenAI's wire format";
  return (
    `the ${harnessId} harness cannot call ${provider} (${protocol}); it may use ` +
    `${allowed.join(", ") || "no catalog provider"} (ADR-0027 §4)`
  );
}

export function descriptorVersion(
  descriptor: HarnessDescriptor,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { version: string; allowDrift: boolean } {
  const version = env[descriptor.versionEnvVar]?.trim() || descriptor.pinnedVersion;
  const raw = env[descriptor.allowDriftEnvVar]?.trim().toLowerCase();
  return { version, allowDrift: raw === "1" || raw === "true" || raw === "yes" || raw === "on" };
}
