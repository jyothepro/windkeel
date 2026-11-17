import type { CommandAck, WindkeelApi, RunEvent, RunSummary, SelfView } from "../client/api.js";
import { ApiError, adviceFor } from "../client/api.js";

export const REMOTE_USAGE = `windkeel runs [--status <STATE>] [--repo <uuid>] [--task <uuid>] [--limit <n>] [--json]
      List runs on a deployed factory, newest first. Needs "windkeel login", or
      WINDKEEL_API_URL and WINDKEEL_API_TOKEN.

  windkeel queue [--json]
      What has been accepted and has not started working, oldest first.

  windkeel show <run-id> [--json]
      The run report: state, verdict, cost, caps, stop reason, pull request.

  windkeel watch <run-id> [--json] [--poll <ms>]
      Follow a run until it ends, printing each state change and cost event as it
      happens. Resumes from a cursor, so a dropped connection costs nothing. Exit 1 if
      the run ends in a state that is not a clean completion.

  windkeel attempts <run-id> [--json]
      The repair history: candidate, verdict, packet, next candidate, in order.

  windkeel approve <run-id>
  windkeel cancel <run-id> [--reason <text>]
      The same two commands as "/windkeel approve" and "/windkeel cancel" in a GitHub comment.

  windkeel say <run-id> <message>
      Queue guidance for a live maker. It may change *how* the work is done, never *what*
      the run is for — the criteria are the contract, and changing them means approval
      again. Refused unless a maker is listening.

      Queued, not delivered on the spot: a message becomes a new turn of the agent's
      session, and a turn cannot start while one is running. So it lands at the next turn
      boundary — the rest of the current turn plus up to one poll interval.

  windkeel messages <run-id> [--json]
      Everything said to a run, and whether the maker heard it: delivered, queued,
      undeliverable (with the reason), or superseded — the run ended first.

  windkeel secrets <repository-id> [--json]
      The names of a repository's secrets, with who set each one and when. Values are
      never listed: they are sealed to a key only the stage deployment holds, so there is
      no endpoint that could return one.

  windkeel secret set <repository-id> <KEY> <value|@file> [--note <text>]
  windkeel secret rm <repository-id> <KEY>
      Store, rotate or remove a credential the repository's dependency install needs — a
      private registry token, most often. Injected into the install command's environment
      in both sandboxes, and nowhere else in their lives. Names that would shadow a
      brokered credential or an interpreter's own configuration are refused.

  windkeel env status|rebuild|invalidate --repo <owner/name|repository-id> [--json]
      A repository's environment snapshots (ADR-0031): built once on the default branch
      with its secrets, scanned for those secrets, and restored by maker and verifier
      sandboxes instead of a cold install. status shows them and a suggested setup;
      rebuild asks for a new one; invalidate makes the next run cold.

  windkeel submit --repo <uuid|owner/name> --title <text> --description <text|@file>
               [--criteria <file>] [--risk low|medium|high] [--spend-cap <usd>]
               [--wall-clock <seconds>] [--maker-model <model>] [--checker-model <model>]
               [--playbook <slug>]
      Create a task and start its run (also spelled "windkeel task create"). Acceptance
      criteria are extracted from the description exactly as the GitHub label path does;
      a description with none takes the generation-then-approval route. --criteria
      appends a file of "- [ ] …" lines under an "Acceptance criteria" heading. Caps
      default to the deployment's rails; a run is never uncapped from here.
      --maker-model / --checker-model choose this task's models over the organization's
      and repository's policy ("windkeel models policy show"); the provider and key are
      inherited from that policy. The run is refused at intake if the pair is not
      independent. --playbook <slug> files the task under a playbook ("windkeel playbook
      list"): its instructions go to the maker and its checks and criteria are added to
      verification, never in place of the task's own.

  windkeel playbook list [--json]
  windkeel playbook show <slug-or-id> [--json]
      The organization's playbooks — the built-ins and its own — and what each adds:
      maker instructions, criteria, and verifier requirements (which only ever add).
      Needs playbooks.read. Create and edit them in the console's settings.

  windkeel metrics [--json]
      The ADR-0013 factory metrics — success, first-pass, repair and merge rates, cost
      per verified PR, and the per-run views. Account-wide, so an account with more than
      one organization needs an account role to read them.

  windkeel usage [--period YYYY-MM] [--json]
      This organization's metered usage for a month (default: this one), from the cost
      ledger: AI cost on Windkeel's key and on your own, compute (sandbox) cost, the
      verification line on its own, unpriced calls, what is billable, and the budget
      (ADR-0037).

  windkeel billing [--json]
  windkeel billing statement [--period YYYY-MM] [--csv] [--json]
      Credits (1 credit = $0.01, ADR-0040): plan credits left, top-ups and when they
      expire, overage so far and its cap, days until the plan resets, and this period's
      alerts. "statement" is a month's credits by run, repository and role; --csv prints
      the same export the API serves.

  windkeel reap [--dry-run] [--json]
      Destroy sandboxes no process holds a handle to — a run that ended, a workspace
      past its expiry, one marked orphaned — now, rather than at the next hourly sweep.
      --dry-run lists what would be destroyed and why, and destroys nothing. Account-
      wide, like metrics. Exit 1 if any destroy failed: that sandbox is still billing.

  windkeel capture <run-id> [--out <dir>]
      Copy the agent's own artefacts — the codex exec JSONL transcript, its stderr, the
      exit status, the workspace diff — out of the maker sandbox into the deployment's
      evidence bucket, then download them (default .windkeel/capture/<run-id>). Only works
      while the sandbox is alive: the reaper destroys it and there is no other copy. A
      capture taken earlier stays stored, and is downloaded when a new one cannot be.

  windkeel whoami [--json]
      Who this credential is, its organizations with your role and what the token can
      do in each, the token's name and scope, whether it came from the environment or
      from "windkeel login", and whether the control plane is reachable.

  windkeel integration list [--json]
  windkeel integration connect <slack|linear|jira> <installation-id>
  windkeel integration disconnect <integration-id>
  windkeel integration route add <integration-id> --repo <repository-id>
                              [--scope <kind>] [--value <v>] [--label <l>]
  windkeel integration route rm <integration-id> <route-id>
      Connect a Slack, Linear or Jira workspace (a Vercel Connect installation) to the
      organization, and say which repository its work goes to. Needs
      integrations.manage. See docs/integrations.md.

  windkeel schedule list [--json]
  windkeel schedule create --name <n> --repo <repository-id> --cron "<cron>" [--tz <zone>]
                        --title <t> --description <text|@file> [--risk <level>]
                        [--spend-cap <usd>] [--wall-clock <seconds>]
  windkeel schedule update <schedule-id> [--name ..] [--repo ..] [--cron ..] [--tz ..]
                        [--title ..] [--description ..] [--risk ..]
                        [--spend-cap <usd>|none] [--wall-clock <seconds>|none]
                        [--enable|--disable]
  windkeel schedule delete <schedule-id>
  windkeel schedule fire <schedule-id>
  windkeel schedule preview "<cron>" [--tz <zone>]
      Cron-triggered tasks: each slot becomes one task, created by the organization's
      system actor. Checked every five minutes. Writes need schedules.manage. See
      docs/schedules.md.

  windkeel batch list [--json]
  windkeel batch create --repos <id,id,...> --title <t> --description <text|@file>
                     [--criteria-file <file>] [--max-concurrency <n>] [--cap <usd>]
                     [--child-cap <usd>] [--stop-on-failure-ratio <0-1>]
  windkeel batch create --items <items.json> --repo <repository-id> --title <t> --description ..
  windkeel batch status <batch-id> [--watch]
  windkeel batch pause|resume|cancel <batch-id>
      One change fanned out into many runs, each verified on its own; a batch never
      merges or approves anything. Capped as a whole (--cap, default $100). Writes need
      batches.manage. See docs/batches.md.

  windkeel models credentials list [--all] [--json]
  windkeel models credentials add --provider <openai|anthropic|openrouter|openai-compatible>
                               --label <label> [--base-url <https-url>] [--vendor <vendor>]
                               [--from-env <VAR>]          (otherwise the key is read on stdin)
  windkeel models credentials rotate <credential-id> [--from-env <VAR>]
  windkeel models credentials revoke <credential-id>
  windkeel models credentials validate <credential-id>
      The organization's own model keys (ADR-0026). Sealed on arrival; nothing ever shows
      one again but its last four characters. Never pass a key as a flag or argument.
      Listing needs models.read; the rest needs models.manage.`;

