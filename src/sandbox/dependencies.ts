import type { SandboxHandle } from "./provider.js";
import { secretRedactor } from "./redact.js";
import { HARDENED_GIT_ARGS, HARDENED_GIT_ENV } from "./git-hardening.js";

export type Ecosystem = "npm" | "python" | "go";

interface Installer {
  ecosystem: Ecosystem;
  marker: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  reproducible: boolean;
  candidate?: {
    args: string[];
    env?: Record<string, string>;
    scripts?: { command: string; args: string[] };
  };
}

const NO_SCRIPTS = {
  args: ["--ignore-scripts"],
  env: { npm_config_ignore_scripts: "true", YARN_ENABLE_SCRIPTS: "false" },
};

const INSTALLERS: ReadonlyArray<Installer> = [
  {
    ecosystem: "npm",
    marker: "pnpm-lock.yaml",
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
    reproducible: true,
    candidate: {
      args: [...NO_SCRIPTS.args, "--ignore-pnpmfile"],
      env: NO_SCRIPTS.env,
      scripts: { command: "pnpm", args: ["rebuild"] },
    },
  },
  {
    ecosystem: "npm",
    marker: "yarn.lock",
    command: "yarn",
    args: ["install", "--frozen-lockfile"],
    reproducible: true,
    candidate: NO_SCRIPTS,
  },
  {
    ecosystem: "npm",
    marker: "package-lock.json",
    command: "npm",
    args: ["ci"],
    reproducible: true,
    candidate: { ...NO_SCRIPTS, scripts: { command: "npm", args: ["rebuild"] } },
  },
  {
    ecosystem: "npm",
    marker: "npm-shrinkwrap.json",
    command: "npm",
    args: ["ci"],
    reproducible: true,
    candidate: { ...NO_SCRIPTS, scripts: { command: "npm", args: ["rebuild"] } },
  },
  { ecosystem: "python", marker: "uv.lock", command: "uv", args: ["sync", "--frozen"], reproducible: true },
  { ecosystem: "python", marker: "poetry.lock", command: "poetry", args: ["install", "--sync"], reproducible: true },
  {
    ecosystem: "python",
    marker: "requirements.txt",
    command: "pip",
    args: ["install", "-r", "requirements.txt"],
    env: { PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_ROOT_USER_ACTION: "ignore" },
    reproducible: false,
  },
  { ecosystem: "go", marker: "go.mod", command: "go", args: ["mod", "download"], reproducible: true },
];

const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "python", "go"];

export async function detectEcosystems(handle: SandboxHandle): Promise<Ecosystem[]> {
  const found: Ecosystem[] = [];
  for (const ecosystem of ECOSYSTEMS) {
    for (const installer of INSTALLERS.filter((i) => i.ecosystem === ecosystem)) {
      if (!(await handle.exists(`${handle.checkoutPath}/${installer.marker}`))) continue;
      found.push(ecosystem);
      break;
    }
  }
  return found;
}

export interface EcosystemInstall {
  ecosystem: Ecosystem;
  marker: string;
  command: string;
  status: "installed" | "failed";
  detail: string;
}

export interface DependencyInstall {
  command: string | null;
  status: "installed" | "skipped" | "failed";
  detail: string;
  installs?: EcosystemInstall[];
}

export interface InstallOptions {
  secrets?: Readonly<Record<string, string>> | undefined;
  unopenableSecrets?: readonly string[] | undefined;
  candidateTree?: boolean | undefined;
  trustedBase?: string | undefined;
}

export const INSTALL_CONFIG_PATHSPECS: readonly string[] = [
  ":(glob)**/.npmrc",
  ":(glob)**/.pnpmfile.cjs",
  ":(glob)**/.pnpmfile.mjs",
  ":(glob)**/pnpm-workspace.yaml",
  ":(glob)**/.yarnrc",
  ":(glob)**/.yarnrc.yml",
  ":(glob).yarn/plugins/**",
  ":(glob).yarn/releases/**",
  ":(glob)**/poetry.toml",
  ":(glob)**/uv.toml",
  ":(glob)**/pip.conf",
];

