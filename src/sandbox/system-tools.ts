import {
  SCANNER_ASSET_PREFIX,
  scannerAssets,
  type ScannerAssets,
} from "@windkeel/verification/stages/scanner-assets.js";
import type { RejectedTool, SystemToolSpec } from "@windkeel/verification/config.js";
import type { ExecResult } from "@windkeel/verification/exec/environment.js";
import type { SandboxHandle } from "./provider.js";

export interface ToolInstall {
  tool: string;
  source: "repository" | "engine";
  status: "installed" | "failed" | "rejected";
  detail: string;
  durationMs: number;
}

export interface ScannerInstall {
  installs: ToolInstall[];
  assetDir?: string;
}

const PACKAGE_MANAGERS: ReadonlyArray<{ command: string; install: (pkg: string) => string[]; refresh?: string[] }> = [
  { command: "dnf", install: (pkg) => ["install", "-y", pkg] },
  { command: "microdnf", install: (pkg) => ["install", "-y", pkg] },
  { command: "apt-get", install: (pkg) => ["install", "-y", "--no-install-recommends", pkg], refresh: ["update"] },
  { command: "apk", install: (pkg) => ["add", "--no-cache", pkg] },
  { command: "yum", install: (pkg) => ["install", "-y", pkg] },
];

export const NOT_ISOLATED =
  "this sandbox provider has no filesystem of its own (capabilities.isolatedFilesystem is false), " +
  "so installing a binary would modify the machine running the factory rather than a sandbox";

export const APT_OVER_HTTPS = [
  "sed -i",
  "'s|http://archive.ubuntu.com|https://archive.ubuntu.com|g;",
  "s|http://security.ubuntu.com|https://security.ubuntu.com|g;",
  "s|http://deb.debian.org|https://deb.debian.org|g;",
  "s|http://security.debian.org|https://security.debian.org|g'",
  "/etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list",
  "2>/dev/null; exit 0",
].join(" ");

const ok = (result: ExecResult): boolean => result.status === 0 && !result.error;

const why = (result: ExecResult): string =>
  result.error ?? `exit ${result.status ?? "none"}${result.stderr ? `: ${result.stderr.trim().slice(-300)}` : ""}`;

export async function elevation(handle: SandboxHandle): Promise<string[]> {
  const uid = await handle.exec("id", { args: ["-u"] });
  if (ok(uid) && uid.stdout.trim() === "0") return [];
  return ok(await handle.exec("sudo", { args: ["-n", "true"] })) ? ["sudo"] : [];
}

export function elevated(handle: SandboxHandle, prefix: string[], command: string, args: string[]): Promise<ExecResult> {
  return prefix.length
    ? handle.exec(prefix[0]!, { args: [...prefix.slice(1), command, ...args] })
    : handle.exec(command, { args });
}

export async function installDeclaredTools(
  handle: SandboxHandle,
  tools: SystemToolSpec[],
  rejected: RejectedTool[] = [],
  isolated = true,
): Promise<ToolInstall[]> {
  const outcomes: ToolInstall[] = rejected.map((r) => ({
    tool: r.value,
    source: "repository" as const,
    status: "rejected" as const,
    detail: r.reason,
    durationMs: 0,
  }));
  if (!tools.length) return outcomes;

  if (!isolated) {
    return [
      ...outcomes,
      ...tools.map((t) => ({
        tool: t.package,
        source: "repository" as const,
        status: "failed" as const,
        detail: `${t.package} was not installed: ${NOT_ISOLATED}`,
        durationMs: 0,
      })),
    ];
  }

  const prefix = await elevation(handle);
  const manager = await detectPackageManager(handle, prefix);
  if (!manager) {
    return [
      ...outcomes,
      ...tools.map((t) => ({
        tool: t.package,
        source: "repository" as const,
        status: "failed" as const,
        detail: `no package manager on this sandbox image (looked for ${PACKAGE_MANAGERS.map((p) => p.command).join(", ")})`,
        durationMs: 0,
      })),
    ];
  }

  if (manager.refresh) {
    await elevated(handle, prefix, "sh", ["-c", APT_OVER_HTTPS]);
    await elevated(handle, prefix, manager.command, manager.refresh);
  }

  for (const tool of tools) {
    const started = Date.now();
    const result = await elevated(handle, prefix, manager.command, manager.install(tool.package));
    outcomes.push({
      tool: tool.package,
      source: "repository",
      status: ok(result) ? "installed" : "failed",
      detail: ok(result)
        ? `${manager.command} installed ${tool.package}${tool.reason ? ` (declared for: ${tool.reason.slice(0, 200)})` : ""}`
        : `${manager.command} could not install ${tool.package}: ${why(result)}`,
      durationMs: Date.now() - started,
    });
  }
  return outcomes;
}

