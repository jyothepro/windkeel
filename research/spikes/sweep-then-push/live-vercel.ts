/**
 * Live harness: sweep-then-push in a real Vercel Sandbox. **Never run by the spike's author** —
 * no Vercel credentials were in the environment it was written in (FINDINGS.md says so). Run it
 * with:
 *
 *     VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *       node research/spikes/sweep-then-push/.build/research/spikes/sweep-then-push/live-vercel.js
 *
 * It creates one sandbox (10-minute timeout, stopped at the end), pushes to a **bare repository
 * inside the sandbox** over `file://` — no GitHub, no App, no real token; the token issuer is a
 * fake that writes a canary value, so the harness can check nothing ever read it — and prints a
 * JSON report. Three scenarios:
 *
 * A. **single-user** (today's image: the person is the default user, who has passwordless sudo).
 *    The "person" plants a `setsid` daemon, a `nohup` loop that copies any `/tmp/windkeel-push-*`
 *    file it sees to `/tmp/stolen`, a double-forked sleeper, git hooks that drop markers, and
 *    staged/unstaged/untracked/ignored edits. Expect: pushed; no marker; nothing stolen; remote
 *    branch at the returned SHA; author = noreply identity.
 * B. **root survivor**: after the baseline, the default user starts a root daemon with `sudo
 *    setsid`. Expect: refused at `survivors` (`not-in-baseline`), token never minted.
 * C. **two-user**: `createUser("person")`. Probes whether the person has sudo and whether the
 *    person can read a 0600 file of the default user; sweeps as the person; pushes with git run as
 *    root (the person owns the checkout). Expect: no sudo, no read, pushed.
 */

import { Sandbox } from "@vercel/sandbox";
import { findSurvivors, sweepThenPush, type PushTokenIssuer, type TraceEvent } from "./sweep-then-push.js";
import { processControl, run, workspaceExec } from "./vercel-workspace.js";

const CANARY = `canary-${Math.random().toString(36).slice(2)}`;
const WINDKEEL = { name: "Windkeel", email: process.env.WINDKEEL_GIT_AUTHOR_EMAIL ?? "factory@windkeel.invalid" };
const PERSON = { githubId: 1234567, login: "spike-person", name: "Spike Person" };
const BRANCH = "windkeel/run-spike-368";

