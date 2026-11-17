import type { ExecutionEnvironment } from "../exec/environment.js";
import type { Author, Criterion, EvidenceItem, Finding } from "../evidence/format.js";
import {
  NoIndependentProviderError,
  makerIdentity,
  parseJsonResponse,
  selectGateway,
} from "../providers/index.js";
import type { ModelPolicy, ModelUsage } from "../providers/types.js";
import { REVIEW_SYSTEM_PROMPT, reviewUserPrompt } from "../providers/prompt.js";
import { collectRepositoryContext, renderRepositoryContext } from "./repo-context.js";

interface ReviewResponse {
  summary?: string;
  findings?: Finding[];
}

export interface ReviewInput {
  execEnv: ExecutionEnvironment;
  repo: string;
  baseSha: string;
  headSha: string;
  title: string;
  author: Author;
  criteria: Criterion[];
  models: ModelPolicy;
}

export interface ReviewOutput {
  evidence: EvidenceItem;
  transcript?: string;
  transcriptPath?: string;
  usage?: ModelUsage;
}

const MAX_DIFF_BYTES = 400_000;

export async function collectDiff(
  execEnv: ExecutionEnvironment,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  return (await diffBetween(execEnv, repo, baseSha, headSha)).diff;
}

async function diffBetween(
  execEnv: ExecutionEnvironment,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<{ diff: string; ok: boolean }> {
  const result = await execEnv.exec("git", {
    args: ["diff", `${baseSha}..${headSha}`],
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
  });
  const diff = result.status === 0 ? result.stdout : "";
  return { ok: result.status === 0, diff: truncateDiff(diff) };
}

function truncateDiff(diff: string): string {
  return diff.length > MAX_DIFF_BYTES
    ? `${diff.slice(0, MAX_DIFF_BYTES)}\n[diff truncated at ${MAX_DIFF_BYTES} bytes]\n`
    : diff;
}

export async function runReview(id: string, input: ReviewInput): Promise<ReviewOutput> {
  const skipped = (reason: string): ReviewOutput => ({
    evidence: { id, stage: "review", type: "review_finding_set", status: "skipped", reason },
  });
  const notReviewed = (reason: string): ReviewOutput => ({
    evidence: { id, stage: "review", type: "review_finding_set", status: "warning", reason },
  });

  let gateway;
  try {
    gateway = selectGateway(input.models, input.author, "review");
  } catch (error) {
    if (!(error instanceof NoIndependentProviderError)) throw error;
    return {
      evidence: {
        id,
        stage: "review",
        type: "review_finding_set",
        status: "failed",
        summary: "no independent reviewer available",
        findings: [
          {
            id: "F-independence",
            severity: "blocking",
            category: "verifier-independence",
            claim: error.message,
            failure_scenario:
              "Reviewing with the authoring vendor's own model would be the author grading its own work; the gate refuses rather than producing a review that only looks independent",
          },
        ],
      },
    };
  }
  const { diff, ok } = await diffBetween(input.execEnv, input.repo, input.baseSha, input.headSha);
  if (!ok) {
    return notReviewed(
      `diff_unavailable — git could not diff ${input.baseSha}..${input.headSha} (shallow clone? fetch-depth: 0 fixes it); the change was not reviewed`,
    );
  }
  if (!diff.trim()) return skipped("empty_diff — no changes between base and head");
  if (!gateway) {
    return notReviewed(
      "no_reviewer_configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY (or WINDKEEL_FAKE_REVIEWER in tests); the change was not reviewed",
    );
  }

  const context = await collectRepositoryContext(
    input.execEnv,
    input.repo,
    input.baseSha,
    input.headSha,
  );
  const repositoryContext = renderRepositoryContext(context);

  const raw = await gateway.generate({
    system: REVIEW_SYSTEM_PROMPT,
    user: reviewUserPrompt({
      diff,
      criteria: input.criteria.map((c) => ({ id: c.id, text: c.text })),
      subjectTitle: input.title,
      repositoryContext,
    }),
  });
  const parsed = parseJsonResponse<ReviewResponse>(raw.text);
  const response = {
    summary: parsed.summary ?? "",
    findings: (parsed.findings ?? []).map((f, i) => ({ ...f, id: f.id || `F${i + 1}` })),
  };

  const blocking = response.findings.filter((f) => f.severity === "blocking").length;
  const transcriptPath = `evidence/${id}-review.log`;

  return {
    evidence: {
      id,
      stage: "review",
      type: "review_finding_set",
      status: response.findings.length ? "completed_with_findings" : "passed",
      summary:
        response.summary ||
        `adversarial review: ${blocking} blocking, ${response.findings.length - blocking} non-blocking`,
      reviewer: {
        model: gateway.model,
        vendor: gateway.vendor,
        independence: {
          different_vendor_than_author:
            gateway.vendor !== (makerIdentity(input.models, input.author).vendor ?? null),
          author_vendor: makerIdentity(input.models, input.author).vendor ?? null,
          clean_context: true,
          inputs: ["diff", "acceptance criteria", "repository context"],
          posture: "adversarial — prompted to refute the change",
        },
      },
      findings: response.findings,
      transcript: transcriptPath,
    },
    ...(raw.usage ? { usage: raw.usage } : {}),
    transcript: `reviewer: ${gateway.vendor}/${gateway.model}\ndiff bytes: ${diff.length}\n\n${JSON.stringify(response, null, 2)}\n`,
    transcriptPath,
  };
}