async function detectPackageManager(
  handle: SandboxHandle,
  prefix: string[],
): Promise<(typeof PACKAGE_MANAGERS)[number] | null> {
  for (const manager of PACKAGE_MANAGERS) {
    if (ok(await handle.exec(manager.command, { args: ["--version"] }))) return manager;
  }
  void prefix;
  return null;
}

const SCANNERS = [
  {
    tool: "gitleaks",
    version: "8.24.3",
    url: "https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz",
    sha256: "9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c",
    archive: true,
  },
  {
    tool: "osv-scanner",
    version: "2.0.2",
    url: "https://github.com/google/osv-scanner/releases/download/v2.0.2/osv-scanner_linux_amd64",
    sha256: "3abcfd7126c453a00421487e721b296e0cb68085bd431d6cef60872774170fc8",
    archive: false,
  },
] as const;

const SEMGREP_VERSION = "1.177.0";

const SEMGREP_RULESET_URL = "https://semgrep.dev/c/p/ci";

export async function installScanners(
  handle: SandboxHandle,
  isolated = true,
): Promise<ScannerInstall> {
  if (!isolated) {
    return {
      installs: [...SCANNERS.map((s) => s.tool as string), "semgrep"].map((tool) => ({
        tool,
        source: "engine" as const,
        status: "failed" as const,
        detail: `${tool} was not installed: ${NOT_ISOLATED}`,
        durationMs: 0,
      })),
    };
  }

  const prefix = await elevation(handle);
  const outcomes: ToolInstall[] = [];

  const assets = scannerAssets(await handle.mkdtemp(SCANNER_ASSET_PREFIX));
  const arch = (await handle.exec("uname", { args: ["-m"] })).stdout.trim();

  for (const scanner of SCANNERS) {
    const started = Date.now();
    outcomes.push({
      ...(await installPinnedBinary(handle, prefix, scanner, assets, arch)),
      durationMs: Date.now() - started,
    });
  }

  const semgrepStarted = Date.now();
  outcomes.push({
    ...(await installSemgrep(handle, prefix, assets)),
    durationMs: Date.now() - semgrepStarted,
  });

  const osv = outcomes.find((o) => o.tool === "osv-scanner");
  if (osv?.status === "installed") {
    const warmed = await warmOsvDatabase(handle, assets);
    osv.detail += `; ${warmed.detail}`;
    osv.durationMs += warmed.durationMs;
  }

  return { installs: outcomes, assetDir: assets.dir };
}

