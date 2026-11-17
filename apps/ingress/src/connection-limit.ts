export function isConnectionLimit(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "53300" ||
    /EMAXCONNSESSION|max clients reached|too many clients|remaining connection slots/i.test(err.message) ||
    /timeout exceeded when trying to connect/i.test(err.message)
  );
}
