import type { ExecResult } from "./environment.js";

export const EXIT_COMMAND_NOT_FOUND = 127;

export const EXIT_NOT_EXECUTABLE = 126;

const COULD_NOT_RUN: ReadonlyMap<number, string> = new Map([
  [EXIT_COMMAND_NOT_FOUND, "command not found"],
  [EXIT_NOT_EXECUTABLE, "found but not executable"],
]);

const SIGNALS: ReadonlyMap<number, string> = new Map([
  [2, "SIGINT"],
  [6, "SIGABRT"],
  [9, "SIGKILL"],
  [11, "SIGSEGV"],
  [15, "SIGTERM"],
]);

export function signalForExit(status: number | null): string | null {
  if (status === null || status <= 128) return null;
  return SIGNALS.get(status - 128) ?? null;
}

export function isCouldNotRunExit(status: number | null): boolean {
  return status !== null && COULD_NOT_RUN.has(status);
}

export function couldNotRunReason(status: number | null): string | null {
  return status === null ? null : (COULD_NOT_RUN.get(status) ?? null);
}

export function describeExit(result: Pick<ExecResult, "status" | "signal" | "error">): string {
  if (result.error) return `could not be started: ${result.error}`;
  if (result.status === null) {
    return result.signal ? `terminated by ${result.signal}` : "did not complete";
  }
  const signal = signalForExit(result.status);
  if (signal) return `exit ${result.status} (${signal} — killed, not a verdict on the code)`;
  const couldNotRun = couldNotRunReason(result.status);
  if (couldNotRun) return `exit ${result.status} (${couldNotRun})`;
  return `exit ${result.status}`;
}
