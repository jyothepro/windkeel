export class MissingConfigError extends Error {
  constructor(
    readonly variable: string,
    purpose: string,
  ) {
    super(`${variable} is not set — ${purpose}`);
    this.name = "MissingConfigError";
  }
}

export interface IngressConfig {
  databaseUrl: string;
  webhookSecret: string;
}

export function loadIngressConfig(env: NodeJS.ProcessEnv = process.env): IngressConfig {
  const databaseUrl = env["DATABASE_POOL_URL"]?.trim() || env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    throw new MissingConfigError(
      "DATABASE_POOL_URL",
      "the ingress needs a transaction-pooled Postgres connection (DATABASE_URL is accepted for local development)",
    );
  }
  const webhookSecret = env["GITHUB_WEBHOOK_SECRET"]?.trim();
  if (!webhookSecret) {
    throw new MissingConfigError(
      "GITHUB_WEBHOOK_SECRET",
      "every delivery's signature is verified before anything is persisted (ADR-0009 §6)",
    );
  }
  return { databaseUrl, webhookSecret };
}
