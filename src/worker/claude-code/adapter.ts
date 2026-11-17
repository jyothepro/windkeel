import { CODEX_API_KEY_PLACEHOLDER, makerModelKeyRule } from "../../sandbox/credential-broker.js";
import type { SandboxHandle } from "../../sandbox/provider.js";
import {
  WorkerRouteChangedError,
  WorkerSessionGoneError,
  type WorkerAdapter,
  type WorkerAdapterCapabilities,
  type WorkerEvent,
  type WorkerMessage,
  type WorkerModelRoute,
  type WorkerPoll,
  type WorkerResult,
  type WorkerSession,
  type WorkerSessionRef,
  type WorkerStartInput,
  type WorkerUsage,
} from "../adapter.js";
import { CLAUDE_CODE_DESCRIPTOR, harnessProviders, PINNED_CLAUDE_CODE_VERSION } from "../descriptor.js";
import {
  cancelProcessGroup,
  launchDetached,
  readBaseRevision,
  sleep,
  stderrTail,
  sumUsage,
  turnPaths,
  verifyHarnessVersion,
  type Egress,
  type TurnPaths,
} from "../detached.js";
import { crossCheckSelfReport, extractDiff } from "../diff.js";
import { readWatermarkedLines } from "../watermark.js";
import { ClaudeCodeEventNormalizer, normalizeClaudeCodeLine, type ClaudeCodeDiagnostic } from "./events.js";

export { PINNED_CLAUDE_CODE_VERSION };

export const CLAUDE_CODE_DISALLOWED_TOOLS = "WebFetch,WebSearch,mcp__*";

export function claudeCodeEnv(configDir: string, route: Pick<WorkerModelRoute, "baseUrl"> | undefined): Record<string, string> {
  const baseUrl = route?.baseUrl?.replace(/\/+$/, "").replace(/\/v1$/, "");
  return {
    ...Object.fromEntries(CLAUDE_CODE_DESCRIPTOR.keyEnvVars.map((name) => [name, CODEX_API_KEY_PLACEHOLDER])),
    ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_BUG_COMMAND: "1",
    IS_SANDBOX: "1",
  };
}

function claudeCodeArgv(model: string | undefined, settingsPath: string, resumeSessionId?: string): string[] {
  return [
    "-p",
    "--bare",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(model ? ["--model", model] : []),
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--disallowedTools",
    CLAUDE_CODE_DISALLOWED_TOOLS,
    "--settings",
    settingsPath,
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
  ];
}

const CLAUDE_CODE_SETTINGS = {
  skipWebFetchPreflight: true,
  permissions: { deny: ["WebFetch", "WebSearch"] },
};

type RouteIdentity = Pick<WorkerModelRoute, "model" | "provider" | "baseUrl">;

function identityOf(route: RouteIdentity): RouteIdentity {
  return { model: route.model, provider: route.provider, ...(route.baseUrl !== undefined ? { baseUrl: route.baseUrl } : {}) };
}

function routeIdentityOf(raw: unknown): RouteIdentity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value["model"] !== "string" || typeof value["provider"] !== "string") return undefined;
  return identityOf({
    model: value["model"],
    provider: value["provider"],
    ...(typeof value["baseUrl"] === "string" ? { baseUrl: value["baseUrl"] } : {}),
  });
}

const sameIdentity = (a: RouteIdentity, b: RouteIdentity) =>
  a.model === b.model && a.provider === b.provider && (a.baseUrl ?? null) === (b.baseUrl ?? null);
const describeIdentity = (identity: RouteIdentity) =>
  `${identity.provider}/${identity.model}${identity.baseUrl ? ` at ${identity.baseUrl}` : ""}`;

export interface ClaudeCodeAdapterOptions {
  pinnedVersion?: string;
  allowVersionDrift?: boolean;
  binary?: string;
  modelApiDomain?: string;
  makerModelKeyEnvVar?: string;
  pollIntervalMs?: number;
  onDiagnostic?: (diagnostic: ClaudeCodeDiagnostic) => void;
  maxDiffBytes?: number;
}

