import type { Pool } from "pg";
import type { RepairPacket } from "@windkeel/verification/engine/repair.js";
import { getEngineeringRun, getEngineeringTask, listRepairAttempts } from "./repositories.js";
import { insertLearnedLesson, knowledgeSettings, type KnowledgeNote, type KnowledgeSettings } from "./knowledge.js";
import { countVerifierLessonsForRun, repositoryExists } from "./stores/knowledge-store.js";

export const MAX_LESSONS_PER_RUN = 5;

export interface CandidateLesson {
  title: string;
  body: string;
  sourceRef: Record<string, unknown>;
}

interface FindingLike {
  category?: unknown;
  claim?: unknown;
  location?: unknown;
  failure_scenario?: unknown;
}

export function lessonsFromPacket(
  packet: Partial<RepairPacket>,
  ref: { runId: string; verificationRunId: string; attempt: number },
): CandidateLesson[] {
  const out: CandidateLesson[] = [];
  const base = { runId: ref.runId, verificationRunId: ref.verificationRunId, attempt: ref.attempt };
  const short = ref.runId.slice(0, 8);

  for (const check of packet.failed_checks ?? []) {
    const name = clip(check.check, 80);
    if (!name) continue;
    const command = clip(check.command, 160);
    out.push({
      title: `The ${name} check must pass`,
      body:
        `On run ${short} the ${name} check${command ? ` (\`${command}\`)` : ""} failed and the change ` +
        "needed a repair cycle. Run it and make it pass before finishing.",
      sourceRef: { ...base, kind: "failed_check", check: name, ...(command ? { command } : {}) },
    });
  }
  for (const check of packet.checks_could_not_run ?? []) {
    const name = clip(check.check, 80);
    if (!name) continue;
    out.push({
      title: `The ${name} check could not run`,
      body: `On run ${short} the ${name} check could not run: ${clip(check.detail, 300) ?? "no detail recorded"}`,
      sourceRef: { ...base, kind: "check_could_not_run", check: name },
    });
  }
  const findings: Array<[string, FindingLike[] | undefined]> = [
    ["review_finding", packet.review_findings],
    ["security_finding", packet.security_findings],
    ["browser_finding", packet.browser_findings],
  ];
  for (const [kind, list] of findings) {
    for (const finding of list ?? []) {
      const claim = clip(finding.claim, 300);
      if (!claim) continue;
      const location = clip(finding.location, 120);
      const scenario = clip(finding.failure_scenario, 160);
      out.push({
        title: clip(claim, 120)!,
        body: `${location ? `In ${location}: ` : ""}${claim}${scenario ? ` (${scenario})` : ""}`,
        sourceRef: { ...base, kind, ...(typeof finding.category === "string" ? { category: clip(finding.category, 60) } : {}), ...(location ? { location } : {}) },
      });
    }
  }
  return out;
}

export async function learnFromRun(
  pool: Pool,
  engineeringRunId: string,
  settings: KnowledgeSettings = knowledgeSettings(),
): Promise<KnowledgeNote[]> {
  if (!settings.enabled) return [];
  const attempts = await listRepairAttempts(pool, engineeringRunId);
  if (attempts.length === 0) return [];
  const run = await getEngineeringRun(pool, engineeringRunId);
  if (!run) return [];
  const task = await getEngineeringTask(pool, run.taskId);
  if (!task) return [];
  if (!(await repositoryExists(pool, task.repositoryId))) return [];

  let room = MAX_LESSONS_PER_RUN - (await countVerifierLessonsForRun(pool, engineeringRunId, task.organizationId));
  const written: KnowledgeNote[] = [];
  for (const attempt of attempts) {
    for (const lesson of lessonsFromPacket(attempt.repairPacket, {
      runId: engineeringRunId,
      verificationRunId: attempt.verificationRunId,
      attempt: attempt.attemptNumber,
    })) {
      if (room <= 0) return written;
      const note = await insertLearnedLesson(pool, {
        organizationId: task.organizationId,
        repositoryId: task.repositoryId,
        title: lesson.title,
        body: lesson.body,
        sourceKind: "verifier_finding",
        sourceRef: lesson.sourceRef,
      });
      if (note) {
        written.push(note);
        room -= 1;
      }
    }
  }
  return written;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
