

import { CODEX_API_KEY_PLACEHOLDER, makerModelKeyRule } from "../../sandbox/credential-broker.js";
import type { SandboxHandle } from "../../sandbox/provider.js";
import {
  WorkerRouteChangedError,
  WorkerSessionGoneError,
  type WorkerModelRoute,
  type WorkerAdapter,
  type WorkerAdapterCapabilities,
  type WorkerEvent,
  type WorkerMessage,
  type WorkerResult,
  type WorkerSession,
  type WorkerPoll,
  type WorkerSessionRef,
  type WorkerStartInput,
  type WorkerUsage,
} from "../adapter.js";
import { readWatermarkedLines } from "../watermark.js";
import { CODEX_DESCRIPTOR, harnessProviders, PINNED_CODEX_VERSION } from "../descriptor.js";
import {
  cancelProcessGroup,
  conservativeUsage,
  launchDetached,
  readBaseRevision,
  sleep,
  stderrTail,
  sumUsage,
  turnPaths,
  verifyHarnessVersion,
  type Egress,
} from "../detached.js";
import { crossCheckSelfReport, extractDiff } from "../diff.js";
import { CodexEventNormalizer, normalizeCodexLine, type CodexDiagnostic } from "./events.js";
import {
  DEFAULT_MODEL_API_DOMAIN,
  type RouteIdentity,
  codexModelArgs,
  describeIdentity,
  identityOf,
  routeIdentityOf,
  sameIdentity,
} from "./model-route.js";

export {
  DEFAULT_MODEL_API_DOMAIN,
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_ENV_KEY,
  codexModelArgs,
} from "./model-route.js";

export { PINNED_CODEX_VERSION };

export function parseCodexVersion(stdout: string): string {
  return /(\d+\.\d+\.\d+(?:[-\w.]*)?)/.exec(stdout.trim())?.[1] ?? stdout.trim();
}

export interface CodexAdapterOptions {

  pinnedVersion?: string;

  allowVersionDrift?: boolean;

  binary?: string;

  modelApiDomain?: string;

  makerModelKeyEnvVar?: string;

  pollIntervalMs?: number;

  onDiagnostic?: (diagnostic: CodexDiagnostic) => void;

  maxDiffBytes?: number;
}

export interface CodexSessionState {
  readonly id: string;

  readonly session: WorkerSession;
  readonly handle: SandboxHandle;
  readonly workdir: string | undefined;
  readonly scratchDir: string;

  stdoutPath: string;
  stderrPath: string;
  donePath: string;
  pidPath: string;

  turn: number;
  readonly codexVersion: string;
  readonly pinnedVersion: string;

  readonly baseRevision: string | undefined;

  watermark: number;
  normalizer: CodexEventNormalizer;
  cancelled: boolean;

  drained: boolean;

  sawCompleted: boolean;

  completedDelivered?: boolean;
  failureError: string | undefined;
  usage: WorkerUsage | undefined;

