export const HARNESS_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

export interface HarnessInfo {
  id: string;
  label: string;
  default: boolean;
}

const LABELS: Readonly<Record<string, string>> = {
  codex: "OpenAI's Codex CLI",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

export function enabledHarnesses(env: Readonly<Record<string, string | undefined>> = process.env): HarnessInfo[] {
  const listed = (env["WINDKEEL_MAKER_HARNESSES"] ?? "codex")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => HARNESS_SHAPE.test(id));
  const ids = [...new Set(listed.length > 0 ? listed : ["codex"])];
  const wanted = env["WINDKEEL_DEFAULT_MAKER_HARNESS"]?.trim();
  const fallback = wanted && ids.includes(wanted) ? wanted : ids[0]!;
  return ids.map((id) => ({ id, label: LABELS[id] ?? id, default: id === fallback }));
}
