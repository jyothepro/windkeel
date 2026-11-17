export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  requires?: string;
}

const RUN_ID = {
  runId: { type: "string", description: "The engineering run's uuid." },
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "windkeel_whoami",
    title: "Check the Windkeel connection",
    description:
      "Who the configured token belongs to, which organizations it reaches with what role, the token's own name and permissions, the permissions it effectively has (effectivePermissions), and whether the control plane's database is reachable. Call this first when anything else fails, to tell a configuration problem from an empty factory — and before asking a person to do something this token cannot.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "windkeel_list_runs",
    title: "List runs",
    description:
      "Runs on the factory, newest first. Filter by status (a run state such as IMPLEMENTING, VERIFYING, WAITING_FOR_APPROVAL, COMPLETED), by repository uuid, or by task uuid.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "A run state to filter by." },
        repository: { type: "string", description: "Repository uuid." },
        task: { type: "string", description: "Task uuid." },
        limit: { type: "integer", description: "Page size, up to 200." },
      },
    },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_get_run",
    title: "Read a run report",
    description:
      "The full report for one run: state, verdict, cost against its cap, stop reason, pull request, and residual risk. This is the same report the CLI prints and the GitHub comment shows.",
    inputSchema: { type: "object", properties: { ...RUN_ID }, required: ["runId"] },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_run_events",
    title: "Read what a run has done",
    description:
      "State changes and cost events for a run, in order. Pass the previous call's endCursor as 'after' to get only what is new — polling from 0 each time replays the whole run. Returns the run's current status alongside the events, so one call answers both 'what happened' and 'where is it now'.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_ID,
        after: { type: "string", description: "Cursor from a previous call. Omit to start at the beginning." },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_run_attempts",
    title: "Read a run's repair history",
    description:
      "Every attempt at a run, in order: the candidate a worker produced, the verdict that judged it, and the repair that followed. Use this to find out *why* a run failed rather than only that it did.",
    inputSchema: { type: "object", properties: { ...RUN_ID }, required: ["runId"] },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_run_cost",
    title: "Read a run's cost",
    description:
      "What a run has spent, broken out per stage and per kind (model or sandbox), with its spend cap. A total alone hides which stage is expensive.",
    inputSchema: { type: "object", properties: { ...RUN_ID }, required: ["runId"] },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_queue",
    title: "See what is waiting",
    description:
      "Runs that have been accepted and have not started working, oldest first. A run sitting in WAITING_FOR_APPROVAL is waiting for a person, not for a machine.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_submit_task",
    title: "Submit work to Windkeel",
    description:
      "Create a task and start a run. Acceptance criteria are extracted from the description verbatim — write them as a markdown checklist ('- [ ] ...') or under an 'Acceptance criteria' heading. A description with no criteria takes a slower path: a model writes them and a person must approve before anything is spent. Criteria you write yourself are both cheaper and more accurate than criteria generated from your prose.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryId: { type: "string", description: "Repository uuid, from windkeel_list_repositories." },
        title: { type: "string", description: "One line naming the change." },
        description: {
          type: "string",
          description: "What to do, including the acceptance criteria as a checklist.",
        },
        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
        playbook: {
          type: "string",
          description:
            "Optional playbook slug, e.g. dependency-upgrade or test-writing: adds instructions for the maker and checks and criteria to verification. It never replaces the task's own criteria.",
        },
      },
      required: ["repositoryId", "title", "description"],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    requires: "runs.write",
  },
  {
    name: "windkeel_approve",
    title: "Approve a run's criteria",
    description:
      "Release a run parked at WAITING_FOR_APPROVAL. Only do this when a person has asked you to: the pause exists so a human agrees to the criteria before money is spent on them, and approving on their behalf defeats the gate.",
    inputSchema: { type: "object", properties: { ...RUN_ID }, required: ["runId"] },
    annotations: { destructiveHint: true },
    requires: "runs.approve",
  },
  {
    name: "windkeel_cancel",
    title: "Cancel a run",
    description:
      "Stop a run. The sandbox winds down rather than being orphaned. A cancelled run cannot be resumed — starting again is a fresh run.",
    inputSchema: {
      type: "object",
      properties: { ...RUN_ID, reason: { type: "string", description: "Why, for the audit trail." } },
      required: ["runId"],
    },
    annotations: { destructiveHint: true },
    requires: "runs.write",
  },
  {
    name: "windkeel_guide",
    title: "Send guidance to a working run",
    description:
      "Say something to the worker while it is working — for example, point it at an existing helper instead of a new one. IMPORTANT: guidance may change *how* the work is done, never *what* the run is for. The run is judged against acceptance criteria that were fixed when it started; a message that changes the goal leaves the verifier checking the old criteria against different work. To change the goal, cancel and submit a new task. Refused unless the run is IMPLEMENTING, REPAIRING or VERIFYING. This QUEUES the guidance: it becomes a new turn of the agent's session, and a turn cannot begin while one is running, so it arrives at the next turn boundary rather than immediately. Do not send the same guidance again because the next output looks unchanged — call windkeel_messages to see whether it was delivered.",
    inputSchema: {
      type: "object",
      properties: { ...RUN_ID, message: { type: "string", description: "The guidance." } },
      required: ["runId", "message"],
    },
    annotations: { destructiveHint: true },
    requires: "runs.write",
  },
  {
    name: "windkeel_messages",
    title: "Read what was said to a run",
    description:
      "Everything a person or an agent has said to a run, and what became of each message: delivered (the agent got it as a turn), queued (waiting for a turn boundary), undeliverable (with the reason), or superseded (the run ended before a turn boundary came, so it was never delivered). This is the only way to find out whether windkeel_guide actually reached the worker.",
    inputSchema: { type: "object", properties: { ...RUN_ID }, required: ["runId"] },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
  {
    name: "windkeel_list_secrets",
    title: "List a repository's secret names",
    description:
      "The names of the credentials a repository's dependency install is given, with who set each one and when. Values are never returned and there is no way to ask for one. Useful when an install failed on a private registry: it says whether a credential exists at all. There is deliberately no tool for setting a secret — use `windkeel secret set` in a terminal, so the value never enters a model's context.",
    inputSchema: {
      type: "object",
      properties: { repositoryId: { type: "string", description: "The repository's uuid." } },
      required: ["repositoryId"],
    },
    annotations: { readOnlyHint: true },
    requires: "secrets.manage",
  },
  {
    name: "windkeel_list_repositories",
    title: "List repositories Windkeel can work on",
    description: "Repositories the factory can act against, with each one's count of open runs.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    requires: "runs.read",
  },
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export function toolsFor(permissions: readonly string[] | null): readonly ToolDefinition[] {
  if (permissions === null) return TOOLS;
  return TOOLS.filter((tool) => tool.requires === undefined || permissions.includes(tool.requires));
}
