import {
  ENTRY_NAME,
  MAX_TOOLS,
  TOOL_NAME,
  validArtifactsPath,
  type CheckSpec,
  type FlowSpec,
  type WindkeelConfig,
  type RejectedTool,
  type RequirableStage,
  type SystemToolSpec,
} from "./config.js";

export type { RequirableStage } from "./config.js";

export interface PlaybookVerifierRequirements {
  extraChecks?: CheckSpec[];
  checksRequired?: true;
  requireStages?: RequirableStage[];
  extraFlows?: FlowSpec[];
  extraTools?: SystemToolSpec[];
}

export interface PlaybookProvenance {
  slug: string;
  version: number;
  builtin: boolean;
  verifier: PlaybookVerifierRequirements;
  criteria?: string[];
}

export const PLAYBOOK_ENTRY_PREFIX = "playbook.";

export const PLAYBOOK_ENTRY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_PLAYBOOK_COMMAND = 1000;
export const MAX_PLAYBOOK_CHECKS = 10;
export const MAX_PLAYBOOK_FLOWS = 10;
const REQUIRABLE: readonly RequirableStage[] = ["browser", "security"];
const KEYS = ["extraChecks", "checksRequired", "requireStages", "extraFlows", "extraTools"] as const;

export class PlaybookVerifierError extends Error {
  override readonly name = "PlaybookVerifierError";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`verifier.${field}: ${message}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(field: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw new PlaybookVerifierError(field, `unknown field ${extra.join(", ")} (a playbook can only add: ${allowed.join(", ")})`);
  }
}

function entryName(field: string, value: unknown): string {
  if (typeof value !== "string" || !PLAYBOOK_ENTRY_NAME.test(value) || !ENTRY_NAME.test(`${PLAYBOOK_ENTRY_PREFIX}${value}`)) {
    throw new PlaybookVerifierError(field, `name must match ${PLAYBOOK_ENTRY_NAME.source} (it becomes a file name in the evidence package)`);
  }
  return value;
}

function command(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PlaybookVerifierError(field, "command must be a non-empty string");
  if (value.length > MAX_PLAYBOOK_COMMAND) {
    throw new PlaybookVerifierError(field, `command must be at most ${MAX_PLAYBOOK_COMMAND} characters`);
  }
  if (value.includes("\0")) throw new PlaybookVerifierError(field, "command must not contain a NUL byte");
  return value;
}

function list(field: string, value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) throw new PlaybookVerifierError(field, "must be a list");
  if (value.length > max) throw new PlaybookVerifierError(field, `at most ${max} entries`);
  return value;
}

export function parsePlaybookVerifier(raw: unknown): PlaybookVerifierRequirements {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new PlaybookVerifierError("", "must be an object");
  onlyKeys("", raw, KEYS);
  const out: PlaybookVerifierRequirements = {};

  if (raw["extraChecks"] !== undefined) {
    const seen = new Set<string>();
    out.extraChecks = list("extraChecks", raw["extraChecks"], MAX_PLAYBOOK_CHECKS).map((entry, i) => {
      const field = `extraChecks[${i}]`;
      if (!isObject(entry)) throw new PlaybookVerifierError(field, "each check is { name, command }");
      onlyKeys(field, entry, ["name", "command"]);
      const name = entryName(field, entry["name"]);
      if (seen.has(name)) throw new PlaybookVerifierError(field, `duplicate check name ${name}`);
      seen.add(name);
      return { name, command: command(field, entry["command"]) };
    });
    if (out.extraChecks.length === 0) delete out.extraChecks;
  }

  if (raw["checksRequired"] !== undefined) {
    if (raw["checksRequired"] !== true) {
      throw new PlaybookVerifierError("checksRequired", "can only be true — a playbook strengthens the gate, never weakens it");
    }
    out.checksRequired = true;
  }

  if (raw["requireStages"] !== undefined) {
    const stages = list("requireStages", raw["requireStages"], 10).map((stage, i) => {
      if (typeof stage !== "string" || !(REQUIRABLE as readonly string[]).includes(stage)) {
        throw new PlaybookVerifierError(`requireStages[${i}]`, `must be one of ${REQUIRABLE.join(", ")}`);
      }
      return stage as RequirableStage;
    });
    const unique = [...new Set(stages)];
    if (unique.length) out.requireStages = unique;
  }

  if (raw["extraFlows"] !== undefined) {
    const seen = new Set<string>();
    out.extraFlows = list("extraFlows", raw["extraFlows"], MAX_PLAYBOOK_FLOWS).map((entry, i) => {
      const field = `extraFlows[${i}]`;
      if (!isObject(entry)) throw new PlaybookVerifierError(field, "each flow is { name, command, artifacts? }");
      onlyKeys(field, entry, ["name", "command", "artifacts"]);
      const name = entryName(field, entry["name"]);
      if (seen.has(name)) throw new PlaybookVerifierError(field, `duplicate flow name ${name}`);
      seen.add(name);
      const artifacts = entry["artifacts"];
      if (artifacts !== undefined && (typeof artifacts !== "string" || !validArtifactsPath(artifacts))) {
        throw new PlaybookVerifierError(field, "artifacts must be a relative path inside the checkout, with no `..` segment");
      }
      return { name, command: command(field, entry["command"]), ...(typeof artifacts === "string" ? { artifacts } : {}) };
    });
    if (out.extraFlows.length === 0) delete out.extraFlows;
  }

  if (raw["extraTools"] !== undefined) {
    const seen = new Set<string>();
    out.extraTools = list("extraTools", raw["extraTools"], MAX_TOOLS).flatMap((entry, i) => {
      const field = `extraTools[${i}]`;
      const spec = typeof entry === "string" ? { package: entry } : isObject(entry) ? entry : null;
      if (!spec) throw new PlaybookVerifierError(field, 'each tool is a package name, or { "package": "name", "reason": "..." }');
      onlyKeys(field, spec, ["package", "reason"]);
      const pkg = spec["package"];
      if (typeof pkg !== "string" || !TOOL_NAME.test(pkg)) {
        throw new PlaybookVerifierError(field, `not a package name (must match ${TOOL_NAME.source})`);
      }
      const reason = spec["reason"];
      if (reason !== undefined && (typeof reason !== "string" || reason.length > 200)) {
        throw new PlaybookVerifierError(field, "reason must be text of at most 200 characters");
      }
      if (seen.has(pkg)) return [];
      seen.add(pkg);
      return [{ package: pkg, ...(typeof reason === "string" ? { reason } : {}) }];
    });
    if (out.extraTools.length === 0) delete out.extraTools;
  }
  return out;
}

export function isEmptyPlaybookVerifier(req: PlaybookVerifierRequirements): boolean {
  return KEYS.every((k) => req[k] === undefined);
}

function prefixed(name: string, taken: Set<string>): string {
  const wanted = `${PLAYBOOK_ENTRY_PREFIX}${name}`;
  let candidate = wanted;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${wanted}-${n}`;
  taken.add(candidate);
  return candidate;
}

