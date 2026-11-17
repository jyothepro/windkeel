

import type { Pool } from "pg";
import { loadConfigFrom, revisionSource, type SetupServiceSpec, type SetupSpec } from "@windkeel/verification/config.js";
import type { SandboxGitCredentials } from "../sandbox/git-credentials.js";
import { scrubCloneCredentials } from "../sandbox/git-credentials.js";
import { hardenedGit } from "../sandbox/git-hardening.js";
import { detectEcosystems, installDependencies } from "../sandbox/dependencies.js";
import { installPhasePolicy } from "../sandbox/network-phase.js";
import type { SandboxHandle, SandboxProvider } from "../sandbox/provider.js";
import { MIN_REDACTABLE_LENGTH, redactDeep, secretForms, secretRedactor } from "../sandbox/redact.js";
import {
  computeSnapshotKey,
  readKeyBlobs,
  snapshotKeyPaths,
} from "../sandbox/environment-snapshot.js";
import { getRepository } from "./repository-entity.js";
import { proposeSetup } from "./setup-detection.js";
export {
  DEFAULT_SNAPSHOT_TTL_DAYS,
  KEEP_READY_SNAPSHOTS,
  claimSnapshotBuild,
  claimSnapshotRequests,
  findReadySnapshot,
  invalidateSnapshots,
  listSnapshots,
  markSnapshotFailed,
  markSnapshotReady,
  pendingSnapshotRequest,
  recordWorkspaceEnvironment,
  requestSnapshotBuild,
  touchSnapshot,
} from "./stores/environment-snapshot-store.js";
export type {
  RestorableSnapshot,
} from "./stores/environment-snapshot-store.js";
import {
  claimSnapshotBuild,
  claimSnapshotRequests,
  markSnapshotFailed,
  markSnapshotReady,
  setSnapshotProposedSetup,
  type EnvironmentSnapshot,
} from "./stores/environment-snapshot-store.js";


export interface ServiceStart {
  name: string;
  status: "started" | "failed" | "not_ready";
  detail: string;
}

export async function startServices(
  handle: SandboxHandle,
  services: readonly SetupServiceSpec[],
): Promise<ServiceStart[]> {
  const out: ServiceStart[] = [];
  for (const service of services) {
    const started = await handle.exec("sh", { args: ["-c", service.start], cwd: handle.checkoutPath, env: { CI: "1" } });
    if (started.error || started.status !== 0) {
      out.push({
        name: service.name,
        status: "failed",
        detail: `start exited ${started.status ?? started.error}${started.stderr.trim() ? `: ${started.stderr.trim().slice(-300)}` : ""}`,
      });
      continue;
    }
    if (!service.ready) {
      out.push({ name: service.name, status: "started", detail: "started (no readiness command declared)" });
      continue;
    }

    const waited = await handle.exec("sh", {
      args: [
        "-c",
        'end=$(( $(date +%s) + WINDKEEL_READY_SECS )); until sh -c "$WINDKEEL_READY"; do ' +
          '[ "$(date +%s)" -ge "$end" ] && exit 124; sleep 1; done',
      ],
      cwd: handle.checkoutPath,
      env: { CI: "1", WINDKEEL_READY: service.ready, WINDKEEL_READY_SECS: String(service.readyTimeoutSec) },
    });
    out.push(
      waited.status === 0
        ? { name: service.name, status: "started", detail: "started and ready" }
        : {
            name: service.name,
            status: "not_ready",
            detail:
              waited.status === 124
                ? `not ready within ${service.readyTimeoutSec}s`
                : `readiness check could not run (${waited.error ?? `exit ${waited.status}`})`,
          },
    );
  }
  return out;
}

export interface LeakFinding {

  key: string;

  files: string[];
}

export interface LeakScan {
  findings: LeakFinding[];

  incomplete: string[];

  absent: string[];

  searched: string[];

  asRoot: boolean;
  durationMs: number;
}

export const SYSTEM_SCAN_ROOTS = ["/etc", "/tmp", "/var/tmp", "/usr/local/etc", "/opt", "/var/lib", "/root"] as const;

const LEAK_SCAN_TIMEOUT_SEC = 900;

const ATTRIBUTION_CHUNK = 200;

