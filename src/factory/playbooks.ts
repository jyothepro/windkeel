

import type { Pool, PoolClient } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import {
  parsePlaybookVerifier,
  PlaybookVerifierError,
  type PlaybookProvenance,
  type PlaybookVerifierRequirements,
} from "@windkeel/verification/playbook-policy.js";
import { builtinPlaybooks } from "./playbooks-builtin.js";
import { getModelPreset } from "./model-presets.js";
import {
  archivePlaybookRow,
  insertPlaybookRow,
  selectLivePlaybookRowById,
  selectLivePlaybookRowBySlug,
  selectLivePlaybookRows,
  updatePlaybookRow,
  type PlaybookValues,
} from "./stores/playbook-store.js";
import type { RiskLevel } from "./rails.js";

export type { PlaybookVerifierRequirements } from "@windkeel/verification/playbook-policy.js";

type Db = Pool | PoolClient;

export const PLAYBOOK_KINDS = [
  "code-review",
  "migration",
  "incident-fix",
  "test-writing",
  "dependency-upgrade",
  "custom",
] as const;
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];

export interface Playbook {

  id: string | null;
  slug: string;
  name: string;
  kind: PlaybookKind;
  version: number;
  makerInstructions: string;
  criteria: Array<{ text: string }>;
  verifier: PlaybookVerifierRequirements;
  defaultRiskLevel: RiskLevel | null;
  modelPresetId: string | null;
  builtin: boolean;
}

export type PlaybookSnapshot = Omit<Playbook, "name" | "defaultRiskLevel" | "modelPresetId">;

export class PlaybookError extends Error {
  override readonly name = "PlaybookError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
const NAME_MAX = 60;
const INSTRUCTIONS_MAX = 8000;
const CRITERIA_MAX = 10;
const CRITERION_MAX = 500;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const INPUT_KEYS = [
  "slug",
  "name",
  "kind",
  "makerInstructions",
  "criteria",
  "verifier",
  "defaultRiskLevel",
  "modelPresetId",
] as const;

const invalid = (message: string) => new PlaybookError(400, "invalid_playbook", message);
export const unknownPlaybook = (ref: string) =>
  new PlaybookError(404, "unknown_playbook", `no playbook ${JSON.stringify(ref)} in this organization`);

export interface PlaybookFields {
  slug: string;
  name: string;
  kind: PlaybookKind;
  makerInstructions: string;
  criteria: Array<{ text: string }>;
  verifier: PlaybookVerifierRequirements;
  defaultRiskLevel: RiskLevel | null;
  modelPresetId: string | null;
}

export function parsePlaybookInput(
  raw: unknown,
  options: { base?: PlaybookFields; allow?: readonly string[] } = {},
): PlaybookFields {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("a playbook is an object");
  const fields = raw as Record<string, unknown>;
  const allowed: readonly string[] = [...INPUT_KEYS, ...(options.allow ?? [])];
  const unknown = Object.keys(fields).filter((k) => !allowed.includes(k));
  if (unknown.length) throw invalid(`unknown field ${unknown.join(", ")}; a playbook has ${INPUT_KEYS.join(", ")}`);
  const base = options.base;
  const has = (key: string) => fields[key] !== undefined;

  const slug = has("slug") ? fields["slug"] : base?.slug;
  if (typeof slug !== "string" || !SLUG.test(slug)) throw invalid(`slug must match ${SLUG.source}`);

  const rawName = has("name") ? fields["name"] : base?.name;
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (name.length === 0 || name.length > NAME_MAX) throw invalid(`name must be 1-${NAME_MAX} characters`);

  const kind = has("kind") ? fields["kind"] : (base?.kind ?? "custom");
  if (typeof kind !== "string" || !(PLAYBOOK_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`kind must be one of ${PLAYBOOK_KINDS.join(", ")}`);
  }

  const instructions = has("makerInstructions") ? fields["makerInstructions"] : base?.makerInstructions;
  if (typeof instructions !== "string" || !instructions.trim()) throw invalid("makerInstructions must be non-empty text");
  if (instructions.length > INSTRUCTIONS_MAX) throw invalid(`makerInstructions must be at most ${INSTRUCTIONS_MAX} characters`);
  if (instructions.includes("\0")) throw invalid("makerInstructions must not contain a NUL byte");

  const criteria = has("criteria") ? parseCriteria(fields["criteria"]) : (base?.criteria ?? []);

  let verifier: PlaybookVerifierRequirements;
  try {
    verifier = has("verifier") ? parsePlaybookVerifier(fields["verifier"]) : (base?.verifier ?? {});
  } catch (error) {
    if (error instanceof PlaybookVerifierError) throw invalid(error.message);
    throw error;
  }

  const risk = fields["defaultRiskLevel"] === undefined ? (base?.defaultRiskLevel ?? null) : fields["defaultRiskLevel"];
  if (risk !== null && !(typeof risk === "string" && (RISK_LEVELS as readonly string[]).includes(risk))) {
    throw invalid("defaultRiskLevel must be low, medium, high or null");
  }

  const preset = fields["modelPresetId"] === undefined ? (base?.modelPresetId ?? null) : fields["modelPresetId"];
  if (preset !== null && !(typeof preset === "string" && UUID_SHAPE.test(preset))) {
    throw invalid("modelPresetId must be a model preset id or null");
  }

  return {
    slug,
    name,
    kind: kind as PlaybookKind,
    makerInstructions: instructions,
    criteria,
    verifier,
    defaultRiskLevel: risk as RiskLevel | null,
    modelPresetId: preset,
  };
}

function parseCriteria(raw: unknown): Array<{ text: string }> {
  if (!Array.isArray(raw)) throw invalid("criteria must be a list of { text }");
  if (raw.length > CRITERIA_MAX) throw invalid(`criteria: at most ${CRITERIA_MAX}`);
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`criteria[${i}] must be { text }`);
    const keys = Object.keys(entry);
    if (keys.some((k) => k !== "text")) throw invalid(`criteria[${i}] has only a text field`);
    const text = (entry as { text?: unknown }).text;
    const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    if (!clean || clean.length > CRITERION_MAX) throw invalid(`criteria[${i}].text must be 1-${CRITERION_MAX} characters`);
    return { text: clean };
  });
}

