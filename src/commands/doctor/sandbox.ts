
import { selectRepositorySecrets } from "../stores/doctor-store.js";
import type { RepositoryRef } from "../../github/client.js";
import type { SandboxGitCredential, SandboxProvider } from "../../sandbox/provider.js";
import { type WorkerConfig } from "../../factory/worker-config.js";
import { type CheckResult, type DoctorEnvironment, fail, message, pass, skip } from "./report.js";

export const SANDBOX_CHECK = { id: "sandbox", title: "Sandbox" };

export const SECRETS_CHECK = { id: "repository-secrets", title: "Repository secrets (ADR-0023 §9)" };

export async function checkRepositorySecrets(
  environment: DoctorEnvironment,
  config: WorkerConfig,
): Promise<CheckResult> {
  const pool = await environment.connect(config.databaseUrl);
  try {
    const { rows } = await selectRepositorySecrets(pool);

    if (!config.secretPrivateKey) {
      if (rows.length === 0) {
        return skip(
          SECRETS_CHECK.id,
          SECRETS_CHECK.title,
          "no key pair is configured and no repository has secrets",
          [
            "Nothing to check, and nothing wrong: a factory whose repositories all install from " +
              "public registries never needs a key pair. Run `windkeel-admin secrets keygen` if one " +
              "of them starts needing a private registry credential.",
          ],
        );
      }
      return fail(
        SECRETS_CHECK.id,
        SECRETS_CHECK.title,
        `${rows.length} stored secret(s) and no WINDKEEL_SECRET_PRIVATE_KEY to open them`,
        [
          "Every dependency install will run without these credentials, and will fail with the " +
            "registry's own error rather than with anything that mentions a secret.",
          "Set WINDKEEL_SECRET_PRIVATE_KEY on this worker to the private half printed by " +
            "`windkeel-admin secrets keygen` — the half whose public counterpart is on ingress.",
        ],
      );
    }

    const { openSecret } = await import("../../factory/secret-box.js");
    const { secretPrivateKeys } = await import("../../factory/worker-config.js");

    const keys = secretPrivateKeys(config);
    const unopenable: string[] = [];
    for (const row of rows) {
      try {
        openSecret(keys, row.key, row.sealed_value);
      } catch {

        unopenable.push(`${row.repository_id.slice(0, 8)}/${row.key}`);
      }
    }

    if (unopenable.length > 0) {
      return fail(
        SECRETS_CHECK.id,
        SECRETS_CHECK.title,
        `${unopenable.length} of ${rows.length} stored secret(s) cannot be opened by this worker`,
        [
          `Unopenable: ${unopenable.join(", ")}`,
          "These were sealed to a different public key than the one this private key belongs to. " +
            "Rotating the pair does not re-seal what is already stored, so each of these has to be " +
            "set again with `windkeel secret set`.",
        ],
      );
    }

    return pass(
      SECRETS_CHECK.id,
      SECRETS_CHECK.title,
      rows.length === 0
        ? "a key pair is configured and no repository has secrets yet"
        : `all ${rows.length} stored secret(s) open with this worker's private key`,
      rows.length === 0
        ? ["Ingress can seal one as soon as WINDKEEL_SECRET_PUBLIC_KEY is set there too."]
        : [],
    );
  } finally {
    await pool.end();
  }
}

export async function checkSandbox(
  environment: DoctorEnvironment,
  config: WorkerConfig,

  gitCredentials?: SandboxGitCredential,
): Promise<CheckResult> {
  const provider = environment.sandboxes(environment.env);
  if (!provider) {
    return skip(
      SANDBOX_CHECK.id,
      SANDBOX_CHECK.title,
      "no sandbox provider is configured (VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID)",
      [
        "Consequence: the worker falls back to ADR-0016 local mode, where agent work runs in a " +
          "temp directory on the container's own host rather than in an isolated microVM.",
      ],
    );
  }

  const findings: string[] = [];
  let handle = null as Awaited<ReturnType<SandboxProvider["create"]>> | null;
  try {
    handle = await provider.create({
      role: "verifier",
      repoUrl: config.repository.url,
      ...(gitCredentials ? { gitCredentials } : {}),
    });
    const version = await handle.exec(config.codex.binary, { args: ["--version"] });
    if (version.status !== 0) {
      findings.push(
        `${config.codex.binary} is not runnable inside the sandbox (exit ${version.status ?? "signal"})` +
          " — ADR-0006 expects it preinstalled in the sandbox image",
      );
    } else if (!version.stdout.includes(config.codex.pinnedVersion)) {
      const observed = version.stdout.trim().split("\n")[0] ?? "";
      findings.push(
        `codex in the sandbox reports "${observed}", not the pinned ${config.codex.pinnedVersion}` +
          (config.codex.allowVersionDrift
            ? " — WINDKEEL_ALLOW_CODEX_VERSION_DRIFT is on, so a run would record this as a diagnostic"
            : " — a run would refuse to drive it"),
      );
    }
  } catch (error) {
    findings.push(`the sandbox could not be created or driven: ${message(error)}`);
  } finally {
    if (handle) {
      try {
        await handle.destroy();
      } catch (error) {
        findings.push(
          `THE SANDBOX WAS NOT DESTROYED (${message(error)}). It has no attach(), so nothing ` +
            "can reach it now and it bills until expires_at. Destroy it from the provider's " +
            "console.",
        );
      }
    }
  }

  if (findings.length > 0) {
    return fail(SANDBOX_CHECK.id, SANDBOX_CHECK.title, `${findings.length} problem(s)`, findings);
  }
  return pass(
    SANDBOX_CHECK.id,
    SANDBOX_CHECK.title,
    `created one ${provider.name} sandbox, ran codex ${config.codex.pinnedVersion} in it, and destroyed it`,
  );
}

export function repositoryFromUrl(url: string): RepositoryRef | null {
  const match = /(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], name: match[2] };
}
