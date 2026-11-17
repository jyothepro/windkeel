import { ApiError, type WindkeelApi, type PlaybookView } from "../client/api.js";
import { printRefusal, type RemoteIo } from "./remote.js";

export const PLAYBOOK_USAGE =
  "usage: windkeel playbook list [--json]\n" +
  "       windkeel playbook show <slug-or-id> [--json]\n" +
  "         Choose one for a task with: windkeel submit … --playbook <slug>\n";

export type PlaybookAction = { kind: "list"; json?: boolean } | { kind: "show"; slug: string; json?: boolean };

export async function playbookCommand(api: WindkeelApi, io: RemoteIo, action: PlaybookAction): Promise<number> {
  try {
    if (action.kind === "list") {
      const { items } = await api.listPlaybooks();
      if (action.json) {
        io.out(JSON.stringify(items, null, 2));
        return 0;
      }
      for (const line of playbookTable(items)) io.out(line);
      return 0;
    }
    const { playbook } = await api.getPlaybook(action.slug);
    if (action.json) {
      io.out(JSON.stringify(playbook, null, 2));
      return 0;
    }
    for (const line of describePlaybook(playbook)) io.out(line);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      printRefusal(io, err);
      return 1;
    }
    throw err;
  }
}

export function playbookTable(items: readonly PlaybookView[]): string[] {
  if (items.length === 0) return ["(no playbooks)"];
  const rows = [["SLUG", "KIND", "VERSION", "BUILTIN", "NAME"], ...items.map((p) => [p.slug, p.kind, `v${p.version}`, p.builtin ? "yes" : "no", p.name])];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  "));
}

export function describePlaybook(p: PlaybookView): string[] {
  const lines = [
    `${p.slug} v${p.version}${p.builtin ? " (built-in)" : ""} — ${p.name}  [${p.kind}]`,
    ...(p.defaultRiskLevel ? [`default risk  ${p.defaultRiskLevel}`] : []),
    ...(p.modelPresetId ? [`model preset  ${p.modelPresetId}`] : []),
    "",
    "Maker instructions",
    ...p.makerInstructions.split("\n").map((line) => `  ${line}`),
    "",
    "Added criteria (on top of the task's own)",
    ...(p.addedCriteria.length ? p.addedCriteria.map((c) => `  [${c.id}] ${c.text}`) : ["  (none)"]),
    "",
    "Verifier will also",
    ...(p.verifierAdds.length ? p.verifierAdds.map((line) => `  ${line}`) : ["  (nothing beyond the repository's own policy)"]),
  ];
  return lines;
}
