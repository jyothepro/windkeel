import type { Pool, PoolClient } from "pg";
import { TERMINAL_STATES } from "./criteria-gate.js";
import { GITHUB_ISSUE_SOURCE, type IntakeGitHub, issueReference } from "./issue-intake.js";
import { type EngineeringRun, getEngineeringTaskBySource, listEngineeringRuns } from "./repositories.js";
import type { RunSignal } from "./workflow/provider.js";

type Queryable = Pool | PoolClient;

export type IssueCommand = "approve" | "cancel";

const PREFILTER_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export function mayHoldWriteAccess(authorAssociation: string | undefined): boolean {
  return PREFILTER_ASSOCIATIONS.has((authorAssociation ?? "").toUpperCase());
}

const WRITE_ROLES: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

function grantsWriteAccess(answer: { permission: string; roleName: string | null }): boolean {
  return (
    (answer.roleName !== null && WRITE_ROLES.has(answer.roleName.toLowerCase())) ||
    WRITE_ROLES.has(answer.permission.toLowerCase())
  );
}

export interface CommenterPermissionLookup {
  getCollaboratorPermission(
    repository: { owner: string; name: string },
    username: string,
  ): Promise<{ permission: string; roleName: string | null }>;
}

export type CommenterAuthorization =
  | { ok: true; permission: string }
  | { ok: false; reason: string };

export async function authorizeCommenter(
  github: CommenterPermissionLookup | undefined,
  input: {
    repository: { owner: string; name: string };
    actor: string;
    authorAssociation: string | undefined;
  },
): Promise<CommenterAuthorization> {
  const { actor } = input;
  if (!mayHoldWriteAccess(input.authorAssociation)) {
    return {
      ok: false,
      reason: `${actor} (${input.authorAssociation ?? "no association"}) cannot hold write access`,
    };
  }
  return askForWriteAccess(github, input.repository, actor);
}

export async function authorizeLabeler(
  github: CommenterPermissionLookup | undefined,
  input: { repository: { owner: string; name: string }; actor: string },
): Promise<CommenterAuthorization> {
  return askForWriteAccess(github, input.repository, input.actor);
}

async function askForWriteAccess(
  github: CommenterPermissionLookup | undefined,
  repository: { owner: string; name: string },
  actor: string,
): Promise<CommenterAuthorization> {
  let answer: { permission: string; roleName: string | null };
  try {
    if (!github) throw new Error("no permission lookup configured");
    answer = await github.getCollaboratorPermission(repository, actor);
  } catch (error) {
    return { ok: false, reason: `could not confirm ${actor} has write access (${describeLookupError(error)})` };
  }
  if (!grantsWriteAccess(answer)) {
    return {
      ok: false,
      reason: `${actor} has ${answer.roleName ?? answer.permission} access to the repository, not write`,
    };
  }
  const role = answer.roleName?.toLowerCase();
  return { ok: true, permission: role && WRITE_ROLES.has(role) ? role : answer.permission.toLowerCase() };
}