export const AUTH_USAGE = `windkeel login [--url <api-url>] [--scope read|execute|approve|admin | --permissions <a,b>]
              [--admin] [--no-browser] [--org <id>]
      Sign this machine in through the browser (a device code, like "gh auth login").
      You approve it in the console, and a token scoped to --scope (default execute)
      is saved to ~/.config/windkeel/credentials.json, readable by you only. Prints who
      you are and what the token can do.

  windkeel login --with-token [--url <api-url>] < token.txt
      Store an existing token, read from stdin and checked with the server first.
      Never a flag: a flag's value lands in shell history.

  windkeel logout
      Revoke the stored token on the server, then delete the credentials file. If the
      revoke fails the file is still deleted, and you are told the token is still live.

  windkeel token create --name <name> [--scope read|execute|approve|admin | --permissions <a,b>]
                     [--org <id>] [--expires-in-days <n>] [--json]
  windkeel token list [--json]
  windkeel token revoke <token-id>
      Mint, list and revoke API tokens. The secret is printed once. Give an agent its
      own narrow token rather than yours:  windkeel token create --name claude-code --scope read

  windkeel org list [--json]
  windkeel org use <id|name>
      The organizations you belong to, and which one commands act on. Also --org <id>
      on any command, or WINDKEEL_ORG.

  windkeel member list [--json]
  windkeel member invitations [--json]
  windkeel member invite <github-login> [--role admin|member|viewer]
  windkeel member role <principal-id> <admin|member|viewer>
  windkeel member remove <principal-id>
      Who is in the organization, and bringing someone in. An invitee accepts by
      signing in to the console with that GitHub account.

  windkeel service-principal list [--json]
  windkeel service-principal create --name <name> [--role admin|member|viewer] [--json]
  windkeel service-principal delete <principal-id>
  windkeel service-principal token list <principal-id> [--json]
  windkeel service-principal token create <principal-id> --name <name>
                 [--scope <preset> | --permissions <a,b>] [--expires-at <iso-time>] [--json]
  windkeel service-principal token revoke <principal-id> <token-id>
      Non-human identities for automations, one organization each. Their tokens keep
      working when the person who made them leaves. Needs tokens.manage. Deleting
      one revokes every token it holds.

  permissions
      runs.read, runs.write, runs.approve, secrets.manage, repositories.manage,
      members.manage, tokens.manage, integrations.manage, schedules.manage, models.read,
      models.manage, runs.takeover, runs.merge, batches.manage.
      Presets: read = runs.read; execute = + runs.write; approve = + runs.approve;
      admin = all of them. A token can never do more than your role in the
      organization allows.`;

