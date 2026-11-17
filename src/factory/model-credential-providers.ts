import { PROVIDERS, type ModelProvider } from "@windkeel/verification/providers/catalog.js";

export type CredentialProviderId = ModelProvider;

export interface CredentialProvider {
  id: CredentialProviderId;
  defaultBaseUrl: string | null;
  probePath: string;
  authHeaders(value: string): Record<string, string>;
}

const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` });

const PROBES: Readonly<
  Record<CredentialProviderId, Pick<CredentialProvider, "probePath" | "authHeaders">>
> = {
  openai: { probePath: "/models", authHeaders: bearer },
  anthropic: {
    probePath: "/models",
    authHeaders: (value) => ({ "x-api-key": value, "anthropic-version": "2023-06-01" }),
  },
  openrouter: { probePath: "/key", authHeaders: bearer },
  "openai-compatible": { probePath: "/models", authHeaders: bearer },
};

export const CREDENTIAL_PROVIDER_IDS: readonly CredentialProviderId[] = Object.keys(
  PROVIDERS,
) as CredentialProviderId[];

export function credentialProvider(id: string): CredentialProvider | null {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, id)) return null;
  const providerId = id as CredentialProviderId;
  return {
    id: providerId,
    defaultBaseUrl: PROVIDERS[providerId].defaultBaseUrl ?? null,
    ...PROBES[providerId],
  };
}