export function mergePlaybookTools(
  base: SystemToolSpec[],
  extra: SystemToolSpec[] | undefined,
): { tools: SystemToolSpec[]; rejectedTools: RejectedTool[] } {
  const tools = [...base];
  const rejectedTools: RejectedTool[] = [];
  for (const spec of extra ?? []) {
    if (tools.some((t) => t.package === spec.package)) continue;
    if (tools.length >= MAX_TOOLS) {
      rejectedTools.push({ value: spec.package, reason: `playbook tool over the cap of ${MAX_TOOLS} tools; not installed` });
      continue;
    }
    tools.push(spec);
  }
  return { tools, rejectedTools };
}

export function applyPlaybookToPolicy(base: WindkeelConfig, requirements: unknown): WindkeelConfig {
  const req = parsePlaybookVerifier(requirements);
  if (isEmptyPlaybookVerifier(req)) return base;
  const checkNames = new Set(base.checks.map((c) => c.name));
  const flowNames = new Set(base.flows.map((f) => f.name));
  const tools = mergePlaybookTools(base.tools, req.extraTools);
  const requiredStages = [...new Set([...(base.requiredStages ?? []), ...(req.requireStages ?? [])])];
  return {
    ...base,
    checks: [
      ...base.checks,
      ...(req.extraChecks ?? []).map((c) => ({ name: prefixed(c.name, checkNames), command: c.command })),
    ],
    checksRequired: base.checksRequired || req.checksRequired === true,
    flows: [
      ...base.flows,
      ...(req.extraFlows ?? []).map((f) => ({ ...f, name: prefixed(f.name, flowNames) })),
    ],
    tools: tools.tools,
    rejectedTools: [...base.rejectedTools, ...tools.rejectedTools],
    ...(requiredStages.length ? { requiredStages } : {}),
  };
}