export interface RemoteIo {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: RemoteIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return String(value);
  return String(value);
}

function usd(value: unknown): string {
  return value === null || value === undefined ? "—" : `$${Number(value).toFixed(4)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export async function runsCommand(
  api: WindkeelApi,
  io: RemoteIo,
  options: { status?: string; repo?: string; task?: string; limit?: string; json?: boolean },
): Promise<number> {
  const page = await api.listRuns({
    ...(options.status ? { status: options.status } : {}),
    ...(options.repo ? { repository: options.repo } : {}),
    ...(options.task ? { task: options.task } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
  if (options.json) {
    io.out(JSON.stringify(page, null, 2));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("No runs match.");
    return 0;
  }
  io.out(`${pad("RUN", 10)}${pad("STATE", 26)}${pad("VERDICT", 9)}${pad("COST", 10)}TASK`);
  for (const run of page.items) {
    io.out(
      pad(run.id.slice(0, 8), 10) +
        pad(run.status, 26) +
        pad(show(run.finalVerdict), 9) +
        pad(usd(run.cost), 10) +
        run.taskTitle,
    );
  }
  if (page.hasNextPage) io.out(`\nMore: --cursor ${page.endCursor}`);
  return 0;
}

export async function queueCommand(api: WindkeelApi, io: RemoteIo, json?: boolean): Promise<number> {
  const page = await api.queue();
  if (json) {
    io.out(JSON.stringify(page, null, 2));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("Nothing waiting.");
    return 0;
  }
  io.out(`${pad("RUN", 10)}${pad("WAITING IN", 26)}TASK`);
  for (const run of page.items) io.out(pad(run.id.slice(0, 8), 10) + pad(run.status, 26) + run.taskTitle);
  return 0;
}

export async function showCommand(api: WindkeelApi, io: RemoteIo, runId: string, json?: boolean): Promise<number> {
  const { report, rendered, receipt } = await api.getRun(runId);
  if (json) {
    io.out(JSON.stringify(receipt ? { ...(report as object), receipt } : report, null, 2));
    return 0;
  }
  io.out(rendered);
  if (receipt && (receipt.compute.length > 0 || receipt.ai.length > 0)) {
    const { formatReceipt } = await import("./billing.js");
    io.out("");
    io.out(formatReceipt(receipt));
  }
  return 0;
}

export async function attemptsCommand(api: WindkeelApi, io: RemoteIo, runId: string, json?: boolean): Promise<number> {
  const page = await api.attempts(runId);
  if (json) {
    io.out(JSON.stringify(page, null, 2));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("No attempts yet.");
    return 0;
  }
  for (const item of page.items) {
    const kind = String(item["kind"]);
    if (kind === "agent_run") {
      io.out(`agent       ${show(item["role"])} on ${show(item["model"])}`);
    } else if (kind === "verification") {
      io.out(`verify      ${show(item["candidateSha"]).slice(0, 8)} → ${show(item["verdict"])}`);
    } else {
      io.out(`repair #${show(item["attemptNumber"])}   from verification ${show(item["verificationRunId"]).slice(0, 8)}`);
    }
  }
  return 0;
}