function valuesOf(fields: PlaybookFields): PlaybookValues {
  return {
    slug: fields.slug,
    name: fields.name,
    kind: fields.kind,
    makerInstructions: fields.makerInstructions,
    criteria: JSON.stringify(fields.criteria),
    verifier: JSON.stringify(fields.verifier),
    defaultRiskLevel: fields.defaultRiskLevel,
    modelPresetId: fields.modelPresetId,
  };
}

function mapRow(row: Record<string, unknown>): Playbook {
  let fields: PlaybookFields;
  try {
    fields = parsePlaybookInput({
      slug: row["slug"],
      name: row["name"],
      kind: row["kind"],
      makerInstructions: row["maker_instructions"],
      criteria: row["criteria"],
      verifier: row["verifier"],
      defaultRiskLevel: row["default_risk_level"] ?? null,
      modelPresetId: row["model_preset_id"] ?? null,
    });
  } catch (error) {
    if (error instanceof PlaybookError) {
      throw new PlaybookError(500, "invalid_stored_playbook", `stored playbook ${String(row["id"])} is not valid: ${error.message}`);
    }
    throw error;
  }
  return { id: row["id"] as string, version: row["version"] as number, builtin: false, ...fields };
}

async function orgRows(db: Db, organizationId: string): Promise<Playbook[]> {
  return (await selectLivePlaybookRows(db, organizationId)).map(mapRow);
}

export async function listPlaybooks(db: Db, organizationId: string, env: NodeJS.ProcessEnv = process.env): Promise<Playbook[]> {
  const own = await orgRows(db, organizationId);
  const shadowed = new Set(own.map((p) => p.slug));
  return [...builtinPlaybooks(env).filter((p) => !shadowed.has(p.slug)).map(copyOf), ...own];
}

