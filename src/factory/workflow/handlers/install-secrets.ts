import { resolveRepositoryContext } from "../repository-target.js";
import { resolveRepositorySecrets } from "../../repository-secrets.js";
import type { StageDeps } from "../stage-deps.js";
import { secretPrivateKeys } from "../../worker-config.js";

export interface InstallSecrets {
  values: Readonly<Record<string, string>>;
  unopenable: readonly string[];
}

export async function installSecretsFor(
  deps: StageDeps,
  engineeringRunId: string,
): Promise<InstallSecrets | undefined> {
  if (!deps.config.secretPrivateKey) return undefined;
  const privateKey = secretPrivateKeys(deps.config);

  const { repository, organizationId } = await resolveRepositoryContext(
    deps.pool,
    engineeringRunId,
    deps.config.repository,
  );
  if (!repository) return undefined;

  const resolved = await resolveRepositorySecrets(deps.pool, organizationId, repository.id, privateKey);
  if (Object.keys(resolved.values).length === 0 && resolved.unopenable.length === 0) {
    return undefined;
  }
  return {
    values: resolved.values,
    unopenable: resolved.unopenable.map((entry) => entry.key),
  };
}