export async function watchCommand(
  api: WindkeelApi,
  io: RemoteIo,
  runId: string,
  options: { json?: boolean; pollMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const follow = api.follow(runId, {
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  let result: { runStatus: string; cursor: string } | undefined;
  for (;;) {
    const next = await follow.next();
    if (next.done) {
      result = next.value;
      break;
    }
    io.out(options.json ? JSON.stringify(next.value) : formatEvent(next.value));
  }

  if (!options.json) io.out(`\nRun ended: ${result.runStatus}`);
  return result.runStatus === "COMPLETED" ? 0 : 1;
}

export function formatEvent(event: RunEvent): string {
  const at = new Date(event.at).toISOString().slice(11, 19);
  if (event.kind === "transition") {
    const from = event.from ? `${event.from} → ` : "";
    const why = event.reason ? `  (${event.reason})` : "";
    return `${at}  ${from}${event.to}${why}`;
  }
  if (event.kind === "agent") return `${at}  ${formatAgentStep(event.event)}`;
  return `${at}  cost ${usd(event.usd)}  ${show(event.costKind)}/${show(event.stageType)}`;
}

function formatAgentStep(event: RunEvent["event"]): string {
  if (!event) return "agent";
  const text = (key: string) => {
    const value = event[key];
    return typeof value === "string" ? value.split("\n")[0]!.slice(0, 160) : "";
  };
  const exit = (key: string) => (typeof event[key] === "number" ? `exit ${event[key]}` : "killed");
  switch (event.type) {
    case "command_started":
      return `run   ${text("command")}`;
    case "command_finished":
      return `ran   ${text("command")}  (${exit("exitCode")})`;
    case "test_started":
      return `test  ${text("command")}`;
    case "test_finished":
      return `test  ${text("command")}  ${event["passed"] ? "passed" : "failed"} (${exit("exitCode")})`;
    case "file_changed":
      return `edit  ${text("path")}${typeof event["kind"] === "string" ? ` (${event["kind"]})` : ""}`;
    case "thinking":
      return `think ${text("text")}`;
    case "message":
      return `say   ${text("text")}`;
    case "failed":
      return `agent failed: ${text("error")}`;
    default:
      return `agent ${event.type}`;
  }
}

export async function approveCommand(api: WindkeelApi, io: RemoteIo, runId: string): Promise<number> {
  return reportAck(io, () => api.approve(runId), "Approved");
}

export async function cancelCommand(
  api: WindkeelApi,
  io: RemoteIo,
  runId: string,
  reason?: string,
): Promise<number> {
  return reportAck(io, () => api.cancel(runId, reason), "Cancelling");
}

export async function sayCommand(
  api: WindkeelApi,
  io: RemoteIo,
  runId: string,
  message: string,
): Promise<number> {
  const code = await reportAck(io, () => api.guide(runId, message), "Queued for");
  if (code === 0) {
    io.out(
      "The maker gets this at its next turn boundary — the rest of the turn it is in, plus up to " +
        "one poll interval. `windkeel messages` says when it was delivered.",
    );
  }
  return code;
}

export async function messagesCommand(
  api: WindkeelApi,
  io: RemoteIo,
  runId: string,
  json?: boolean,
): Promise<number> {
  const page = await api.messages(runId);
  if (json) {
    io.out(JSON.stringify(page, null, 2));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("Nothing has been said to this run.");
    return 0;
  }
  for (const entry of page.items) {
    io.out(`${entry.at}  ${entry.actor}  [${entry.state}]`);
    for (const line of entry.message.split("\n")) io.out(`  ${line}`);
    if (entry.state === "undeliverable") io.out(`  → not delivered: ${entry.undeliverableReason}`);
    if (entry.state === "superseded") {
      io.out("  → the run ended before the maker reached a turn boundary; it was never delivered");
    }
    io.out("");
  }
  return 0;
}

export async function secretsCommand(
  api: WindkeelApi,
  io: RemoteIo,
  repositoryId: string,
  json?: boolean,
): Promise<number> {
  const page = await api.listSecrets(repositoryId);
  if (json) {
    io.out(JSON.stringify(page, null, 2));
    return 0;
  }
  if (page.items.length === 0) {
    io.out("This repository has no secrets.");
    return 0;
  }
  io.out(`${pad("KEY", 28)}${pad("SET BY", 18)}${pad("UPDATED", 26)}NOTE`);
  for (const secret of page.items) {
    io.out(
      pad(secret.key, 28) + pad(secret.setBy, 18) + pad(secret.updatedAt, 26) + show(secret.note),
    );
  }
  io.out("\nValues are not listed and cannot be: they are sealed to a key only the worker holds.");
  return 0;
}

export async function setSecretCommand(
  api: WindkeelApi,
  io: RemoteIo,
  repositoryId: string,
  key: string,
  value: string,
  note?: string,
): Promise<number> {
  try {
    const stored = await api.setSecret(repositoryId, {
      key,
      value,
      ...(note ? { note } : {}),
    });
    io.out(`Set ${stored.key} on repository ${repositoryId}`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      printRefusal(io, err);
      return 1;
    }
    throw err;
  }
}

export async function deleteSecretCommand(
  api: WindkeelApi,
  io: RemoteIo,
  repositoryId: string,
  key: string,
): Promise<number> {
  try {
    await api.deleteSecret(repositoryId, key);
    io.out(`Deleted ${key} from repository ${repositoryId}`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      printRefusal(io, err);
      return 1;
    }
    throw err;
  }
}

export interface SubmitSpec {
  repo: string;
  title: string;
  description: string;
  riskLevel?: string;
  spendCapUsd?: number;
  wallClockCapSeconds?: number;
  models?: { maker?: string; checker?: string };
  playbook?: string;
}

export async function submitCommand(api: WindkeelApi, io: RemoteIo, spec: SubmitSpec): Promise<number> {
  const repositoryId = await findRepositoryId(api, spec.repo);
  if (!repositoryId) {
    io.err(
      `refused: no repository ${spec.repo} is granted to this organization. ` +
        "Repositories arrive when the GitHub App is installed on them; the API does not invent one.",
    );
    return 1;
  }
  const { repo: _repo, ...rest } = spec;
  return reportAck(io, () => api.submitTask({ ...rest, repositoryId }), "Submitted");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findRepositoryId(api: WindkeelApi, repo: string): Promise<string | null> {
  if (UUID.test(repo)) return repo;
  const wanted = repo.toLowerCase();
  let cursor: string | undefined;
  do {
    const page = await api.listRepositories(cursor);
    const match = page.items.find((candidate) => candidate.fullName.toLowerCase() === wanted);
    if (match) return match.id;
    cursor = page.hasNextPage ? (page.endCursor ?? undefined) : undefined;
  } while (cursor);
  return null;
}

export async function whoamiCommand(
  api: WindkeelApi,
  io: RemoteIo,
  options: { json?: boolean } = {},
): Promise<number> {
  const [identity, health] = await Promise.all([api.self(), api.health()]);
  if (options.json) {
    io.out(JSON.stringify(identity, null, 2));
    return health.ok ? 0 : 1;
  }
  for (const line of describeSelf(identity, api)) io.out(line);
  io.out(`database  ${health.database}`);
  return health.ok ? 0 : 1;
}

const ORG_SOURCE = { flag: "--org", env: "WINDKEEL_ORG", file: "windkeel org use" } as const;

export function describeSelf(
  self: SelfView,
  context: Pick<WindkeelApi, "baseUrl" | "org" | "source"> | null = null,
): string[] {
  const lines: string[] = [];
  const p = self.principal;
  if (p) {
    const login = p.githubLogin ? ` (@${p.githubLogin})` : "";
    lines.push(`principal ${show(p.displayName ?? p.githubLogin ?? p.id)}${login}  [${p.kind}]`);
  }
  if (self.account) lines.push(`account   ${self.account.name}  (${self.account.id})`);
  if (self.token) {
    const scope = self.token.organizationId ? `org ${self.token.organizationId} only` : "every org you are in";
    lines.push(`token     ${self.token.name}  ${self.token.permissions.join(", ")}  (${scope})`);
  } else if (self.via === "bootstrap") {
    lines.push("token     WINDKEEL_API_TOKEN  (the deployment's break-glass operator token; prefer a personal one)");
  } else if (self.token === null) {
    lines.push("token     —  (a session, not an API token)");
  }
  if (self.organizations) {
    if (self.organizations.length === 0) lines.push("orgs      —  (not a member of any organization)");
    for (const [index, org] of self.organizations.entries()) {
      const effective = effectiveIn(self, org);
      const current = context?.org && (context.org === org.id || context.org === org.name) ? "  *" : "";
      lines.push(
        `${index === 0 ? "orgs      " : "          "}${org.name}  (${org.id})  ${org.role}  ` +
          `can: ${effective.length ? effective.join(", ") : "nothing"}${current}`,
      );
    }
  }
  if (context?.org) {
    const from = context.source?.orgSource ? `  (from ${ORG_SOURCE[context.source.orgSource]})` : "";
    lines.push(`org       ${context.org}${from}`);
  }
  if (context?.source) {
    lines.push(
      context.source.tokenSource === "env"
        ? "source    WINDKEEL_API_TOKEN, from the environment"
        : context.source.tokenSource === "file"
          ? `source    ${context.source.credentialsPath}`
          : "source    passed in by the caller",
    );
  }
  if (context?.baseUrl) lines.push(`api       ${context.baseUrl}`);
  lines.push(`subject   ${self.subject}`);
  if (!self.principal) lines.push(`scopes    ${self.scopes.join(", ")}`);
  return lines;
}

function effectiveIn(self: SelfView, org: { id: string; permissions: string[] }): string[] {
  const token = self.token;
  if (!token) return org.permissions;
  if (token.organizationId && token.organizationId !== org.id) return [];
  return org.permissions.filter((permission) => token.permissions.includes(permission));
}

async function reportAck(
  io: RemoteIo,
  act: () => Promise<CommandAck>,
  verb: string,
): Promise<number> {
  try {
    const ack = await act();
    const id = ack.engineeringRunId ?? ack.taskId ?? "";
    io.out(`${verb}${id ? ` ${id}` : ""}${ack.cursor ? `  (follow from cursor ${ack.cursor})` : ""}`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      printRefusal(io, err);
      return 1;
    }
    throw err;
  }
}

export function printRefusal(io: RemoteIo, err: ApiError): void {
  io.err(`refused: ${err.message}  [${err.code}]`);
  const advice = adviceFor(err);
  if (advice) io.err(`  ${advice}`);
}

export function summariseRun(run: RunSummary): string {
  return `${run.id.slice(0, 8)}  ${run.status}  ${usd(run.cost)}  ${run.taskTitle}`;
}