export async function getPlaybook(
  db: Db,
  organizationId: string,
  slugOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Playbook | null> {
  if (UUID_SHAPE.test(slugOrId)) {
    const row = await selectLivePlaybookRowById(db, organizationId, slugOrId);
    return row ? mapRow(row) : null;
  }
  if (!SLUG.test(slugOrId)) return null;
  const row = await selectLivePlaybookRowBySlug(db, organizationId, slugOrId);
  if (row) return mapRow(row);
  const builtin = builtinPlaybooks(env).find((p) => p.slug === slugOrId);
  return builtin ? copyOf(builtin) : null;
}

function copyOf(p: Playbook): Playbook {
  return JSON.parse(JSON.stringify(p)) as Playbook;
}

async function checkPreset(db: Db, organizationId: string, presetId: string | null): Promise<void> {
  if (presetId && !(await getModelPreset(db, organizationId, presetId))) {
    throw invalid("modelPresetId names no model preset in this organization");
  }
}

function slugTaken(error: unknown, slug: string): never {
  if ((error as { code?: string }).code === "23505") {
    throw new PlaybookError(409, "playbook_slug_taken", `a playbook with slug "${slug}" already exists`);
  }
  throw error;
}

export async function createPlaybook(
  db: Db,
  organizationId: string,
  raw: unknown,
  options: { createdByPrincipalId?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<Playbook> {
  const from = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["from"] : undefined;
  let base: PlaybookFields | undefined;
  if (from !== undefined) {
    if (typeof from !== "string" || !from) throw invalid("from must be a playbook slug or id");
    const source = await getPlaybook(db, organizationId, from, options.env);
    if (!source) throw unknownPlaybook(from);
    base = fieldsOf(source);
  }
  const fields = parsePlaybookInput(raw, { allow: ["from"], ...(base ? { base } : {}) });
  await checkPreset(db, organizationId, fields.modelPresetId);
  try {
    return mapRow(await insertPlaybookRow(db, organizationId, valuesOf(fields), options.createdByPrincipalId ?? null));
  } catch (error) {
    return slugTaken(error, fields.slug);
  }
}

function fieldsOf(p: Playbook): PlaybookFields {
  return {
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    makerInstructions: p.makerInstructions,
    criteria: p.criteria,
    verifier: p.verifier,
    defaultRiskLevel: p.defaultRiskLevel,
    modelPresetId: p.modelPresetId,
  };
}

async function ownRow(db: Db, organizationId: string, slugOrId: string, env?: NodeJS.ProcessEnv): Promise<Playbook> {
  const found = await getPlaybook(db, organizationId, slugOrId, env);
  if (!found) throw unknownPlaybook(slugOrId);
  if (found.builtin || !found.id) {
    throw new PlaybookError(
      409,
      "builtin_readonly",
      `"${found.slug}" is a built-in playbook and cannot be changed; copy it with { "from": "${found.slug}" } and edit the copy`,
    );
  }
  return found;
}

export async function updatePlaybook(
  db: Db,
  organizationId: string,
  slugOrId: string,
  raw: unknown,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<Playbook> {
  const current = await ownRow(db, organizationId, slugOrId, options.env);
  const fields = parsePlaybookInput(raw, { base: fieldsOf(current) });
  await checkPreset(db, organizationId, fields.modelPresetId);
  try {
    const row = await updatePlaybookRow(db, organizationId, current.id, valuesOf(fields));
    if (!row) throw unknownPlaybook(slugOrId);
    return mapRow(row);
  } catch (error) {
    return slugTaken(error, fields.slug);
  }
}

export async function archivePlaybook(
  db: Db,
  organizationId: string,
  slugOrId: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<Playbook> {
  const current = await ownRow(db, organizationId, slugOrId, options.env);
  await archivePlaybookRow(db, organizationId, current.id);
  return current;
}

export function snapshotPlaybook(p: Playbook): PlaybookSnapshot {
  return copyOf({
    id: p.id,
    slug: p.slug,
    kind: p.kind,
    version: p.version,
    makerInstructions: p.makerInstructions,
    criteria: p.criteria,
    verifier: p.verifier,
    builtin: p.builtin,
  } as Playbook);
}

function playbookSourceRef(snapshot: Pick<PlaybookSnapshot, "slug" | "version">): string {
  return `playbook:${snapshot.slug}@${snapshot.version}`;
}

export function playbookCriteria(snapshot: PlaybookSnapshot | null | undefined): Criterion[] {
  if (!snapshot) return [];
  const ref = playbookSourceRef(snapshot);
  return snapshot.criteria.map((c, i) => ({ id: `PB${i + 1}`, text: c.text, source: { kind: "explicit" as const, ref } }));
}

export function effectiveCriteria(task: { acceptanceCriteria: Criterion[]; playbook?: PlaybookSnapshot | null }): Criterion[] {
  return [...task.acceptanceCriteria, ...playbookCriteria(task.playbook)];
}

export function playbookProvenance(snapshot: PlaybookSnapshot | null | undefined): PlaybookProvenance | null {
  if (!snapshot) return null;
  return {
    slug: snapshot.slug,
    version: snapshot.version,
    builtin: snapshot.builtin,
    verifier: snapshot.verifier,
    criteria: playbookCriteria(snapshot).map((c) => c.id),
  };
}

export function describePlaybookVerifier(verifier: PlaybookVerifierRequirements): string[] {
  const lines: string[] = [];
  for (const check of verifier.extraChecks ?? []) lines.push(`run check playbook.${check.name} (\`${check.command}\`)`);
  if (verifier.checksRequired) lines.push("fail when the repository declares no checks");
  for (const stage of verifier.requireStages ?? []) lines.push(`require the ${stage} stage to run (a skip blocks)`);
  for (const flow of verifier.extraFlows ?? []) lines.push(`run browser flow playbook.${flow.name}`);
  for (const tool of verifier.extraTools ?? []) lines.push(`install ${tool.package}`);
  return lines;
}
