export type IntakeLog = (message: string, fields?: Record<string, unknown>) => void;

export function redactSecrets(message: string): string {
  return message
    .replace(/\b(bearer|basic|token)(\s+)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, "[redacted]")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/\b(?:lin|orq)_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[redacted]");
}

export function describeError(error: unknown): { errorName: string; errorCode?: string; error: string } {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "string" ? { errorCode: code } : {}),
    error: redactSecrets(error instanceof Error ? error.message : String(error)),
  };
}

export const defaultLog: IntakeLog = (message, fields) => {
  try {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      redacted[key] = typeof value === "string" ? redactSecrets(value) : value;
    }
    process.stdout.write(
      `${JSON.stringify({ at: new Date().toISOString(), src: "windkeel", message: redactSecrets(message), ...redacted })}\n`,
    );
  } catch {
    try {
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), src: "windkeel", message: redactSecrets(message) })}\n`);
    } catch {
    }
  }
};