export function leakScanRoots(options: {
  checkoutPath: string;
  home?: string | undefined;
  isolatedFilesystem: boolean;
  systemRoot?: string;
}): string[] {
  const clean = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  const candidates = [clean(options.checkoutPath)];
  if (options.isolatedFilesystem) {
    const home = clean((options.home ?? "").trim());
    if (home.startsWith("/") && home !== "/") candidates.push(home);
    const prefix = clean(options.systemRoot ?? "");
    for (const root of SYSTEM_SCAN_ROOTS) candidates.push(`${prefix === "/" ? "" : prefix}${root}`);
  }
  const unique = [...new Set(candidates.filter((path) => path.startsWith("/") && path !== "/"))];
  return unique.filter((root) => !unique.some((other) => other !== root && root.startsWith(`${other}/`)));
}

function scanPatterns(value: string): string[] {
  const out = new Set<string>();
  for (const form of secretForms(value)) {
    if (!/[\r\n]/.test(form)) {
      out.add(form);
      continue;
    }
    const longest = form.split(/[\r\n]+/).sort((a, b) => b.length - a.length)[0] ?? "";
    if (longest.length >= MIN_REDACTABLE_LENGTH) out.add(longest);
  }
  return [...out];
}

const LEAK_SCAN_SCRIPT = [
  "export LC_ALL=C",
  '[ -n "${WINDKEEL_LEAK_PATTERNS:-}" ] || exit 97',
  'mode=$1; shift',
  'if [ "$mode" = roots ]; then',
  "  for r do",
  "    shift",
  '    if [ ! -e "$r" ]; then printf "windkeel-leak-scan: absent %s\\n" "$r" >&2',
  '    elif [ -d "$r" ] && [ -r "$r" ] && [ -x "$r" ]; then set -- "$@" "$r"',
  '    elif [ ! -d "$r" ] && [ -r "$r" ]; then set -- "$@" "$r"',
  '    else printf "windkeel-leak-scan: unsearchable %s\\n" "$r" >&2; fi',
  "  done",
  "fi",
  'if [ "$#" -eq 0 ]; then printf "windkeel-leak-scan: exit 1\\n" >&2; exit 1; fi',
  'if command -v timeout >/dev/null 2>&1; then t="timeout $WINDKEEL_LEAK_SECS"; else t=; fi',
  '$t grep -rlF --null -D skip -e "$WINDKEEL_LEAK_PATTERNS" -- "$@"',
  "s=$?",
  'printf "windkeel-leak-scan: exit %s\\n" "$s" >&2',
  'exit "$s"',
].join("\n");

interface ScanPass {
  status: number;
  hits: string[];
  absent: string[];
  unsearchable: string[];

  unreadable: string[];

  vanished: string[];

  other: string[];
}

function parsePass(result: { status: number | null; stdout: string; stderr: string }): ScanPass | null {
  const pass: ScanPass = { status: -1, hits: [], absent: [], unsearchable: [], unreadable: [], vanished: [], other: [] };
  let marked = false;
  for (const line of result.stderr.split("\n")) {
    if (!line.trim()) continue;
    const marker = /^windkeel-leak-scan: (absent|unsearchable|exit) (.*)$/.exec(line);
    if (marker) {
      const [, kind, rest] = marker as unknown as [string, string, string];
      if (kind === "absent") pass.absent.push(rest);
      else if (kind === "unsearchable") pass.unsearchable.push(rest);
      else {
        marked = true;
        pass.status = Number(rest);
      }
      continue;
    }
    const error = line.startsWith("grep: warning: ") ? null : /^grep: (.*): ([^:]+)$/.exec(line);
    if (error) {
      const [, path, reason] = error as unknown as [string, string, string];
      if (reason === "No such file or directory") pass.vanished.push(path);
      else pass.unreadable.push(`${path} (${reason})`);
      continue;
    }
    pass.other.push(line);
  }
  if (!marked) return null;
  pass.hits = result.stdout.split("\0").filter(Boolean);
  return pass;
}

