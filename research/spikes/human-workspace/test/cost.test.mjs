import { test } from "node:test";
import assert from "node:assert/strict";
import { costOfSession, costPerHour, costTable } from "../lib/cost.mjs";

test("costPerHour: 2 vCPU idle pays only provisioned memory (4 GB × $0.0212)", () => {
  assert.deepEqual(costPerHour({ vcpus: 2, activeCpuFraction: 0 }), { memory: 0.0848, cpu: 0, egress: 0, total: 0.0848 });
});

test("costPerHour: 2 vCPU fully busy adds 2 × $0.128", () => {
  assert.equal(costPerHour({ vcpus: 2, activeCpuFraction: 1 }).total, 0.3408);
});

test("costPerHour: egress is $0.15/GB", () => {
  assert.equal(costPerHour({ vcpus: 2, activeCpuFraction: 0, egressMbPerHour: 1024 }).egress, 0.15);
});

test("costOfSession: memory has a one-minute minimum; extrapolates per hour", () => {
  const s = costOfSession({ vcpus: 2, wallMs: 10_000, activeCpuMs: 1_000 });
  assert.equal(s.memory, Math.round(2 * 2 * 0.0212 * (1 / 60) * 1e6) / 1e6);
  const h = costOfSession({ vcpus: 2, wallMs: 3_600_000, activeCpuMs: 360_000 });
  assert.equal(h.activeCpuFraction, 0.05);
  assert.ok(Math.abs(h.total - (0.0848 + 0.0128)) < 1e-5);
});

test("costTable covers idle to fully busy", () => {
  const t = costTable();
  assert.deepEqual(t.map((r) => r.activeCpuFraction), [0, 0.05, 0.25, 1]);
  assert.ok(t.every((r, i) => i === 0 || r.total > t[i - 1].total));
});
