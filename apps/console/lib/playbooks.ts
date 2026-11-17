import type { ActionResult } from "./action-result.ts";
import { orgPath, type Send } from "./automations.ts";
import { ApiError } from "./http.ts";
import { refusalText } from "./refusals.ts";

export const PLAYBOOK_KINDS = ["code-review", "migration", "incident-fix", "test-writing", "dependency-upgrade", "custom"] as const;
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];

export interface PlaybookVerifier {
  extraChecks?: Array<{ name: string; command: string }>;
  checksRequired?: true;
  requireStages?: Array<"browser" | "security">;
  extraFlows?: Array<{ name: string; command: string; artifacts?: string }>;
  extraTools?: Array<{ package: string; reason?: string }>;
}

export interface Playbook {
  id: string | null;
  slug: string;
  name: string;
  kind: PlaybookKind;
  version: number;
  builtin: boolean;
  makerInstructions: string;
  criteria: Array<{ text: string }>;
  verifier: PlaybookVerifier;
  defaultRiskLevel: "low" | "medium" | "high" | null;
  modelPresetId: string | null;
  verifierAdds: string[];
  addedCriteria: Array<{ id: string; text: string }>;
}

export interface PlaybookSnapshot {
  id: string | null;
  slug: string;
  kind: PlaybookKind;
  version: number;
  builtin: boolean;
  makerInstructions: string;
  criteria: Array<{ text: string }>;
  verifier: PlaybookVerifier;
}

export type PlaybookInput = Partial<{
  from: string;
  slug: string;
  name: string;
  kind: PlaybookKind;
  makerInstructions: string;
  criteria: Array<{ text: string }>;
  verifier: PlaybookVerifier;
  defaultRiskLevel: "low" | "medium" | "high" | null;
}>;

const id = encodeURIComponent;

export function playbooksClient(send: Send) {
  return {
    async list(orgId: string): Promise<Playbook[]> {
      return (await send<{ items: Playbook[] }>("GET", orgPath(orgId, "/playbooks"))).items;
    },
    async create(orgId: string, input: PlaybookInput): Promise<Playbook> {
      return (await send<{ playbook: Playbook }>("POST", orgPath(orgId, "/playbooks"), input)).playbook;
    },
    async update(orgId: string, playbookId: string, input: PlaybookInput): Promise<Playbook> {
      return (await send<{ playbook: Playbook }>("PATCH", orgPath(orgId, `/playbooks/${id(playbookId)}`), input)).playbook;
    },
    async archive(orgId: string, playbookId: string): Promise<void> {
      await send("DELETE", orgPath(orgId, `/playbooks/${id(playbookId)}`));
    },
  };
}

export type PlaybooksApi = ReturnType<typeof playbooksClient>;

export function canReadPlaybooks(held: readonly string[]): boolean {
  return held.includes("playbooks.read") || held.includes("playbooks.manage");
}
export function canManagePlaybooks(held: readonly string[]): boolean {
  return held.includes("playbooks.manage");
}

export interface PlaybookOption {
  value: string;
  label: string;
  criteria: string[];
  verifier: string[];
}

export function pickerOptions(items: readonly Playbook[]): PlaybookOption[] {
  return [
    { value: "", label: "None", criteria: [], verifier: [] },
    ...items.map((p) => ({
      value: p.slug,
      label: `${p.name}${p.builtin ? "" : " (yours)"}`,
      criteria: (p.addedCriteria.length ? p.addedCriteria : p.criteria.map((c, i) => ({ id: `PB${i + 1}`, text: c.text }))).map(
        (c) => `${c.id} — ${c.text}`,
      ),
      verifier: p.verifierAdds.length ? p.verifierAdds : verifierLines(p.verifier),
    })),
  ];
}

export function verifierLines(verifier: PlaybookVerifier): string[] {
  const lines: string[] = [];
  for (const check of verifier.extraChecks ?? []) lines.push(`run check playbook.${check.name} (\`${check.command}\`)`);
  if (verifier.checksRequired) lines.push("fail when the repository declares no checks");
  for (const stage of verifier.requireStages ?? []) lines.push(`require the ${stage} stage to run (a skip blocks)`);
  for (const flow of verifier.extraFlows ?? []) lines.push(`run browser flow playbook.${flow.name}`);
  for (const tool of verifier.extraTools ?? []) lines.push(`install ${tool.package}`);
  return lines;
}

export function verifierSentence(lines: readonly string[]): string | null {
  return lines.length ? `Verifier will also: ${lines.join("; ")}.` : null;
}

