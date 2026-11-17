import type { ModelProvider } from "./catalog.js";

export type Vendor = string;

export type { ModelProvider } from "./catalog.js";

export type Purpose = "review" | "mapping" | "criteria";

export interface ModelRequest {
  system: string;
  user: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  usage?: ModelUsage;
}

export interface ModelGateway {
  vendor: Vendor;
  model: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<Response>;

export interface ModelEndpoint {
  vendor: Vendor;
  provider?: ModelProvider | undefined;
  model: string;
  apiKey: string;
  baseUrl?: string | undefined;
  maxOutputTokens?: number | undefined;
  fetch?: ModelFetch | undefined;
}

export interface MakerIdentity {
  vendor?: Vendor | undefined;
  provider?: ModelProvider | undefined;
  model?: string | undefined;
}

export interface ModelPolicy {
  endpoints: ModelEndpoint[];
  fakes?:
    | {
        review?: string | undefined;
        mapping?: string | undefined;
        criteria?: string | undefined;
      }
    | undefined;
  maker?: MakerIdentity | undefined;
}