function issuer(log: string[]): PushTokenIssuer {
  return {
    async mint(request) {
      log.push(`mint ${request.purpose}`);
      return { username: "x-access-token", token: CANARY, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    },
    async revoke() {
      log.push("revoke");
    },
  };
}

async function sh(sandbox: Sandbox, script: string, opts: { sudo?: boolean; user?: string } = {}) {
  if (opts.user) return run(sandbox, "sudo", { args: ["-n", "-u", opts.user, "sh", "-c", script] });
  return run(sandbox, "sh", { args: ["-c", script], ...(opts.sudo ? { sudo: true } : {}) });
}

/** A bare remote and a checkout at `dir`, seeded with one commit on the run branch. Returns the seed SHA. */
async function seed(sandbox: Sandbox, dir: string, user?: string): Promise<string> {
  const remote = `${dir}-remote.git`;
  const script = [
    "set -e",
    `rm -rf ${dir} ${remote}`,
    `git init -q --bare ${remote}`,
    `git init -q ${dir}`,
    `cd ${dir}`,
    "printf 'node_modules\\n.env\\n' > .gitignore",
    "echo 'export const a = 1;' > a.ts",
    "git add -A",
    "git -c user.name=Windkeel -c user.email=factory@windkeel.invalid commit -q -m seed",
    `git push -q file://${remote} HEAD:refs/heads/${BRANCH}`,
    "git rev-parse HEAD",
  ].join("\n");
  const result = await sh(sandbox, script, user ? { user } : {});
  if (result.status !== 0) throw new Error(`seed failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").pop()!;
}

/** What a hostile session leaves behind. Run as the person. */
function plant(dir: string): string {
  return [
    `cd ${dir}`,
    "echo 'export const a = 2;' > a.ts && git add a.ts", // staged
    "echo 'export const b = 1;' > b.ts", // untracked
    "echo 'SECRET=1' > .env", // ignored
    "echo 'export const a = 3;' >> a.ts", // unstaged on top of staged
    "for h in pre-commit post-commit pre-push reference-transaction; do printf '#!/bin/sh\\ntouch /tmp/hook-ran-%s\\n' $h > .git/hooks/$h; chmod +x .git/hooks/$h; done",
    "setsid sh -c 'while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &",
    "nohup sh -c 'while :; do cat /tmp/windkeel-push-*/* >> /tmp/stolen 2>/dev/null; sleep 0.05; done' </dev/null >/dev/null 2>&1 &",
    "sh -c 'sh -c \"sleep 600\" &' </dev/null >/dev/null 2>&1",
    "sleep 1",
  ].join("\n");
}

async function scenario(
  name: string,
  sandbox: Sandbox,
  opts: { dir: string; personUser?: string; rootSurvivor?: boolean; gitAsRoot?: boolean },
): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { scenario: name };
  await sh(sandbox, "rm -f /tmp/stolen /tmp/hook-ran-*", { sudo: true });
  const seedSha = await seed(sandbox, opts.dir, opts.personUser);
  const control = processControl(sandbox, opts.personUser);
  const baseline = (await control.snapshot()).processes;
  const personUid = Number(
    (await sh(sandbox, "id -u", opts.personUser ? { user: opts.personUser } : {})).stdout.trim(),
  );
  report.personUid = personUid;
  report.personHasSudo = (await sh(sandbox, "sudo -n true", opts.personUser ? { user: opts.personUser } : {})).status === 0;
  if (opts.personUser) {
    await sh(sandbox, "echo s > /tmp/windkeel-only && chmod 600 /tmp/windkeel-only");
    report.personCanReadWindkeelFile = (await sh(sandbox, "cat /tmp/windkeel-only", { user: opts.personUser })).status === 0;
  }

  await sh(sandbox, plant(opts.dir), opts.personUser ? { user: opts.personUser } : {});
  if (opts.rootSurvivor) await sh(sandbox, "setsid sh -c 'sleep 600' </dev/null >/dev/null 2>&1 &", { sudo: true });
  report.beforeSweep = findSurvivors(await control.snapshot(), { personUids: [personUid], baseline }).map(
    (s) => `${s.process.comm}:${s.reason}`,
  );

  const tokenLog: string[] = [];
  const events: TraceEvent["type"][] = [];
  const workspace = workspaceExec(sandbox, opts.dir);
  const asRoot = opts.gitAsRoot
    ? { ...workspace, exec: (c: string, o: Parameters<typeof workspace.exec>[1] = {}) => run(sandbox, c, { cwd: opts.dir, ...o, sudo: true }) }
    : workspace;
  try {
    const result = await sweepThenPush({
      runId: "spike-368",
      workspace: asRoot,
      processes: control,
      policy: { personUids: [personUid], baseline },
      checkoutPath: opts.dir,
      repositoryUrl: `file://${opts.dir}-remote.git`,
      branch: BRANCH,
      seedSha,
      person: PERSON,
      windkeel: WINDKEEL,
      tokens: issuer(tokenLog),
      trace: (e) => events.push(e.type),
    });
    report.result = result;
    if (result.kind === "pushed") {
      report.remoteHead = (await sh(sandbox, `git --git-dir=${opts.dir}-remote.git rev-parse refs/heads/${BRANCH}`, { sudo: true })).stdout.trim();
      report.pushedCommit = (await sh(sandbox, `git --git-dir=${opts.dir}-remote.git cat-file commit ${result.candidateSha}`, { sudo: true })).stdout;
      report.pushedFiles = (await sh(sandbox, `git --git-dir=${opts.dir}-remote.git ls-tree -r --name-only ${result.candidateSha}`, { sudo: true })).stdout.trim().split("\n");
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.events = events;
  report.tokenLog = tokenLog;
  report.hooksRan = (await sh(sandbox, "ls /tmp/hook-ran-* 2>/dev/null || true", { sudo: true })).stdout.trim();
  report.stolen = (await sh(sandbox, "cat /tmp/stolen 2>/dev/null || true", { sudo: true })).stdout.includes(CANARY);
  report.tokenFilesLeft = (await sh(sandbox, "ls -d /tmp/windkeel-push-* 2>/dev/null || true", { sudo: true })).stdout.trim();
  report.afterSurvivors = findSurvivors(await control.snapshot(), { personUids: [personUid], baseline }).map(
    (s) => `${s.process.pid}/${s.process.comm}:${s.reason}`,
  );
  if (opts.rootSurvivor) await sh(sandbox, "pkill -KILL -f 'sleep 600' || true", { sudo: true });
  return report;
}

async function main(): Promise<void> {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT_ID) {
    console.error("VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are required");
    process.exit(2);
  }
  const sandbox = await Sandbox.create({
    timeout: 10 * 60_000,
    token: VERCEL_TOKEN,
    teamId: VERCEL_TEAM_ID,
    projectId: VERCEL_PROJECT_ID,
  });
  const reports: Record<string, unknown>[] = [];
  try {
    const whoami = await sh(sandbox, "id; uname -r; cat /etc/os-release | head -2; cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null; ls /etc/cron* /var/spool/cron 2>/dev/null | head");
    reports.push({ environment: whoami.stdout });
    const home = (await sh(sandbox, "echo $HOME")).stdout.trim();
    reports.push(await scenario("A single-user", sandbox, { dir: `${home}/spike-a` }));
    reports.push(await scenario("B root survivor", sandbox, { dir: `${home}/spike-b`, rootSurvivor: true }));
    const person = await sandbox.createUser("person");
    reports.push(await scenario("C two-user", sandbox, { dir: `${person.homeDir}/spike-c`, personUser: "person", gitAsRoot: true }));
  } finally {
    await sandbox.stop().catch(() => {});
  }
  console.log(JSON.stringify(reports, null, 2));
}

void main();