export function playbookBadge(snapshot: Pick<PlaybookSnapshot, "slug" | "version"> | null | undefined): string | null {
  return snapshot ? `Playbook: ${snapshot.slug} v${snapshot.version}` : null;
}

const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
const CHECK_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function readPlaybookForm(form: FormData): { input: PlaybookInput } | { problem: string } {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const slug = text("slug");
  const name = text("name");
  const kind = text("kind") || "custom";
  const makerInstructions = text("makerInstructions");
  if (!SLUG.test(slug)) return { problem: "The slug is lowercase letters, digits and dashes, starting with a letter (40 at most)." };
  if (!name || name.length > 60) return { problem: "Name the playbook (60 characters at most)." };
  if (!(PLAYBOOK_KINDS as readonly string[]).includes(kind)) return { problem: "Choose a kind." };
  if (!makerInstructions) return { problem: "Say what the maker should do differently for this kind of work." };
  if (makerInstructions.length > 8000) return { problem: "Instructions are 8,000 characters at most." };

  const criteria = text("criteria")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?/, "").trim())
    .filter(Boolean)
    .map((t) => ({ text: t }));
  if (criteria.length > 10) return { problem: "Ten added criteria at most." };

  const extraChecks: Array<{ name: string; command: string }> = [];
  for (const line of text("extraChecks").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(":");
    const checkName = at > 0 ? line.slice(0, at).trim() : "";
    const command = at > 0 ? line.slice(at + 1).trim() : "";
    if (!CHECK_NAME.test(checkName) || !command) return { problem: `Each extra check is "name: command" — "${line}" isn't.` };
    extraChecks.push({ name: checkName, command });
  }
  const requireStages = (["browser", "security"] as const).filter((s) => form.get(`require-${s}`) === "on");
  const verifier: PlaybookVerifier = {
    ...(extraChecks.length ? { extraChecks } : {}),
    ...(form.get("checksRequired") === "on" ? { checksRequired: true as const } : {}),
    ...(requireStages.length ? { requireStages: [...requireStages] } : {}),
  };
  const risk = text("defaultRiskLevel");
  return {
    input: {
      slug,
      name,
      kind: kind as PlaybookKind,
      makerInstructions,
      criteria,
      verifier,
      defaultRiskLevel: risk === "low" || risk === "medium" || risk === "high" ? risk : null,
    },
  };
}

export function formDefaults(p: Pick<Playbook, "slug" | "name" | "kind" | "makerInstructions" | "criteria" | "verifier" | "defaultRiskLevel">) {
  return {
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    makerInstructions: p.makerInstructions,
    criteria: p.criteria.map((c) => c.text).join("\n"),
    extraChecks: (p.verifier.extraChecks ?? []).map((c) => `${c.name}: ${c.command}`).join("\n"),
    checksRequired: p.verifier.checksRequired === true,
    requireBrowser: (p.verifier.requireStages ?? []).includes("browser"),
    requireSecurity: (p.verifier.requireStages ?? []).includes("security"),
    defaultRiskLevel: p.defaultRiskLevel ?? "",
  };
}

async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: refusalText(err.code, err.message) };
    throw err;
  }
}

export function savePlaybook(
  api: PlaybooksApi,
  orgId: string,
  playbookId: string | null,
  form: FormData,
  existing: Pick<Playbook, "verifier"> | null = null,
): Promise<ActionResult> {
  const read = readPlaybookForm(form);
  if ("problem" in read) return Promise.resolve({ ok: false, message: read.problem });
  const kept = existing
    ? {
        ...(existing.verifier.extraFlows ? { extraFlows: existing.verifier.extraFlows } : {}),
        ...(existing.verifier.extraTools ? { extraTools: existing.verifier.extraTools } : {}),
      }
    : {};
  const input = { ...read.input, verifier: { ...read.input.verifier, ...kept } };
  return guard(async () => {
    const saved = playbookId ? await api.update(orgId, playbookId, input) : await api.create(orgId, input);
    return { ok: true, message: `Saved “${saved.name}” as v${saved.version}. Tasks filed under an earlier version keep it.` };
  });
}

export function duplicatePlaybook(api: PlaybooksApi, orgId: string, from: string, slug?: string): Promise<ActionResult> {
  return guard(async () => {
    const copy = await api.create(orgId, { from, ...(slug ? { slug } : {}) });
    return {
      ok: true,
      message: `Copied as “${copy.slug}”. ${copy.slug === from ? "It replaces the built-in for this organization." : "The original is unchanged."}`,
    };
  });
}

export function archivePlaybook(api: PlaybooksApi, orgId: string, playbookId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.archive(orgId, playbookId);
    return { ok: true };
  });
}
