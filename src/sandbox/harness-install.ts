import type { SandboxHandle } from "./provider.js";

export interface HarnessInstallSpec {
  harness: string;
  binary: string;
  version: string;
  installSpec: string;
}

export interface HarnessInstall {
  harness: string;
  pinned: string;
  found: string | null;
  status: "present" | "installed" | "failed";
  detail: string;
  durationMs: number;
}

export function versionIn(output: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1] ?? null;
}

const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export async function ensurePinnedHarness(handle: SandboxHandle, spec: HarnessInstallSpec): Promise<HarnessInstall> {
  const started = Date.now();
  const record = (found: string | null, status: HarnessInstall["status"], detail: string): HarnessInstall => ({
    harness: spec.harness,
    pinned: spec.version,
    found,
    status,
    detail,
    durationMs: Date.now() - started,
  });
  const probe = async (): Promise<string | null> => {
    const result = await handle.exec(spec.binary, { args: ["--version"] });
    return result.status === 0 ? versionIn(result.stdout) : null;
  };

  const found = await probe();
  if (found === spec.version) return record(found, "present", `${spec.binary} ${found} is the pinned version`);
  if (!PACKAGE.test(spec.installSpec) || !VERSION.test(spec.version)) {
    return record(found, "failed", `refusing to install ${JSON.stringify(spec.installSpec)}@${JSON.stringify(spec.version)}: not a package name and version`);
  }

  const target = `${spec.installSpec}@${spec.version}`;
  const args = ["install", "-g", "--no-fund", "--no-audit", "--loglevel=error", target];
  let installed = await handle.exec("npm", { args });
  let how = "npm install -g";
  if (installed.status !== 0) {
    installed = await handle.exec("sudo", { args: ["-n", "npm", ...args] });
    how = "sudo npm install -g";
  }
  if (installed.status !== 0) {
    const last = (installed.stderr || installed.stdout).trim().split("\n").at(-1)?.slice(0, 300) ?? "";
    return record(found, "failed", `${how} ${target} exited ${installed.status ?? installed.error}${last ? `: ${last}` : ""}`);
  }
  const now = await probe();
  if (now !== spec.version) {
    return record(found, "failed", `${how} ${target} succeeded but ${spec.binary} --version reports ${now ?? "nothing"}; another install shadows it on PATH`);
  }
  return record(found, "installed", `${spec.binary} was ${found ?? "absent"}; ${how} ${target} replaced it`);
}