export interface ClaudeCodeSessionState extends TurnPaths {
  readonly id: string;
  readonly session: WorkerSession;
  readonly handle: SandboxHandle;
  readonly workdir: string | undefined;
  readonly scratchDir: string;
  turn: number;
  readonly harnessVersion: string;
  readonly pinnedVersion: string;
  readonly baseRevision: string | undefined;
  watermark: number;
  normalizer: ClaudeCodeEventNormalizer;
  cancelled: boolean;
  drained: boolean;
  usageByTurn: WorkerUsage[];
  finalMessage: string | undefined;
  turnRunning: boolean;
  readonly reportedFiles: Set<string>;
  route: WorkerModelRoute | undefined;
  startedOn: RouteIdentity | undefined;
}

const POLL_INTERVAL_MS = 150;

function renderMessage(message: WorkerMessage): string {
  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  if (message.repairPacket) {
    parts.push(
      "Verification failed. Repair packet (JSON) — the constraints in `repair_constraints` are binding:",
      JSON.stringify(message.repairPacket, null, 2),
    );
  }
  if (parts.length === 0) {
    throw new Error("ClaudeCodeWorkerAdapter.send: the message carried neither `text` nor `repairPacket`.");
  }
  return parts.join("\n\n");
}

export class ClaudeCodeWorkerAdapter implements WorkerAdapter {
  readonly name = CLAUDE_CODE_DESCRIPTOR.id;
  readonly capabilities: WorkerAdapterCapabilities = {
    resumableSessions: true,
    reattachableSessions: true,
    reattachedSessionsAcceptNewTurns: true,
    pollable: true,
    reportsUsage: true,
    reportsFileChanges: true,
    providers: harnessProviders(CLAUDE_CODE_DESCRIPTOR.id),
  };