function describeLookupError(error: unknown): string {
  const name = error instanceof Error ? error.name : "error";
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${name}, status ${status}` : name;
}

export type CommandAuthority = { via: "github_permission"; permission: string } | { via: "api" };

export interface RunControl {
  signal(engineeringRunId: string, signal: RunSignal): Promise<unknown>;
  cancel(engineeringRunId: string, reason: string): Promise<unknown>;
}

export interface CommandDeps {
  db: Queryable;
  github: IntakeGitHub;
  control: RunControl;
}

export type CommandOutcome =
  | { kind: "signalled"; command: IssueCommand; taskId: string; engineeringRunId: string }
  | { kind: "cancelled"; taskId: string; engineeringRunId: string; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "ignored"; reason: string };

export interface CommandResult {
  outcome: CommandOutcome;
  afterCommit: () => Promise<void>;
}

const NOTHING = async (): Promise<void> => {};

export interface CommandInput {
  repository: { id: string; owner: string; name: string };
  issueNumber: number;
  actor: string;
}

async function liveRunFor(
  db: Queryable,
  repository: CommandInput["repository"],
  issueNumber: number,
): Promise<
  { taskId: string; run: EngineeringRun } | { reason: string; expired: EngineeringRun | null }
> {
  const task = await getEngineeringTaskBySource(
    db,
    repository.id,
    GITHUB_ISSUE_SOURCE,
    issueReference(repository, issueNumber),
  );
  if (!task) {
    return { reason: `no Windkeel task for ${issueReference(repository, issueNumber)}`, expired: null };
  }
  const runs = await listEngineeringRuns(db, task.id);
  const live = runs.find((run) => !TERMINAL_STATES.has(run.status));
  if (!live) {
    const expired = runs.find((run) => run.stopReason === "approval_expired") ?? null;
    return { reason: `every run of task ${task.id} is already terminal`, expired };
  }
  return { taskId: task.id, run: live };
}

export async function applyIssueCommand(
  deps: CommandDeps,
  input: CommandInput & { command: IssueCommand; authority: CommandAuthority },
): Promise<CommandResult> {
  const { authority } = input;
  const authorised =
    authority?.via === "api" ||
    (authority?.via === "github_permission" && WRITE_ROLES.has(String(authority.permission).toLowerCase()));
  if (!authorised) {
    return {
      outcome: {
        kind: "refused",
        reason: `${input.actor} lacks write access`,
      },
      afterCommit: NOTHING,
    };
  }

  const found = await liveRunFor(deps.db, input.repository, input.issueNumber);
  if ("reason" in found) {
    const expired = input.command === "approve" && found.expired !== null;
    return {
      outcome: { kind: "ignored", reason: found.reason },
      afterCommit: expired
        ? async () => {
            await deps.github.createIssueComment(
              input.repository,
              input.issueNumber,
              "**Too late to approve** — this run was cancelled because the acceptance criteria " +
                "above went unapproved until the approval gate closed. Nothing was provisioned " +
                "and nothing was spent waiting.\n\n" +
                "Re-add the `windkeel` label to start a fresh run, and approve that one.",
            );
          }
        : NOTHING,
    };
  }

  if (input.command === "cancel") {
    return cancelResult(deps, input, found, `/windkeel cancel from ${input.actor}`);
  }

  const { taskId, run } = found;
  return {
    outcome: { kind: "signalled", command: "approve", taskId, engineeringRunId: run.id },
    afterCommit: async () => {
      await deps.control.signal(run.id, { type: "approval_granted", actor: input.actor });
      await deps.github.createIssueComment(
        input.repository,
        input.issueNumber,
        `**Approved by @${input.actor}.** Windkeel will verify the change against exactly the ` +
          `criteria above, and nothing else.`,
      );
    },
  };
}

export async function cancelRunForIssue(
  deps: CommandDeps,
  input: CommandInput & { reason?: string },
): Promise<CommandResult> {
  const found = await liveRunFor(deps.db, input.repository, input.issueNumber);
  if ("reason" in found) return { outcome: { kind: "ignored", reason: found.reason }, afterCommit: NOTHING };
  return cancelResult(
    deps,
    input,
    found,
    input.reason ?? `the windkeel label was removed by ${input.actor}`,
  );
}

function cancelResult(
  deps: CommandDeps,
  input: CommandInput,
  found: { taskId: string; run: EngineeringRun },
  reason: string,
): CommandResult {
  return {
    outcome: { kind: "cancelled", taskId: found.taskId, engineeringRunId: found.run.id, reason },
    afterCommit: async () => {
      await deps.control.cancel(found.run.id, reason);
      await deps.github.createIssueComment(
        input.repository,
        input.issueNumber,
        `**Run \`${found.run.id}\` is stopping.** ${capitalize(reason)}. ` +
          `Any sandbox it holds is torn down; re-apply the \`windkeel\` label to start a fresh run.`,
      );
    },
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
