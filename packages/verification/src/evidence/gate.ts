import type { MappingFile, Verdict } from "./format.js";

export const GATE_LEVELS = ["fail", "criteria", "warn"] as const;

export type GateLevel = (typeof GATE_LEVELS)[number];

export const DEFAULT_GATE_LEVEL: GateLevel = "fail";

export class InvalidGateLevelError extends Error {
  constructor(value: string) {
    super(`unknown --gate level "${value}" (expected one of: ${GATE_LEVELS.join(", ")})`);
    this.name = "InvalidGateLevelError";
  }
}

export function isGateLevel(value: string): value is GateLevel {
  return (GATE_LEVELS as readonly string[]).includes(value);
}

export function parseGateLevel(raw: string | true | undefined): GateLevel | null {
  if (raw === undefined) return null;
  if (raw === true) return DEFAULT_GATE_LEVEL;
  if (!isGateLevel(raw)) throw new InvalidGateLevelError(raw);
  return raw;
}

export interface GateDecision {
  gated: boolean;
  lines: string[];
}

export function gateDecision(
  level: GateLevel | null,
  verdict: Verdict,
  mapping: Pick<MappingFile, "mappings">,
): GateDecision {
  if (level === null) return { gated: false, lines: [] };

  const unsettled = mapping.mappings.filter((m) => m.status === "unknown");
  const lines: string[] = [];

  if (verdict === "fail") {
    return { gated: true, lines: [`gate: FAILED — the verdict is fail (--gate=${level})`] };
  }

  const stopsOnUnsettled = level === "criteria" || level === "warn";
  if (stopsOnUnsettled && unsettled.length) {
    lines.push(
      `gate: FAILED — ${unsettled.length} criterion(s) nobody could settle (--gate=${level}):`,
      ...unsettled.map((m) => `  ${m.criterion}: ${m.reason}`),
      "An unknown criterion is neither met nor unmet — the evidence does not say. Add evidence " +
        "that settles it, or restate the criterion so the evidence could.",
    );
    return { gated: true, lines };
  }

  if (level === "warn" && verdict === "warn") {
    return {
      gated: true,
      lines: [`gate: FAILED — the verdict is warn and --gate=warn admits only a clean pass`],
    };
  }

  return { gated: false, lines: [] };
}