async function installPinnedBinary(
  handle: SandboxHandle,
  prefix: string[],
  scanner: (typeof SCANNERS)[number],
  assets: ScannerAssets,
  arch: string,
): Promise<Omit<ToolInstall, "durationMs">> {
  const base = { tool: scanner.tool, source: "engine" as const };
  if (arch && arch !== "x86_64" && arch !== "amd64") {
    return {
      ...base,
      status: "failed",
      detail: `no pinned ${scanner.tool} asset for ${arch}: only x86_64 assets have a digest to verify against, and an unverified download is not worth installing into the verifier`,
    };
  }

  const download = `${assets.dir}/${scanner.tool}${scanner.archive ? ".tar.gz" : ""}`;
  const fetched = await handle.exec("curl", {
    args: ["-fsSL", "--retry", "3", "-o", download, scanner.url],
  });
  if (!ok(fetched)) {
    return { ...base, status: "failed", detail: `could not fetch ${scanner.url}: ${why(fetched)}` };
  }

  const digest = await handle.exec("sha256sum", { args: [download] });
  const actual = digest.stdout.trim().split(/\s+/)[0];
  if (!ok(digest) || actual !== scanner.sha256) {
    return {
      ...base,
      status: "failed",
      detail: !ok(digest)
        ? `could not verify ${scanner.tool}'s digest (${why(digest)}); refusing to install an unverified binary`
        : `${scanner.tool} digest mismatch: expected ${scanner.sha256}, got ${actual ?? "nothing"} — refusing to install it`,
    };
  }

  const binary = `${assets.dir}/${scanner.tool}`;
  if (scanner.archive) {
    const extracted = await handle.exec("tar", {
      args: ["-xzf", download, "-C", assets.dir, scanner.tool],
    });
    if (!ok(extracted)) {
      return { ...base, status: "failed", detail: `could not unpack ${scanner.tool}: ${why(extracted)}` };
    }
  }

  const installed = await elevated(handle, prefix, "install", [
    "-m",
    "0755",
    binary,
    `/usr/local/bin/${scanner.tool}`,
  ]);
  if (!ok(installed)) {
    return { ...base, status: "failed", detail: `could not install ${scanner.tool}: ${why(installed)}` };
  }
  return {
    ...base,
    status: "installed",
    detail: `${scanner.tool} ${scanner.version} (sha256 ${scanner.sha256.slice(0, 12)}…) → /usr/local/bin/${scanner.tool}`,
  };
}

async function installSemgrep(
  handle: SandboxHandle,
  prefix: string[],
  assets: ScannerAssets,
): Promise<Omit<ToolInstall, "durationMs">> {
  const base = { tool: "semgrep", source: "engine" as const };
  const pip = ok(await handle.exec("pip3", { args: ["--version"] })) ? "pip3" : "pip";
  const args = ["install", "--quiet", "--disable-pip-version-check", `semgrep==${SEMGREP_VERSION}`];

  let result = await elevated(handle, prefix, pip, args);
  if (!ok(result)) result = await elevated(handle, prefix, pip, [...args, "--break-system-packages"]);
  if (!ok(result)) {
    return { ...base, status: "failed", detail: `${pip} could not install semgrep: ${why(result)}` };
  }

  const rules = await handle.exec("curl", {
    args: ["-fsSL", "--retry", "3", "-o", assets.semgrepRules, SEMGREP_RULESET_URL],
  });
  return {
    ...base,
    status: "installed",
    detail:
      `semgrep ${SEMGREP_VERSION} via ${pip}; ` +
      (ok(rules)
        ? `p/ci ruleset pre-fetched to ${assets.semgrepRules}`
        : `p/ci ruleset could NOT be pre-fetched (${why(rules)}) — the scan will try to resolve it over a network the execution phase has already narrowed`),
  };
}

function isNoPackageSources(result: ExecResult): boolean {
  return result.status === 128 && /No package sources found/i.test(result.stderr);
}

async function warmOsvDatabase(
  handle: SandboxHandle,
  assets: ScannerAssets,
): Promise<{ detail: string; durationMs: number }> {
  const started = Date.now();
  const result = await handle.exec("osv-scanner", {
    args: ["--download-offline-databases", "--offline-vulnerabilities", "--format", "json", "-r", "."],
    cwd: handle.checkoutPath,
  });
  const downloaded = !result.error && result.status !== null && result.stdout.includes("results");
  if (downloaded) await handle.writeFile(assets.osvMarker, new Date().toISOString());
  return {
    detail: downloaded
      ? "offline vulnerability databases downloaded; scans run without network"
      : isNoPackageSources(result)
        ?
          "no package manifests in this checkout, so there are no vulnerability databases to fetch"
        : `offline vulnerability databases could NOT be downloaded (${why(result)}) — scans would need api.osv.dev, which the execution phase does not allow`,
    durationMs: Date.now() - started,
  };
}
