export const COMMAND_STAGES = new Set(["checks", "security", "browser"]);

export const TRANSCRIPT_BINDING_VERSION = "0.2.0";

export type ExitTrailer = number | "none";

const TRAILER = /^--- orqon exit:(\d+|none) ---$/;

export function exitTrailer(code: ExitTrailer): string {
  return `--- orqon exit:${code} ---\n`;
}

export function withExitTrailer(transcript: string, code: ExitTrailer): string {
  const body = transcript.endsWith("\n") || transcript === "" ? transcript : `${transcript}\n`;
  return `${body}${exitTrailer(code)}`;
}

export function parseExitTrailer(transcript: string): ExitTrailer | null {
  const last = transcript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const match = last ? TRAILER.exec(last) : null;
  if (!match?.[1]) return null;
  return match[1] === "none" ? "none" : Number(match[1]);
}

export function statusIncoherence(trailer: ExitTrailer, status: string): string | null {
  if (trailer === "none") {
    return status === "passed"
      ? `transcript records no exit code at all, but the status is "passed"`
      : null;
  }
  if (trailer === 0 && status === "failed") {
    return `transcript records exit 0 but the status is "failed"`;
  }
  if (trailer !== 0 && status !== "failed") {
    return `transcript records exit ${trailer} but the status is "${status}"`;
  }
  return null;
}

export function atLeastVersion(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [actual, floor] = [parse(version), parse(minimum)];
  for (let i = 0; i < Math.max(actual.length, floor.length); i++) {
    const [a, b] = [actual[i] ?? 0, floor[i] ?? 0];
    if (a !== b) return a > b;
  }
  return true;
}
