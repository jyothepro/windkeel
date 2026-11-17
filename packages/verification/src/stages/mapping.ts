import type {
  Author,
  Criterion,
  EvidenceItem,
  Mapping,
  MappingFile,
} from "../evidence/format.js";
import {
  NoIndependentProviderError,
  parseJsonResponse,
  selectGateway,
} from "../providers/index.js";
import type { ModelPolicy, ModelUsage } from "../providers/types.js";
import { MAPPING_SYSTEM_PROMPT, mappingUserPrompt } from "../providers/prompt.js";
import { executedCommands, explainUnsettledExecution } from "./execution-criteria.js";

export interface MappingInput {
  criteria: Criterion[];
  evidence: EvidenceItem[];
  diff: string;
  author: Author;
  models: ModelPolicy;
  repositoryContext?: string;
}

const unjudged = (criterion: string, reason: string): Mapping => ({
  criterion,
  status: "unsatisfied",
  evidence: [],
  reason,
});

export interface MappingOutput {
  mapping: MappingFile;
  usage?: ModelUsage;
}

export async function runMapping(input: MappingInput): Promise<MappingOutput> {
  if (!input.criteria.length) {
    return {
      mapping: { status: "skipped", reason: "no_criteria — the PR description and linked issue state no acceptance criteria", mappings: [] },
    };
  }

  let gateway;
  try {
    gateway = selectGateway(input.models, input.author, "mapping");
  } catch (error) {
    if (!(error instanceof NoIndependentProviderError)) throw error;
    return {
      mapping: {
        status: "completed",
        reason: `no independent mapper available: ${error.message}`,
        mappings: input.criteria.map((c) =>
          unjudged(c.id, "no independent mapper available; the criterion is not demonstrated"),
        ),
      },
    };
  }
  if (!gateway) {
    const reason =
      "no_mapper_configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY (or WINDKEEL_FAKE_MAPPER in tests); nothing judged whether the criteria are met";
    return {
      mapping: {
        status: "skipped",
        reason,
        mappings: input.criteria.map((c) => ({
          criterion: c.id,
          status: "unknown" as const,
          evidence: [],
          reason: "no mapper was configured, so nothing judged this criterion",
        })),
      },
    };
  }

  const executed = executedCommands(input.evidence);

  const raw = await gateway.generate({
    system: MAPPING_SYSTEM_PROMPT,
    user: mappingUserPrompt({
      ...(input.repositoryContext ? { repositoryContext: input.repositoryContext } : {}),
      executed,
      criteria: input.criteria.map((c) => ({ id: c.id, text: c.text })),
      evidence: input.evidence.map((e) => ({
        id: e.id,
        stage: e.stage,
        status: e.status,
        summary: e.summary ?? e.reason ?? "",
      })),
      diff: input.diff,
    }),
  });
  const answered = new Map(
    parseJsonResponse<{ mappings?: Mapping[] }>(raw.text).mappings?.map((m) => [m.criterion, m]) ??
      [],
  );
  const evidenceIds = new Set(input.evidence.map((e) => e.id));

  const mappings = input.criteria.map((criterion) => {
    const mapped = answered.get(criterion.id);
    if (!mapped) return unjudged(criterion.id, "the mapper returned no verdict for this criterion");
    const cited = (mapped.evidence ?? []).filter((id) => evidenceIds.has(id));
    if (mapped.status === "satisfied" && !cited.length) {
      return unjudged(
        criterion.id,
        `claimed satisfied but cites no evidence in this package: ${mapped.reason}`,
      );
    }
    return explainUnsettledExecution(
      { ...mapped, criterion: criterion.id, evidence: cited },
      criterion.text,
      executed,
    );
  });

  return { mapping: { status: "completed", mappings }, ...(raw.usage ? { usage: raw.usage } : {}) };
}