  private readonly options: Required<Pick<ClaudeCodeAdapterOptions, "pinnedVersion" | "binary" | "modelApiDomain" | "pollIntervalMs" | "allowVersionDrift">> &
    ClaudeCodeAdapterOptions;
  private readonly sessions = new Map<string, ClaudeCodeSessionState>();
  private sequence = 0;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.options = {
      ...options,
      pinnedVersion: options.pinnedVersion ?? PINNED_CLAUDE_CODE_VERSION,
      binary: options.binary ?? CLAUDE_CODE_DESCRIPTOR.binary,
      modelApiDomain: options.modelApiDomain ?? "api.anthropic.com",
      pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
      allowVersionDrift: options.allowVersionDrift ?? false,
    };
  }

  get version(): string {
    return this.options.pinnedVersion;
  }

  describe(session: WorkerSession): ClaudeCodeSessionState {
    return this.state(session);
  }

  reference(session: WorkerSession): WorkerSessionRef {
    const state = this.state(session);
    return {
      id: state.id,
      workerType: this.name,
      ...(state.session.workerSessionId !== undefined ? { workerSessionId: state.session.workerSessionId } : {}),
      adapterState: {
        scratchDir: state.scratchDir,
        turn: state.turn,
        watermark: state.watermark,
        harnessVersion: state.harnessVersion,
        workdir: state.workdir ?? null,
        baseRevision: state.baseRevision ?? null,
        turnRunning: state.turnRunning,
        startedOn: state.startedOn ? identityOf(state.startedOn) : null,
      },
    };
  }

  async attach(ref: WorkerSessionRef, sandbox: SandboxHandle): Promise<WorkerSession> {
    if (ref.workerType !== this.name) {
      throw new WorkerSessionGoneError(ref.id, `it was started by "${ref.workerType}" and this is the "${this.name}" adapter`);
    }
    const raw = ref.adapterState;
    const scratchDir = typeof raw["scratchDir"] === "string" ? raw["scratchDir"] : undefined;
    const turn = typeof raw["turn"] === "number" ? raw["turn"] : undefined;
    if (!scratchDir || !turn) throw new WorkerSessionGoneError(ref.id, "the reference carries no scratch directory or turn");
    if (!(await sandbox.exists(scratchDir))) {
      throw new WorkerSessionGoneError(
        ref.id,
        `the scratch directory ${scratchDir} is gone from the sandbox — the sandbox was replaced or ` +
          "reset, and the turn's output and Claude Code's session are not recoverable",
      );
    }
    const session: WorkerSession = { id: ref.id, ...(ref.workerSessionId !== undefined ? { workerSessionId: ref.workerSessionId } : {}) };
    const state: ClaudeCodeSessionState = {
      id: ref.id,
      session,
      handle: sandbox,
      workdir: typeof raw["workdir"] === "string" ? raw["workdir"] : undefined,
      scratchDir,
      ...turnPaths(scratchDir, turn),
      turn,
      harnessVersion: typeof raw["harnessVersion"] === "string" ? raw["harnessVersion"] : "unknown",
      pinnedVersion: this.options.pinnedVersion,
      baseRevision: typeof raw["baseRevision"] === "string" ? raw["baseRevision"] : undefined,
      watermark: typeof raw["watermark"] === "number" ? raw["watermark"] : 0,
      normalizer: this.normalizer(),
      cancelled: false,
      drained: false,
      usageByTurn: [],
      finalMessage: undefined,
      turnRunning: raw["turnRunning"] !== false,
      reportedFiles: new Set<string>(),
      route: undefined,
      startedOn: routeIdentityOf(raw["startedOn"]),
    };
    this.sessions.set(ref.id, state);
    return session;
  }

  useRoute(session: WorkerSession, route: WorkerModelRoute): void {
    const state = this.state(session);
    if (state.startedOn && !sameIdentity(state.startedOn, route)) {
      throw new WorkerRouteChangedError(state.id, describeIdentity(state.startedOn), describeIdentity(route));
    }
    state.route = route;
    state.startedOn ??= identityOf(route);
  }

  async start(input: WorkerStartInput): Promise<WorkerSession> {
    const handle = input.sandbox;
    const route = input.route;
    const egress = this.egressOf(route);
    const expected = input.harnessVersion ?? this.options.pinnedVersion;
    const harnessVersion = await verifyHarnessVersion(handle, egress, {
      binary: this.options.binary,
      expected,
      allowDrift: this.options.allowVersionDrift,
      adapterName: "ClaudeCodeWorkerAdapter",
      toolName: "claude",
      pinName: "PINNED_CLAUDE_CODE_VERSION",
      adr: "ADR-0027 §7",
      onDrift: (detail) => this.options.onDiagnostic?.({ kind: "unknown_schema_version", detail }),
    });

    const scratchDir = await handle.mkdtemp("windkeel-claude-code-");
    await handle.writeFile(`${scratchDir}/settings.json`, `${JSON.stringify(CLAUDE_CODE_SETTINGS, null, 2)}\n`);
    const baseRevision = await readBaseRevision(handle, egress, input.workdir);
    const id = `claude-code-${++this.sequence}`;
    const session: WorkerSession = { id };
    const state: ClaudeCodeSessionState = {
      id,
      session,
      handle,
      workdir: input.workdir,
      scratchDir,
      ...turnPaths(scratchDir, 1),
      turn: 1,
      harnessVersion,
      pinnedVersion: expected,
      baseRevision,
      watermark: 0,
      normalizer: this.normalizer(),
      cancelled: false,
      drained: false,
      usageByTurn: [],
      finalMessage: undefined,
      turnRunning: true,
      reportedFiles: new Set<string>(),
      route,
      startedOn: route ? identityOf(route) : undefined,
    };
    this.sessions.set(id, state);
    await this.launch(state, input.prompt, egress);
    return session;
  }

  async send(session: WorkerSession, message: WorkerMessage): Promise<void> {
    const state = this.state(session);
    if (state.turnRunning) {
      throw new Error(
        `ClaudeCodeWorkerAdapter.send: turn ${state.turn} of session ${state.id} is still running. ` +
          "Two concurrent harness processes mutating one workspace is a corrupted attempt — cancel " +
          "the turn or consume its events to completion first.",
      );
    }
    if (!state.drained && !state.cancelled) await this.drain(session);
    const resumeId = state.session.workerSessionId;
    if (!resumeId) {
      throw new Error(
        `ClaudeCodeWorkerAdapter.send: session ${state.id} has no Claude Code session id (no ` +
          "`system/init` was seen on the previous turn's stream), so there is nothing to resume. " +
          "Refusing to fall back to `--continue`, which would resolve to whatever ran most recently.",
      );
    }
    const turn = state.turn + 1;
    state.turn = turn;
    Object.assign(state, turnPaths(state.scratchDir, turn));
    state.watermark = 0;
    state.normalizer = this.normalizer();
    state.drained = false;
    state.cancelled = false;
    state.turnRunning = true;
    await this.launch(state, renderMessage(message), this.egressOf(state.route), resumeId);
  }

  private async drain(session: WorkerSession): Promise<void> {
    for await (const _event of this.events(session)) {
    }
  }

  async *events(session: WorkerSession): AsyncIterable<WorkerEvent> {
    for (;;) {
      const { events, turnEnded } = await this.poll(session);
      for (const event of events) yield event;
      if (turnEnded) return;
      if (events.length === 0) await sleep(this.options.pollIntervalMs);
    }
  }

  async poll(session: WorkerSession): Promise<WorkerPoll> {
    const state = this.state(session);
    if (state.cancelled) return { events: [], turnEnded: true };
    const events = await this.readNewEvents(state);
    for (const event of events) this.observe(state, event);
    if (state.normalizer.authRefused) {
      await cancelProcessGroup(state.handle, this.egressOf(state.route), state.pidPath).catch(() => {});
      state.drained = true;
      state.turnRunning = false;
      return { events, turnEnded: true };
    }
    if (!(await state.handle.exists(state.donePath))) return { events, turnEnded: false };
    const tail = await this.readNewEvents(state, true);
    for (const event of tail) this.observe(state, event);
    state.drained = true;
    state.turnRunning = false;
    return { events: [...events, ...tail], turnEnded: true };
  }

  async cancel(session: WorkerSession): Promise<void> {
    const state = this.state(session);
    state.cancelled = true;
    state.turnRunning = false;
    await cancelProcessGroup(state.handle, this.egressOf(state.route), state.pidPath);
  }

  async result(session: WorkerSession): Promise<WorkerResult> {
    const state = this.state(session);
    if (!state.drained && !state.cancelled) await this.drain(session);
    const egress = this.egressOf(state.route);
    const diff = await extractDiff(state, {
      modelApiDomain: egress.domain,
      credentialRules: egress.rules,
      ...(this.options.maxDiffBytes !== undefined ? { maxDiffBytes: this.options.maxDiffBytes } : {}),
    });
    const divergence = crossCheckSelfReport(state.reportedFiles, diff.filesChanged);
    const { verdict, usage, reportedCostUsd } = state.normalizer;
    if (usage) state.usageByTurn[state.turn - 1] = usage;

    let outcome: WorkerResult["outcome"];
    let error: string | undefined;
    if (state.cancelled) {
      outcome = "cancelled";
      error = "session cancelled by the orchestrator; the workspace holds whatever the agent had done by then";
    } else if (verdict?.kind === "failed") {
      outcome = "failed";
      error = verdict.error;
    } else if (verdict?.kind === "completed" && !usage) {
      outcome = "failed";
      error =
        "Claude Code reported success without token usage, so the turn's spend cannot be recorded; " +
        "it is failed rather than counted as free (ADR-0027 §3)";
    } else if (verdict?.kind === "completed") {
      outcome = "completed";
    } else {
      outcome = "failed";
      error =
        "the Claude Code stream ended without a `result` — the process died or its output was cut off" +
        (await stderrTail(state.handle, state.stderrPath));
    }
    const turns = state.usageByTurn.filter((turn): turn is WorkerUsage => turn !== undefined);
    return {
      outcome,
      diff,
      ...(error !== undefined ? { error } : {}),
      ...(usage ? { usage } : {}),
      ...(turns.length > 1 ? { cumulativeUsage: sumUsage(turns) } : {}),
      ...(state.finalMessage !== undefined ? { finalMessage: state.finalMessage } : {}),
      ...(divergence ? { selfReportDivergence: divergence } : {}),
      ...(reportedCostUsd !== undefined ? { harnessReportedCostUsd: reportedCostUsd } : {}),
    };
  }

  private egressOf(route: WorkerModelRoute | undefined): Egress {
    if (route) return { domain: route.modelApiDomain, rules: route.credentialRules };
    return {
      domain: this.options.modelApiDomain,
      rules: this.options.makerModelKeyEnvVar
        ? [makerModelKeyRule(this.options.modelApiDomain, this.options.makerModelKeyEnvVar, "x-api-key")]
        : [],
    };
  }

  private normalizer(): ClaudeCodeEventNormalizer {
    return new ClaudeCodeEventNormalizer(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {});
  }

  private async launch(state: ClaudeCodeSessionState, prompt: string, egress: Egress, resumeSessionId?: string): Promise<void> {
    const promptPath = `${state.scratchDir}/turn-${state.turn}.prompt.txt`;
    await state.handle.writeFile(promptPath, prompt);
    const identity = state.startedOn ?? (state.route ? identityOf(state.route) : undefined);
    await launchDetached(state.handle, egress, {
      scratchDir: state.scratchDir,
      paths: state,
      workdir: state.workdir,
      command: [this.options.binary, ...claudeCodeArgv(identity?.model, `${state.scratchDir}/settings.json`, resumeSessionId)],
      env: claudeCodeEnv(`${state.scratchDir}/claude-config`, identity),
      mkdirs: [`${state.scratchDir}/claude-config`],
      stdinPath: promptPath,
      label: "Claude Code",
      adapterName: "ClaudeCodeWorkerAdapter",
    });
  }

  private async readNewEvents(state: ClaudeCodeSessionState, flushPartial = false): Promise<WorkerEvent[]> {
    if (!(await state.handle.exists(state.stdoutPath))) return [];
    const contents = await state.handle.readFile(state.stdoutPath);
    const read = readWatermarkedLines(contents, state.watermark, { flushPartial });
    if (read.regressed) {
      this.options.onDiagnostic?.({
        kind: "output_regressed",
        detail: `the agent log for session ${state.id} came back shorter than the watermark; the next poll re-reads it`,
      });
    }
    state.watermark = read.watermark;
    return read.lines.flatMap((line) => normalizeClaudeCodeLine(state.normalizer, line, this.options.onDiagnostic));
  }

  private observe(state: ClaudeCodeSessionState, event: WorkerEvent): void {
    if (event.type === "started" && event.sessionId) state.session.workerSessionId = event.sessionId;
    else if (event.type === "message") state.finalMessage = event.text;
    else if (event.type === "file_changed") state.reportedFiles.add(event.path);
    else if (event.type === "completed" && event.usage) state.usageByTurn[state.turn - 1] = event.usage;
  }

  private state(session: WorkerSession): ClaudeCodeSessionState {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`ClaudeCodeWorkerAdapter: unknown session ${session.id}`);
    return state;
  }
}