export async function scanForSecrets(
  handle: SandboxHandle,
  secrets: Readonly<Record<string, string>>,
  roots: readonly string[],
  options: { escalate?: boolean; timeoutSec?: number } = {},
): Promise<LeakScan> {
  const started = Date.now();
  const byKey = Object.entries(secrets)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => ({ key, patterns: scanPatterns(value) }))
    .filter((entry) => entry.patterns.length > 0);
  const all = [...new Set(byKey.flatMap((entry) => entry.patterns))];
  const scan: LeakScan = { findings: [], incomplete: [], absent: [], searched: [], asRoot: false, durationMs: 0 };
  if (!all.length) {
    scan.durationMs = Date.now() - started;
    return scan;
  }

  let sudo = false;
  if (options.escalate) {
    const uid = await handle.exec("id", { args: ["-u"] });
    if (uid.status === 0 && uid.stdout.trim() === "0") scan.asRoot = true;
    else if ((await handle.exec("sudo", { args: ["-n", "true"] })).status === 0) sudo = true;
  }
  const secs = String(options.timeoutSec ?? LEAK_SCAN_TIMEOUT_SEC);
  const run = async (patterns: readonly string[], mode: "roots" | "files", paths: readonly string[]) => {
    const env = { WINDKEEL_LEAK_PATTERNS: patterns.join("\n"), WINDKEEL_LEAK_SECS: secs };
    const argv = ["-c", LEAK_SCAN_SCRIPT, "windkeel-leak-scan", mode, ...paths];
    if (sudo) {
      const elevated = parsePass(
        await handle.exec("sudo", { args: ["-n", "--preserve-env=WINDKEEL_LEAK_PATTERNS,WINDKEEL_LEAK_SECS", "sh", ...argv], env }),
      );
      if (elevated) {
        scan.asRoot = true;
        return elevated;
      }
      sudo = false;
      scan.asRoot = false;
    }
    const result = await handle.exec("sh", { args: argv, env });
    const pass = parsePass(result);
    if (!pass) {
      throw new Error(
        `the secret scan did not run to completion (${result.error ?? `exit ${result.status}`}); ` +
          "a snapshot is never taken without a complete scan",
      );
    }
    return pass;
  };
  const check = (pass: ScanPass, what: string) => {
    if (pass.status === 124) {
      scan.incomplete.push(`${what}: timed out after ${secs}s`);
    } else if (pass.status !== 0 && pass.status !== 1 && pass.status !== 2) {
      scan.incomplete.push(`${what}: grep exited ${pass.status}`);
    } else if (pass.status === 2 && !pass.unreadable.length && !pass.vanished.length && !pass.unsearchable.length) {
      scan.incomplete.push(`${what}: grep reported an error${pass.other.length ? ` (${pass.other.slice(0, 3).join("; ")})` : ""}`);
    }
    for (const path of pass.unreadable) scan.incomplete.push(`${path}: could not be read`);
  };

  const first = await run(all, "roots", roots);
  scan.absent = first.absent;
  scan.searched = roots.filter((root) => !first.absent.includes(root) && !first.unsearchable.includes(root));
  for (const root of first.unsearchable) scan.incomplete.push(`${root}: root could not be searched`);
  check(first, "the scan");

  const hits = [...new Set(first.hits)];
  const attributed = new Set<string>();
  const relative = (hit: string) => {
    const root = roots.find((r) => hit.startsWith(`${r}/`));
    return root && root !== handle.checkoutPath ? hit : root ? hit.slice(root.length + 1) : hit;
  };
  for (const { key, patterns } of byKey) {
    const files = new Set<string>();
    for (let i = 0; i < hits.length; i += ATTRIBUTION_CHUNK) {
      const pass = await run(patterns, "files", hits.slice(i, i + ATTRIBUTION_CHUNK));
      check(pass, `attributing ${key}`);
      for (const hit of pass.hits) {
        attributed.add(hit);
        files.add(relative(hit));
      }
    }
    if (files.size) scan.findings.push({ key, files: [...files].sort() });
  }
  for (const hit of hits) {
    if (!attributed.has(hit)) scan.incomplete.push(`${relative(hit)}: matched a secret, then could not be re-read to name it`);
  }
  scan.durationMs = Date.now() - started;
  return scan;
}

export interface BuildDeps {

  secrets: (
    organizationId: string,
    repositoryId: string,
  ) => Promise<{ values: Record<string, string>; unopenable: string[]; versions: Array<{ key: string; updatedAt: Date }> }>;

  gitCredentials?: { broker: SandboxGitCredentials; host: string } | undefined;
  ttlDays: number;

