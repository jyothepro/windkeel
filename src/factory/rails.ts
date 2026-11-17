import type { RepairPacket } from "@windkeel/verification/engine/repair.js";
import type { RunState } from "./run-state-machine.js";

export type RiskLevel = "low" | "medium" | "high";

export type StopReason =
  | "spend_cap"
  | "wall_clock_cap"
  | "stuck"
  | "repair_cap"
  | "approval_expired"
  | "error"
  | "model_policy"
  | "org_budget";

export const REPAIR_ATTEMPT_CAPS: Record<RiskLevel, number> = {
  low: 3,
  medium: 2,
  high: 1,
};

export const DEFAULT_SPEND_CAP_USD = 25;
export const DEFAULT_WALL_CLOCK_CAP_SECONDS = 7200;

const PARKING_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "WAITING_FOR_APPROVAL",
  "WAITING_FOR_HUMAN",
  "HUMAN_EDITING",
]);

export const DEFAULT_HUMAN_CYCLES_CAP = 10;

export const DEFAULT_APPROVAL_DEADLINE_SECONDS = 72 * 60 * 60;

const STUCK_THRESHOLD = 2;

export interface RunRails {
  spend_cap_usd: number | null;
  wall_clock_cap_seconds: number;
}

export class UncappedRunError extends Error {}

export function runRails(
  options: {
    spendCapUsd?: number | null;
    wallClockCapSeconds?: number;
    uncappedConfirmed?: boolean;
  } = {},
): RunRails {
  const cap = options.spendCapUsd === undefined ? DEFAULT_SPEND_CAP_USD : options.spendCapUsd;
  if (cap === null && !options.uncappedConfirmed) {
    throw new UncappedRunError(
      "spend_cap_usd: null runs uncapped; pass uncappedConfirmed: true to do that deliberately",
    );
  }
  return {
    spend_cap_usd: cap,
    wall_clock_cap_seconds: options.wallClockCapSeconds ?? DEFAULT_WALL_CLOCK_CAP_SECONDS,
  };
}

export function checkCaps(
  run: { rails: RunRails; cost: number; started_at: Date; parked_seconds?: number },
  now: Date,
): Extract<StopReason, "spend_cap" | "wall_clock_cap"> | null {
  const { spend_cap_usd, wall_clock_cap_seconds } = run.rails;
  if (spend_cap_usd !== null && run.cost >= spend_cap_usd) return "spend_cap";
  const elapsed = now.getTime() - run.started_at.getTime();
  const working = elapsed - Math.max(0, run.parked_seconds ?? 0) * 1000;
  if (working > wall_clock_cap_seconds * 1000) return "wall_clock_cap";
  return null;
}

export function parkedSeconds(
  transitions: readonly { toState: RunState; at: Date }[],
  now: Date,
): number {
  let total = 0;
  let parkedSince: Date | null = null;
  for (const transition of transitions) {
    const parking = PARKING_STATES.has(transition.toState);
    if (parking && parkedSince === null) parkedSince = transition.at;
    else if (!parking && parkedSince !== null) {
      total += transition.at.getTime() - parkedSince.getTime();
      parkedSince = null;
    }
  }
  if (parkedSince !== null) total += Math.max(0, now.getTime() - parkedSince.getTime());
  return total / 1000;
}

export function checkApprovalDeadline(
  waitingSince: Date,
  now: Date,
  deadlineSeconds: number = DEFAULT_APPROVAL_DEADLINE_SECONDS,
): Extract<StopReason, "approval_expired"> | null {
  return now.getTime() - waitingSince.getTime() > deadlineSeconds * 1000
    ? "approval_expired"
    : null;
}

export function approvalDeadlineAt(
  waitingSince: Date,
  deadlineSeconds: number = DEFAULT_APPROVAL_DEADLINE_SECONDS,
): Date {
  return new Date(waitingSince.getTime() + deadlineSeconds * 1000);
}

export function packetFingerprint(packet: RepairPacket): string {
  const sorted = (values: string[]) => [...values].sort();
  return JSON.stringify({
    criteria: sorted(packet.failed_acceptance_criteria.map((c) => c.id)),
    checks: sorted(packet.failed_checks.map((c) => c.check)),
    security: sorted(packet.security_findings.map((f) => f.id)),
    review: sorted(packet.review_findings.map((f) => f.id)),
    browser: sorted(packet.browser_findings.map((f) => f.id)),
  });
}

export function isStuck(packets: RepairPacket[], threshold = STUCK_THRESHOLD): boolean {
  if (threshold < 2 || packets.length < threshold) return false;
  const trailing = packets.slice(-threshold).map(packetFingerprint);
  return trailing.every((fingerprint) => fingerprint === trailing[0]);
}

export function checkRepairLoop(
  packets: RepairPacket[],
  riskLevel: RiskLevel,
  stuckThreshold = STUCK_THRESHOLD,
): Extract<StopReason, "repair_cap" | "stuck"> | null {
  if (isStuck(packets, stuckThreshold)) return "stuck";
  if (packets.length > REPAIR_ATTEMPT_CAPS[riskLevel]) return "repair_cap";
  return null;
}

export function terminalStateFor(
  reason: StopReason,
): "MAX_REPAIR_ATTEMPTS_REACHED" | "CANCELLED" | "FAILED" {
  if (reason === "stuck" || reason === "repair_cap") return "MAX_REPAIR_ATTEMPTS_REACHED";
  if (reason === "approval_expired") return "CANCELLED";
  return "FAILED";
}