  readonly usageByTurn: WorkerUsage[];
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
    throw new Error("CodexWorkerAdapter.send: the message carried neither `text` nor `repairPacket`.");
  }
  return parts.join("\n\n");
}

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly name = "codex";

  readonly capabilities: WorkerAdapterCapabilities = {
    resumableSessions: true,

    reattachableSessions: true,

    reattachedSessionsAcceptNewTurns: true,

    pollable: true,
    reportsUsage: true,
    reportsFileChanges: true,
    providers: harnessProviders(CODEX_DESCRIPTOR.id),
  };

  get version(): string {
    return this.options.pinnedVersion;
  }

  private readonly options: Required<Pick<CodexAdapterOptions, "pinnedVersion" | "binary" | "modelApiDomain" | "pollIntervalMs" | "allowVersionDrift">> &
    CodexAdapterOptions;
  private readonly sessions = new Map<string, CodexSessionState>();
  private sequence = 0;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      ...options,
      pinnedVersion: options.pinnedVersion ?? PINNED_CODEX_VERSION,
      binary: options.binary ?? "codex",
      modelApiDomain: options.modelApiDomain ?? DEFAULT_MODEL_API_DOMAIN,
      pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
      allowVersionDrift: options.allowVersionDrift ?? false,
    };
  }

  describe(session: WorkerSession): CodexSessionState {
    return this.state(session);
  }

  reference(session: WorkerSession): WorkerSessionRef {
    const state = this.state(session);
    return {
      id: state.id,
      workerType: this.name,
      ...(state.session.workerSessionId !== undefined
        ? { workerSessionId: state.session.workerSessionId }
        : {}),
      adapterState: {
        scratchDir: state.scratchDir,
        turn: state.turn,
        watermark: state.watermark,
        codexVersion: state.codexVersion,
        workdir: state.workdir ?? null,
        baseRevision: state.baseRevision ?? null,
        turnRunning: state.turnRunning,

        startedOn: state.startedOn
          ? {
              model: state.startedOn.model,
              provider: state.startedOn.provider,
              ...(state.startedOn.baseUrl !== undefined ? { baseUrl: state.startedOn.baseUrl } : {}),
            }
          : null,
      },
    };
  }

  async attach(ref: WorkerSessionRef, sandbox: SandboxHandle): Promise<WorkerSession> {
    if (ref.workerType !== this.name) {
      throw new WorkerSessionGoneError(
        ref.id,
        `it was started by "${ref.workerType}" and this is the "${this.name}" adapter`,
      );
    }
    const raw = ref.adapterState;
    const scratchDir = typeof raw.scratchDir === "string" ? raw.scratchDir : undefined;
    const turn = typeof raw.turn === "number" ? raw.turn : undefined;
    if (!scratchDir || !turn) {
      throw new WorkerSessionGoneError(ref.id, "the reference carries no scratch directory or turn");
    }
    if (!(await sandbox.exists(scratchDir))) {
      throw new WorkerSessionGoneError(
        ref.id,
        `the scratch directory ${scratchDir} is gone from the sandbox — the sandbox was ` +
          "replaced or reset, and the turn's output is not recoverable",
      );
    }

    const session: WorkerSession = {
      id: ref.id,
      ...(ref.workerSessionId !== undefined ? { workerSessionId: ref.workerSessionId } : {}),
    };
    const state: CodexSessionState = {
      id: ref.id,
      session,
      handle: sandbox,
      workdir: typeof raw.workdir === "string" ? raw.workdir : undefined,
      scratchDir,
      ...turnPaths(scratchDir, turn),
      turn,
      codexVersion: typeof raw.codexVersion === "string" ? raw.codexVersion : "unknown",
      pinnedVersion: this.options.pinnedVersion,
      baseRevision: typeof raw.baseRevision === "string" ? raw.baseRevision : undefined,
      watermark: typeof raw.watermark === "number" ? raw.watermark : 0,
      normalizer: new CodexEventNormalizer(this.diagnosticOptions()),
      cancelled: false,
      drained: false,
      sawCompleted: false,
      failureError: undefined,
      usage: undefined,
      usageByTurn: [],
      finalMessage: undefined,
      turnRunning: raw.turnRunning !== false,
      reportedFiles: new Set<string>(),
      route: undefined,
      startedOn: routeIdentityOf(raw.startedOn),
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
    const codexVersion = await this.verifyBinary(handle, egress, expected);

    const scratchDir = await handle.mkdtemp("windkeel-codex-");
    const baseRevision = await readBaseRevision(handle, egress, input.workdir);
    const id = `codex-${++this.sequence}`;
    const session: WorkerSession = { id };
    const state: CodexSessionState = {
      id,
      session,
      handle,
      workdir: input.workdir,
      scratchDir,
      ...turnPaths(scratchDir, 1),
      turn: 1,
      codexVersion,
      pinnedVersion: expected,
      baseRevision,
      watermark: 0,
      normalizer: new CodexEventNormalizer(this.diagnosticOptions()),
      cancelled: false,
      drained: false,
      sawCompleted: false,
      failureError: undefined,
      usage: undefined,
      usageByTurn: [],
      finalMessage: undefined,
      turnRunning: true,
      reportedFiles: new Set<string>(),
      route,
      startedOn: route ? identityOf(route) : undefined,
    };
    this.sessions.set(id, state);

    await this.launch(state, this.codexArgv(state, input.prompt), egress);
    return session;
  }

  async send(session: WorkerSession, message: WorkerMessage): Promise<void> {
    const state = this.state(session);
    if (state.turnRunning) {
      throw new Error(
        `CodexWorkerAdapter.send: turn ${state.turn} of session ${state.id} is still running. ` +
          "Two concurrent codex processes mutating one workspace is a corrupted attempt with no " +
          "clean recovery — cancel the turn or consume its events to completion first.",
      );
    }
    if (!state.drained && !state.cancelled) await this.drain(session);

    const workerSessionId = state.session.workerSessionId;
    if (!workerSessionId) {
      throw new Error(
        `CodexWorkerAdapter.send: session ${state.id} has no codex session id (no \`thread.started\` ` +
          "was seen on the previous turn's stream), so there is nothing to resume. Refusing to " +
          "fall back to `codex exec resume --last`, which would resolve to whatever ran most " +
          "recently in this sandbox.",
      );
    }

    const turn = state.turn + 1;
    state.turn = turn;
    const paths = turnPaths(state.scratchDir, turn);
    state.stdoutPath = paths.stdoutPath;
    state.stderrPath = paths.stderrPath;
    state.donePath = paths.donePath;
    state.pidPath = paths.pidPath;
    state.watermark = 0;
    state.normalizer = new CodexEventNormalizer(this.diagnosticOptions());
    state.drained = false;
    state.sawCompleted = false;
    state.completedDelivered = false;
    state.failureError = undefined;
    state.usage = undefined;
    state.turnRunning = true;

    await this.launch(
      state,
      this.codexArgv(state, renderMessage(message), workerSessionId),
      this.egressOf(state.route),
    );
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

    const events = this.deliverable(state, await this.readNewEvents(state));
    if (!(await this.processFinished(state))) return { events, turnEnded: false };

    const tail = this.deliverable(state, await this.readNewEvents(state, true));
    state.drained = true;
    state.turnRunning = false;
    return { events: [...events, ...tail], turnEnded: true };
  }

  private deliverable(state: CodexSessionState, events: WorkerEvent[]): WorkerEvent[] {
    const delivered: WorkerEvent[] = [];
    for (const event of events) {
      this.observe(state, event);
      if (event.type === "completed") {
        if (state.completedDelivered) continue;
        state.completedDelivered = true;
      }
      delivered.push(event);
    }
    return delivered;
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

    const usageless = !state.cancelled && state.failureError === undefined && state.sawCompleted && !state.usage;
    const outcome: WorkerResult["outcome"] = state.cancelled
      ? "cancelled"
      : state.failureError !== undefined || usageless
        ? "failed"
        : state.sawCompleted
          ? "completed"
          : "failed";
    const error = state.cancelled
      ? "session cancelled by the orchestrator; the workspace holds whatever the agent had done by then"
      : outcome === "failed"
        ? (state.failureError ??
          (usageless
            ? "codex reported `turn.completed` without token usage, so the turn's spend cannot be " +
              "recorded; it is failed rather than counted as free (ADR-0027 §3)"
            : "the codex stream ended without a `turn.completed` — the process died or its output was cut off" +
              (await stderrTail(state.handle, state.stderrPath))))
        : undefined;

    return {
      outcome,
      diff,
      ...(error !== undefined ? { error } : {}),
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.usageByTurn.length > 1 ? { cumulativeUsage: sumUsage(state.usageByTurn) } : {}),
      ...(state.finalMessage !== undefined ? { finalMessage: state.finalMessage } : {}),
      ...(divergence ? { selfReportDivergence: divergence } : {}),
    };
  }

  private egressOf(route: WorkerModelRoute | undefined): Egress {
    if (route) return { domain: route.modelApiDomain, rules: route.credentialRules };
    return {
      domain: this.options.modelApiDomain,
      rules: this.options.makerModelKeyEnvVar
        ? [makerModelKeyRule(this.options.modelApiDomain, this.options.makerModelKeyEnvVar)]
        : [],
    };
  }

  private diagnosticOptions(): { onDiagnostic?: (d: CodexDiagnostic) => void } {
    return this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {};
  }

  private verifyBinary(handle: SandboxHandle, egress: Egress, expected: string): Promise<string> {
    return verifyHarnessVersion(handle, egress, {
      binary: this.options.binary,
      expected,
      allowDrift: this.options.allowVersionDrift,
      adapterName: "CodexWorkerAdapter",
      toolName: "codex",
      pinName: "PINNED_CODEX_VERSION",
      adr: "ADR-0006",
      onDrift: (detail) => this.options.onDiagnostic?.({ kind: "unknown_schema_version", detail }),
    });
  }

  private codexArgv(state: CodexSessionState, prompt: string, resumeSessionId?: string): string[] {
    const identity = state.startedOn ?? (state.route ? identityOf(state.route) : undefined);
    return [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--ignore-user-config",
      ...(identity ? codexModelArgs(identity) : []),
      ...(resumeSessionId ? ["resume", resumeSessionId] : []),
      "--",
      prompt,
    ];
  }

  private async launch(
    state: CodexSessionState,
    argv: string[],
    egress: Egress,
  ): Promise<void> {
    await launchDetached(state.handle, egress, {
      scratchDir: state.scratchDir,
      paths: state,
      workdir: state.workdir,
      command: [this.options.binary, ...argv],

      env: {
        ...Object.fromEntries(CODEX_DESCRIPTOR.keyEnvVars.map((name) => [name, CODEX_API_KEY_PLACEHOLDER])),

        CODEX_HOME: `${state.scratchDir}/codex-home`,
      },
      mkdirs: [`${state.scratchDir}/codex-home`],
      label: "Codex",
      adapterName: "CodexWorkerAdapter",
    });
  }

  private async readNewEvents(state: CodexSessionState, flushPartial = false): Promise<WorkerEvent[]> {
    if (!(await state.handle.exists(state.stdoutPath))) return [];
    const contents = await state.handle.readFile(state.stdoutPath);
    const read = readWatermarkedLines(contents, state.watermark, { flushPartial });
    state.watermark = read.watermark;
    if (read.regressed) {
      this.options.onDiagnostic?.({
        kind: "output_regressed",
        detail:
          `the agent log for session ${state.id} came back shorter than the watermark ` +
          `(${contents.length} < ${state.watermark}); nothing was consumed and the next poll ` +
          "will re-read it. One occurrence is a lying live tail; repeated ones are not.",
      });
    }

    return read.lines.flatMap((line) =>
      normalizeCodexLine(state.normalizer, line, this.options.onDiagnostic),
    );
  }

  private async processFinished(state: CodexSessionState): Promise<boolean> {
    return state.handle.exists(state.donePath);
  }

  private observe(state: CodexSessionState, event: WorkerEvent): void {
    if (event.type === "started") {

      if (event.sessionId) state.session.workerSessionId = event.sessionId;
    } else if (event.type === "completed") {

      if (state.sawCompleted) {
        if (event.usage) {

          if (state.usage) {
            state.usage = conservativeUsage(state.usage, event.usage);
            state.usageByTurn[state.usageByTurn.length - 1] = state.usage;
          } else {
            state.usage = event.usage;
            state.usageByTurn.push(event.usage);
          }
        }
        return;
      }
      state.sawCompleted = true;

      if (state.failureError !== undefined) {
        this.options.onDiagnostic?.({
          kind: "recovered_error",
          detail: state.failureError,
        });
        state.failureError = undefined;
      }
      if (event.usage) {
        state.usage = event.usage;
        state.usageByTurn.push(event.usage);
      }
    } else if (event.type === "failed") {
      state.failureError = event.error;
    } else if (event.type === "message") {
      state.finalMessage = event.text;
    } else if (event.type === "file_changed") {
      state.reportedFiles.add(event.path);
    }
  }

  private state(session: WorkerSession): CodexSessionState {
    const state = this.sessions.get(session.id);
    if (!state) {
      throw new Error(`CodexWorkerAdapter: unknown session ${session.id}`);
    }
    return state;
  }
}