  image?: string;
  builtBy?: string;
  timeoutMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type BuildOutcome =
  | { status: "ready"; snapshot: EnvironmentSnapshot }
  | { status: "failed"; snapshotId: string | null; detail: string }
  | { status: "exists"; cacheKey: string }
  | { status: "unsupported"; detail: string }
  | { status: "invalidated"; snapshotId: string };

const SETUP_COMMAND_SCRIPT =
  'if command -v timeout >/dev/null 2>&1; then exec timeout "$WINDKEEL_SETUP_SECS" sh -c "$WINDKEEL_SETUP_RUN"; ' +
  'else exec sh -c "$WINDKEEL_SETUP_RUN"; fi';

export async function buildEnvironmentSnapshot(
  pool: Pool,
  provider: SandboxProvider,
  deps: BuildDeps,
  target: { organizationId: string; repositoryId: string },
): Promise<BuildOutcome> {
  const log = deps.log ?? (() => {});
  if (!provider.capabilities.snapshots) {
    return { status: "unsupported", detail: `the ${provider.name} provider cannot snapshot` };
  }
  const repository = await getRepository(pool, target.repositoryId);
  if (!repository) return { status: "failed", snapshotId: null, detail: `no repository ${target.repositoryId}` };

  const secrets = await deps.secrets(target.organizationId, target.repositoryId);
  const redact = secretRedactor(secrets.values);

  const credential = deps.gitCredentials
    ? await deps.gitCredentials.broker.forWorkspace(
        `environment-setup:${target.organizationId}:${target.repositoryId}:${Date.now()}`,
        "verifier",
        { owner: repository.owner, name: repository.name },
      )
    : undefined;
  const handle = await provider.create({
    role: "verifier",
    repoUrl: repository.cloneUrl,
    gitRevision: repository.defaultBranch,
    operatorModelKey: false,
    timeoutMs: deps.timeoutMs ?? 2 * 60 * 60_000,
    ...(credential ? { gitCredentials: credential } : {}),
  });

  let claimed: EnvironmentSnapshot | null = null;
  let snapshotted = false;
  try {
    if (credential) await scrubCloneCredentials(handle, credential.token);
    const head = await hardenedGit((c, o) => handle.exec(c, o), ["rev-parse", "HEAD"], { cwd: handle.checkoutPath });
    const baseSha = head.stdout.trim();
    if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new Error(`could not resolve the default branch's commit: ${head.stderr.trim() || `exit ${head.status}`}`);
    }

    const source = await revisionSource(handle, handle.checkoutPath, baseSha);
    if (!source) throw new Error(`could not read ${baseSha} from the setup checkout`);
    const config = await loadConfigFrom(source);
    const setup: SetupSpec | null = config.setup ?? null;
    const setupRejected = (config.rejectedEntries ?? []).filter((r) => r.kind === "setup");

    const blobs = await readKeyBlobs(handle, baseSha, setup);
    const cacheKey = computeSnapshotKey({
      provider: { name: provider.name, image: deps.image ?? provider.name },
      setup,
      blobs,
      secrets: secrets.versions,
    });
    claimed = await claimSnapshotBuild(pool, {
      organizationId: target.organizationId,
      repositoryId: target.repositoryId,
      sandboxProvider: provider.name,
      cacheKey,
      keyPaths: snapshotKeyPaths(setup),
      baseSha,
      builtBy: deps.builtBy ?? "system",
    });
    if (!claimed) {
      await handle.destroy().catch(() => {});
      return { status: "exists", cacheKey };
    }

    const proposal = await proposeSetup(handle, handle.checkoutPath).catch(() => null);
    if (proposal) {
      await setSnapshotProposedSetup(pool, claimed.id, JSON.stringify(proposal));
      claimed = { ...claimed, proposedSetup: proposal };
    }

    const fail = async (detail: string): Promise<BuildOutcome> => {
      const safe = redact(detail);
      await markSnapshotFailed(pool, claimed!.id, safe);
      log("environment snapshot failed", { snapshotId: claimed!.id, repositoryId: target.repositoryId });
      return { status: "failed", snapshotId: claimed!.id, detail: safe };
    };

    if (setupRejected.length) {
      return await fail(
        `windkeel.config.json \`setup\` has refused entries: ${setupRejected.map((r) => `${r.value} — ${r.reason}`).join("; ")}`,
      );
    }
    const missing = (setup?.secrets ?? []).filter((key) => !(key in secrets.values));
    if (missing.length) {
      return await fail(
        `setup requires repository secret(s) ${missing.join(", ")}, which ` +
          (missing.some((k) => secrets.unopenable.includes(k)) ? "could not be opened" : "are not set") +
          " for this repository",
      );
    }

    const { hostsFromSecretValues } = await import("./repository-secrets.js");
    await handle.updateNetworkPolicy(
      installPhasePolicy({
        ecosystems: await detectEcosystems(handle),
        systemTools: false,
        scanners: false,
        extraHosts: [...hostsFromSecretValues(secrets.values), ...(setup?.egress ?? [])],
      }),
    );

    const install = redactDeep(
      await installDependencies(handle, { secrets: secrets.values, unopenableSecrets: secrets.unopenable }),
      redact,
    );
    if (install.status === "failed") return await fail(`dependency install failed: ${install.detail}`);

    const services = await startServices(handle, setup?.services ?? []);
    const broken = services.filter((s) => s.status !== "started");
    if (broken.length) {
      return await fail(`setup services did not come up: ${broken.map((s) => `${s.name} (${s.detail})`).join("; ")}`);
    }

    const ran: string[] = [];
    for (const command of setup?.commands ?? []) {
      const result = await handle.exec("sh", {
        args: ["-c", SETUP_COMMAND_SCRIPT],
        cwd: handle.checkoutPath,
        env: {
          CI: "1",
          ...secrets.values,
          WINDKEEL_SETUP_RUN: command.run,
          WINDKEEL_SETUP_SECS: String(command.timeoutSec),
        },
      });
      if (result.error || result.status !== 0) {
        return await fail(
          `setup command ${command.name} ` +
            (result.status === 124 ? `timed out after ${command.timeoutSec}s` : `exited ${result.status ?? result.error}`) +
            (result.stderr.trim() ? `: ${result.stderr.trim().slice(-500)}` : ""),
        );
      }
      ran.push(command.name);
    }

    if (credential) await scrubCloneCredentials(handle, credential.token);

    const untracked = await excludeUntracked(handle);
    if ("tooMany" in untracked) {
      return await fail(
        `setup left ${untracked.tooMany} untracked file(s) in the checkout that no .gitignore covers ` +
          `(more than ${MAX_EXCLUDED_UNTRACKED} can be excluded file by file); ignore its output directories ` +
          "in .gitignore so a maker's own new files are not mistaken for it (ADR-0031)",
      );
    }

    const isolated = provider.capabilities.isolatedFilesystem;
    const home = isolated ? (await handle.exec("sh", { args: ["-c", 'printf %s "$HOME"'] })).stdout.trim() : "";
    const roots = leakScanRoots({ checkoutPath: handle.checkoutPath, home, isolatedFilesystem: isolated });
    const scan = await scanForSecrets(handle, secrets.values, roots, { escalate: isolated });
    const scanSecs = (scan.durationMs / 1000).toFixed(1);
    log("environment snapshot secret scan", {
      snapshotId: claimed.id,
      repositoryId: target.repositoryId,
      durationMs: scan.durationMs,
      searched: scan.searched,
      absent: scan.absent,
      asRoot: scan.asRoot,
      findings: scan.findings.map((f) => f.key),
      incomplete: scan.incomplete.length,
    });
    const leaks = scan.findings;
    if (leaks.length) {
      return await fail(
        "a repository secret's value was found on disk after setup, and a snapshot is restored into maker " +
          "sandboxes, which are assumed hostile: " +
          leaks.map((l) => `${l.key} in ${l.files.slice(0, 5).join(", ")}${l.files.length > 5 ? ", …" : ""}`).join("; ") +
          ". setup.commands must not persist credentials (ADR-0031)" +
          (scan.incomplete.length ? `; the scan was also incomplete: ${scan.incomplete.slice(0, 5).join("; ")}` : ""),
      );
    }
    if (scan.incomplete.length) {
      return await fail(
        `the secret scan could not look everywhere a snapshot keeps (${scan.asRoot ? "as root" : "without root"}, ${scanSecs}s): ` +
          scan.incomplete.slice(0, 10).join("; ") +
          (scan.incomplete.length > 10 ? `; and ${scan.incomplete.length - 10} more` : "") +
          ". a snapshot is never taken without a complete scan (ADR-0031)",
      );
    }

    if (handle.role !== "verifier") throw new Error("refusing to snapshot a sandbox whose role is not the setup role");
    if (!handle.snapshot) throw new Error(`the ${provider.name} handle has no snapshot()`);
    const shortSecrets = Object.entries(secrets.values).filter(([, v]) => secretForms(v).length === 0).map(([k]) => k);
    const detail =
      `${install.detail}` +
      (ran.length ? `; setup ran ${ran.join(", ")}` : "; no setup commands declared") +
      (services.length ? `; services ${services.map((s) => s.name).join(", ")} started` : "") +
      (untracked.excluded ? `; ${untracked.excluded} untracked setup output path(s) excluded from git` : "") +
      `; secret scan clean over ${Object.keys(secrets.values).length} secret(s)` +
      (scan.searched.length ? ` across ${scan.searched.length} root(s)${isolated ? (scan.asRoot ? " as root" : " without root") : ""} in ${scanSecs}s` : "") +
      (shortSecrets.length ? ` (${shortSecrets.join(", ")} too short to scan for)` : "");
    snapshotted = true;
    const snap = await handle.snapshot({ expirationMs: Math.round(deps.ttlDays * 86_400_000) });
    const ready = await markSnapshotReady(pool, claimed.id, {
      providerSnapshotId: snap.snapshotId,
      sizeBytes: snap.sizeBytes,
      detail: redact(detail),
      ttlDays: deps.ttlDays,
    });
    if (!ready) {

      await provider.deleteSnapshot?.(snap.snapshotId).catch(() => {});
      return { status: "invalidated", snapshotId: claimed.id };
    }
    log("environment snapshot ready", { snapshotId: ready.id, repositoryId: target.repositoryId });
    return { status: "ready", snapshot: ready };
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (claimed) {
      await markSnapshotFailed(pool, claimed.id, detail);
      return { status: "failed", snapshotId: claimed.id, detail };
    }
    throw new Error(`environment snapshot: ${detail}`);
  } finally {
    if (!snapshotted) await handle.destroy().catch(() => {});
  }
}