export const INSTALL_INPUT_PATHS: readonly string[] = [
  ...new Set([
    ...INSTALLERS.map((i) => i.marker),
    "package.json",
    "go.sum",
    "pyproject.toml",
  ]),
];

export async function installInputChanges(
  handle: SandboxHandle,
  base: string | undefined,
  extraPathspecs: readonly string[] = [],
): Promise<string[] | null> {
  if (!base) return null;
  const diff = await handle.exec("git", {
    args: [
      ...HARDENED_GIT_ARGS,
      "diff",
      "--name-only",
      "--no-renames",
      base,
      "HEAD",
      "--",
      ...INSTALL_INPUT_PATHS.map((path) => `:(glob)**/${path}`),
      ...INSTALL_CONFIG_PATHSPECS,
      ...extraPathspecs,
    ],
    cwd: handle.checkoutPath,
    env: { ...HARDENED_GIT_ENV },
  });
  if (diff.error || diff.status !== 0) return null;
  return [...new Set(diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

export async function installConfigChanges(
  handle: SandboxHandle,
  base: string | undefined,
): Promise<string[] | null> {
  if (!base) return null;
  const git = (args: string[]) =>
    handle.exec("git", {
      args: [...HARDENED_GIT_ARGS, ...args],
      cwd: handle.checkoutPath,
      env: { ...HARDENED_GIT_ENV },
    });
  const diff = await git(["diff", "--name-only", "--no-renames", base, "HEAD", "--", ...INSTALL_CONFIG_PATHSPECS]);
  if (diff.error || diff.status !== 0) return null;
  const changed = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  const packageManager = async (rev: string): Promise<string | undefined | null> => {
    const shown = await git(["show", `${rev}:package.json`]);
    if (shown.error) return null;
    if (shown.status !== 0) return undefined;
    try {
      const value = (JSON.parse(shown.stdout) as { packageManager?: unknown }).packageManager;
      return value === undefined ? undefined : JSON.stringify(value);
    } catch {
      return `unparseable:${shown.stdout}`;
    }
  };
  const [before, after] = [await packageManager(base), await packageManager("HEAD")];
  if (before === null || after === null) return null;
  if (before !== after) changed.push("package.json#packageManager");
  return changed;
}

export async function installDependencies(
  handle: SandboxHandle,
  options: InstallOptions = {},
): Promise<DependencyInstall> {
  const installs: EcosystemInstall[] = [];
  let secrets = options.secrets ?? {};
  let withheld = "";
  if (options.candidateTree && Object.keys(secrets).length) {
    const changed = await installConfigChanges(handle, options.trustedBase);
    if (changed === null || changed.length) {
      withheld =
        `repository secrets (${Object.keys(secrets).sort().join(", ")}) were WITHHELD from this ` +
        "install: " +
        (changed === null
          ? "the candidate's install configuration could not be compared with the repository's own"
          : `the candidate changed install configuration the repository owns (${changed.join(", ")}), ` +
            "and configuration a maker wrote does not get the repository's credentials") +
        " (ADR-0014, 2026-10-16 amendment)";
      secrets = {};
    }
  }

  for (const ecosystem of ECOSYSTEMS) {
    for (const installer of INSTALLERS.filter((i) => i.ecosystem === ecosystem)) {
      if (!(await handle.exists(`${handle.checkoutPath}/${installer.marker}`))) continue;
      installs.push(
        await runInstaller(
          handle,
          installer,
          secrets,
          options.unopenableSecrets ?? [],
          options.candidateTree === true,
        ),
      );
      break;
    }
  }

  if (!installs.length) {
    return {
      command: null,
      status: "skipped",
      detail: `no dependency manifest in ${handle.checkoutPath} (looked for ${INSTALLERS.map((i) => i.marker).join(", ")})`,
    };
  }

  if (withheld) for (const install of installs) install.detail = `${install.detail} (${withheld})`;
  const failed = installs.filter((i) => i.status === "failed");
  return {
    command: installs.map((i) => i.command).join(" && "),
    status: failed.length ? "failed" : "installed",
    detail: installs.map((i) => i.detail).join("; "),
    installs,
  };
}

async function runInstaller(
  handle: SandboxHandle,
  installer: Installer,
  secrets: Readonly<Record<string, string>>,
  unopenable: readonly string[],
  candidateTree: boolean,
): Promise<EcosystemInstall> {
  const { ecosystem, marker, command } = installer;
  const noScripts = candidateTree ? installer.candidate : undefined;
  const args = [...installer.args, ...(noScripts?.args ?? [])];
  const printable = `${command} ${args.join(" ")}`;
  const redact = secretRedactor(secrets);
  const result = await handle.exec(command, {
    args,
    cwd: handle.checkoutPath,
    env: {
      CI: "1",
      npm_config_fund: "false",
      npm_config_audit: "false",
      ...installer.env,
      ...noScripts?.env,
      ...secrets,
    },
  });

  const injected = Object.keys(secrets).sort();
  const withSecrets =
    (injected.length ? ` (with repository secrets: ${injected.join(", ")})` : "") +
    (unopenable.length
      ? ` (repository secrets that could not be opened and were NOT injected: ` +
        `${[...unopenable].sort().join(", ")} — the worker's WINDKEEL_SECRET_PRIVATE_KEY does not ` +
        `match the public key they were sealed to, so they need setting again)`
      : "");

  if (result.status === 0) {
    const scripts = candidateTree ? await runCandidateScripts(handle, installer, redact) : null;
    return {
      ecosystem,
      marker,
      command: scripts?.command ? `${printable} && ${scripts.command}` : printable,
      status: scripts?.status === "failed" ? "failed" : "installed",
      detail: redact(
        `${marker} → ${printable}${withSecrets}` +
          (scripts ? `; ${scripts.detail}` : "") +
          (installer.reproducible
            ? ""
            : ` (not reproducible: ${marker} is not a lockfile — it pins only what it lists, so transitive versions were resolved at install time and another run may resolve different ones)`),
      ),
    };
  }

  const missingBinary = Boolean(result.error) || result.status === 127;
  return {
    ecosystem,
    marker,
    command: printable,
    status: "failed",
    detail: redact(
      (missingBinary
        ? `${marker} → \`${command}\` is not on this sandbox image's PATH, so ${printable} could not run`
        : `${printable} exited ${result.status ?? "without a status"}`) +
        withSecrets +
        (candidateTree && !noScripts && ecosystem !== "go" ? ` (${UNSEPARABLE})` : "") +
        (result.error ? ` (${result.error})` : "") +
        (result.stderr ? `: ${result.stderr.trim().slice(-500)}` : ""),
    ),
  };
}

const UNSEPARABLE =
  "candidate tree: this package manager cannot install without executing the tree's own build " +
  "code, so that code ran with any repository secrets in its environment (ADR-0014, 2026-10-16 amendment)";

async function runCandidateScripts(
  handle: SandboxHandle,
  installer: Installer,
  redact: (text: string) => string,
): Promise<{ status: "installed" | "failed"; command: string | null; detail: string } | null> {
  if (!installer.candidate) {
    return installer.ecosystem === "go" ? null : { status: "installed", command: null, detail: UNSEPARABLE };
  }
  const step = installer.candidate.scripts;
  if (!step) {
    return {
      status: "installed",
      command: null,
      detail:
        "candidate tree: lifecycle scripts were not run — this package manager cannot run them " +
        "apart from the install that holds the repository secrets",
    };
  }
  const printable = `${step.command} ${step.args.join(" ")}`;
  const result = await handle.exec(step.command, {
    args: step.args,
    cwd: handle.checkoutPath,
    env: { CI: "1", npm_config_fund: "false", npm_config_audit: "false" },
  });
  if (result.status === 0 && !result.error) {
    return {
      status: "installed",
      command: printable,
      detail: `candidate tree: lifecycle scripts ran separately, without repository secrets (${printable})`,
    };
  }
  return {
    status: "failed",
    command: printable,
    detail: redact(
      `candidate tree: ${printable} (lifecycle scripts, without repository secrets) exited ` +
        `${result.status ?? "without a status"}` +
        (result.error ? ` (${result.error})` : "") +
        (result.stderr ? `: ${result.stderr.trim().slice(-500)}` : ""),
    ),
  };
}
