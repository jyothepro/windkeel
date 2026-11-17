// @ts-check
/**
 * Vercel Sandbox cost of a human workspace, from research/vercel-sandbox/findings.md §6 (Pro /
 * Enterprise usage rates, researched 2026-08-14). Pure, so the arithmetic is tested.
 */

export const PRICING = Object.freeze({
  activeCpuPerVcpuHour: 0.128,
  memoryPerGbHour: 0.0212,
  gbPerVcpu: 2,
  egressPerGb: 0.15,
  snapshotPerGbMonth: 0.08,
  creation: 0.6 / 1_000_000,
});

/**
 * Cost of one hour of a workspace.
 * @param {{ vcpus: number, activeCpuFraction: number, egressMbPerHour?: number }} shape
 *   activeCpuFraction: share of provisioned vCPU time actually busy (I/O wait and idle are free).
 */
export function costPerHour({ vcpus, activeCpuFraction, egressMbPerHour = 0 }) {
  const memory = vcpus * PRICING.gbPerVcpu * PRICING.memoryPerGbHour;
  const cpu = vcpus * activeCpuFraction * PRICING.activeCpuPerVcpuHour;
  const egress = (egressMbPerHour / 1024) * PRICING.egressPerGb;
  const round = (n) => Math.round(n * 10_000) / 10_000;
  return { memory: round(memory), cpu: round(cpu), egress: round(egress), total: round(memory + cpu + egress) };
}

/**
 * Cost of a measured session, from what `sandbox.stop()` reports.
 * @param {{ vcpus: number, wallMs: number, activeCpuMs: number, egressBytes?: number }} m
 */
export function costOfSession({ vcpus, wallMs, activeCpuMs, egressBytes = 0 }) {
  const hours = wallMs / 3_600_000;
  // Memory is billed with a one-minute minimum.
  const memHours = Math.max(hours, 1 / 60);
  const memory = vcpus * PRICING.gbPerVcpu * PRICING.memoryPerGbHour * memHours;
  const cpu = (activeCpuMs / 3_600_000) * PRICING.activeCpuPerVcpuHour;
  const egress = (egressBytes / 1024 ** 3) * PRICING.egressPerGb;
  const total = memory + cpu + egress + PRICING.creation;
  const r = (n) => Math.round(n * 1_000_000) / 1_000_000;
  return {
    memory: r(memory),
    cpu: r(cpu),
    egress: r(egress),
    total: r(total),
    activeCpuFraction: hours > 0 ? Math.round((activeCpuMs / (wallMs * vcpus)) * 1000) / 1000 : 0,
    extrapolatedPerHour: hours > 0 ? r(total / hours) : null,
  };
}

/** The table FINDINGS.md quotes: a 2-vCPU workspace at a range of activity. */
export function costTable(vcpus = 2) {
  return [0, 0.05, 0.25, 1].map((f) => ({ vcpus, activeCpuFraction: f, ...costPerHour({ vcpus, activeCpuFraction: f }) }));
}