function excludeLine(path: string): string {
  const escaped = path.replace(/[\\*?[\]]/g, (c) => `\\${c}`).replace(/ $/, "\\ ");
  return `/${escaped}`;
}

const MAX_EXCLUDED_UNTRACKED = 5000;

async function excludeUntracked(handle: SandboxHandle): Promise<{ excluded: number } | { tooMany: number }> {
  const listed = await hardenedGit((c, o) => handle.exec(c, o), ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: handle.checkoutPath,
  });
  if (listed.status !== 0) return { excluded: 0 };
  const paths = listed.stdout.split("\0").filter((p) => p && !/[\r\n]/.test(p));
  if (!paths.length) return { excluded: 0 };
  if (paths.length > MAX_EXCLUDED_UNTRACKED) return { tooMany: paths.length };
  const file = `${handle.checkoutPath}/.git/info/exclude`;
  await handle.exec("mkdir", { args: ["-p", `${handle.checkoutPath}/.git/info`] });
  const existing = (await handle.exists(file)) ? (await handle.readFile(file)).toString("utf8") : "";
  const block =
    "# environment snapshot (#387): what setup produced, kept out of every candidate\n" +
    paths.map((p) => excludeLine(p.replace(/\/$/, ""))).join("\n") +
    "\n";
  await handle.writeFile(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`);
  return { excluded: paths.length };
}

export async function processSnapshotRequests(
  pool: Pool,
  provider: SandboxProvider,
  deps: BuildDeps,
  limit = 1,
): Promise<BuildOutcome[]> {
  const outcomes: BuildOutcome[] = [];
  for (const request of await claimSnapshotRequests(pool, limit)) {
    try {
      outcomes.push(
        await buildEnvironmentSnapshot(pool, provider, { ...deps, builtBy: request.requestedBy }, request),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log?.("environment snapshot build failed before it claimed a row", { repositoryId: request.repositoryId, detail });
      outcomes.push({ status: "failed", snapshotId: null, detail });
    }
  }
  return outcomes;
}

export function secretsFromTable(
  pool: Pool,
  privateKeys: readonly string[] | undefined,
): BuildDeps["secrets"] {
  return async (organizationId, repositoryId) => {
    const { listRepositorySecrets, resolveRepositorySecrets } = await import("./repository-secrets.js");
    const versions = (await listRepositorySecrets(pool, organizationId, repositoryId)).map((s) => ({
      key: s.key,
      updatedAt: s.updatedAt,
    }));
    if (!privateKeys?.length) {
      return { values: {}, unopenable: versions.map((v) => v.key), versions };
    }
    const resolved = await resolveRepositorySecrets(pool, organizationId, repositoryId, privateKeys);
    return { values: resolved.values, unopenable: resolved.unopenable.map((u) => u.key), versions };
  };
}
