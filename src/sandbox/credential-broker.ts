import type { NetworkPolicyRule } from "@vercel/sandbox";
import { isModelProvider, PROVIDERS } from "@windkeel/verification/providers/catalog.js";
import type { CredentialBrokerRule, NetworkPolicy } from "./provider.js";

export type BrokerAuthHeader = "Authorization" | "x-api-key";

export function authHeaderFor(provider: string | undefined): BrokerAuthHeader {
  return provider !== undefined && isModelProvider(provider) ? PROVIDERS[provider].authHeader : "Authorization";
}

export const CODEX_API_KEY_PLACEHOLDER = "brokered-do-not-use-directly";

export function makerModelKeyRule(
  modelApiDomain: string,
  secretEnvVar: string,
  header: BrokerAuthHeader = "Authorization",
): CredentialBrokerRule {
  return { domain: modelApiDomain, header, secretEnvVar };
}


export function resolvedModelKeyRule(
  modelApiDomain: string,
  resolveSecret: () => Promise<string>,
  label: string,
  header: BrokerAuthHeader = "Authorization",
): CredentialBrokerRule {
  return { domain: modelApiDomain, header, resolveSecret, label };
}

async function headerValue(rule: CredentialBrokerRule, caller: string): Promise<string> {
  let secret: string | undefined;
  if (rule.resolveSecret) {
    secret = await rule.resolveSecret();
    if (!secret) {
      throw new Error(
        `${caller}: the credential ${rule.label ? `"${rule.label}" ` : ""}opened empty (rule for domain "${rule.domain}")`,
      );
    }
  } else {
    secret = process.env[rule.secretEnvVar];
    if (!secret) {
      throw new Error(
        `${caller}: process.env.${rule.secretEnvVar} is unset (rule for domain "${rule.domain}")`,
      );
    }
  }
  if (rule.header.toLowerCase() !== "authorization") return secret;
  return /^\S+\s/.test(secret) ? secret : `Bearer ${secret}`;
}

export async function buildCredentialBrokerAllowMap(
  rules: CredentialBrokerRule[],
): Promise<Record<string, NetworkPolicyRule[]>> {
  const allow: Record<string, NetworkPolicyRule[]> = { "*": [] };
  for (const rule of rules) {
    allow[rule.domain] = [
      { transform: [{ headers: { [rule.header]: await headerValue(rule, "applyCredentialBrokerRules") } }] },
    ];
  }
  return allow;
}

export async function buildPhaseAllowMap(
  policy: NetworkPolicy,
  credentialRules: CredentialBrokerRule[],
): Promise<Record<string, NetworkPolicyRule[]>> {
  const allow: Record<string, NetworkPolicyRule[]> = {};
  for (const domain of policy.allowedDomains ?? []) {
    allow[domain] = [];
  }
  for (const rule of credentialRules) {
    allow[rule.domain] = [
      { transform: [{ headers: { [rule.header]: await headerValue(rule, "buildPhaseAllowMap") } }] },
    ];
  }
  return allow;
}
