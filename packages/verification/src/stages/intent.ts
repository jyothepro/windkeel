import { readFileSync } from "node:fs";
import type { Criterion, Intent } from "../evidence/format.js";

const CHECKLIST = /^\s*[-*]\s*\[[ xX]\]\s+(.*\S)\s*$/;
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*\S)\s*$/;
const AC_HEADING = /acceptance criteria|acceptance-criteria|definition of done/i;

export function extractCriteria(
  text: string,
  source: Criterion["source"],
  startIndex = 1,
): Criterion[] {
  const lines = text.split("\n");
  const found: string[] = [];
  let inAcSection = false;

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      inAcSection = AC_HEADING.test(heading[1] ?? "");
      continue;
    }
    const checklist = CHECKLIST.exec(line);
    if (checklist?.[1]) {
      found.push(checklist[1]);
      continue;
    }
    const bullet = inAcSection ? BULLET.exec(line) : null;
    if (bullet?.[1]) found.push(bullet[1]);
  }

  return found.map((textItem, i) => ({
    id: `AC${startIndex + i}`,
    text: textItem,
    source,
  }));
}

export function readExplicitIntent(path: string): Criterion[] {
  const raw = readFileSync(path, "utf8");
  if (!raw.trimStart().startsWith("{")) {
    return extractCriteria(raw, { kind: "explicit", ref: path });
  }
  const parsed = JSON.parse(raw) as { criteria?: Array<{ id?: string; text: string }> };
  return (parsed.criteria ?? []).map((c, i) => ({
    id: c.id ?? `AC${i + 1}`,
    text: c.text,
    source: { kind: "explicit" as const, ref: path },
  }));
}

export function buildIntent(criteria: Criterion[]): Intent {
  return {
    criteria,
    extraction: {
      method: "deterministic:checklist+acceptance-criteria-section",
      confidence: criteria.length ? "high" : "low",
      note: criteria.length
        ? "criteria quoted verbatim from the PR description and linked issue"
        : "no checklist or acceptance-criteria section found in the PR description or linked issue",
    },
  };
}
