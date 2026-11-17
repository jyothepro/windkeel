import {
  batchRails,
  DEFAULT_BATCH_MAX_ITEMS,
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_LIMIT,
  positiveIntFromEnv,
  UncappedBatchError,
} from "./rails.js";
import { BatchError, type BatchItemSpec, type BatchKind, type BatchTemplate } from "./store.js";

export interface BatchInput {
  kind?: unknown;
  title?: unknown;
  description?: unknown;

  repositoryId?: unknown;

  items?: unknown;

  repositories?: unknown;
  criteria?: unknown;
  riskLevel?: unknown;
  maxConcurrency?: unknown;
  batchSpendCapUsd?: unknown;
  uncappedConfirmed?: unknown;
  stopOnFailureRatio?: unknown;
  spendCapUsd?: unknown;
  wallClockCapSeconds?: unknown;
}

export interface NormalisedBatch {
  kind: BatchKind;
  title: string;
  description: string;
  template: BatchTemplate;
  maxConcurrency: number;
  batchSpendCapUsd: number | null;
  stopOnFailureRatio: number | null;
  items: Array<{ repositoryId: string; spec: BatchItemSpec }>;
}

export function batchMaxItems(env: Record<string, string | undefined> = process.env): number {
  return positiveIntFromEnv(env["WINDKEEL_BATCH_MAX_ITEMS"], DEFAULT_BATCH_MAX_ITEMS);
}

function text(name: string, value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new BatchError(`${name} is required`, "missing_field", 400);
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new BatchError(`${name} must be a non-empty string`, "invalid_field", 400);
  }
  return value;
}

function criteriaList(name: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((c) => typeof c !== "string" || c.trim() === "")) {
    throw new BatchError(`${name} must be a list of non-empty strings`, "invalid_field", 400);
  }
  return value.map((c: string) => c.trim().replace(/\s+/g, " "));
}

export function normaliseBatchInput(input: BatchInput, maxItems = batchMaxItems()): NormalisedBatch {
  const kind = input.kind;
  if (kind !== "fanout" && kind !== "multi_repo") {
    throw new BatchError("kind must be fanout or multi_repo", kind === undefined ? "missing_field" : "invalid_field", 400);
  }
  const title = text("title", input.title, true)!;
  const description = text("description", input.description, true)!;
  const riskLevel = input.riskLevel ?? "low";
  if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") {
    throw new BatchError("riskLevel must be low, medium or high", "invalid_field", 400);
  }
  const criteria = criteriaList("criteria", input.criteria) ?? [];

  const concurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!(typeof concurrency === "number" && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_CONCURRENCY_LIMIT)) {
    throw new BatchError(`maxConcurrency must be a whole number from 1 to ${MAX_CONCURRENCY_LIMIT}`, "invalid_concurrency", 422);
  }

  const cap = input.batchSpendCapUsd;
  if (cap !== undefined && cap !== null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) {
    throw new BatchError("batchSpendCapUsd must be a positive number of dollars", "invalid_field", 400);
  }
  if (input.uncappedConfirmed !== undefined && typeof input.uncappedConfirmed !== "boolean") {
    throw new BatchError("uncappedConfirmed must be true or false", "invalid_field", 400);
  }
  let rails;
  try {
    rails = batchRails({
      ...(cap !== undefined ? { spendCapUsd: cap } : {}),
      ...(input.uncappedConfirmed === true ? { uncappedConfirmed: true } : {}),
    });
  } catch (error) {
    if (error instanceof UncappedBatchError) throw new BatchError(error.message, "uncapped_batch", 422);
    throw error;
  }

  const ratio = input.stopOnFailureRatio ?? null;
  if (ratio !== null && !(typeof ratio === "number" && ratio > 0 && ratio <= 1)) {
    throw new BatchError("stopOnFailureRatio must be a number above 0 and at most 1, or null", "invalid_field", 400);
  }

  const childCap = input.spendCapUsd;
  if (childCap !== undefined && !(typeof childCap === "number" && Number.isFinite(childCap) && childCap > 0)) {
    throw new BatchError("spendCapUsd must be a positive number of dollars; runs are never uncapped here", "invalid_field", 400);
  }
  const wall = input.wallClockCapSeconds;
  if (wall !== undefined && !(typeof wall === "number" && Number.isInteger(wall) && wall > 0)) {
    throw new BatchError("wallClockCapSeconds must be a positive whole number of seconds", "invalid_field", 400);
  }

  let items: NormalisedBatch["items"];
  if (kind === "fanout") {
    const repositoryId = text("repositoryId", input.repositoryId, true)!;
    if (input.repositories !== undefined) {
      throw new BatchError("a fanout batch takes repositoryId and items, not repositories", "invalid_field", 400);
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BatchError("a fanout batch needs at least one item", "no_items", 422);
    }
    items = input.items.map((raw, i) => {
      const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const spec: BatchItemSpec = {
        title: text(`items[${i}].title`, item["title"], true)!,
        description: text(`items[${i}].description`, item["description"], true)!,
      };
      const own = criteriaList(`items[${i}].criteria`, item["criteria"]);
      if (own) spec.criteria = own;
      return { repositoryId, spec };
    });
  } else {
    if (input.items !== undefined || input.repositoryId !== undefined) {
      throw new BatchError("a multi_repo batch takes repositories, not repositoryId or items", "invalid_field", 400);
    }
    const repos = input.repositories;
    if (!Array.isArray(repos) || repos.length === 0) {
      throw new BatchError("a multi_repo batch needs at least one repository", "no_items", 422);
    }
    if (repos.some((r) => typeof r !== "string" || r.trim() === "")) {
      throw new BatchError("repositories must be a list of repository ids", "invalid_field", 400);
    }
    const unique = [...new Set(repos as string[])];
    if (unique.length !== repos.length) {
      throw new BatchError("repositories lists a repository twice", "duplicate_repository", 422);
    }
    items = unique.map((repositoryId) => ({ repositoryId, spec: {} }));
  }
  if (items.length > maxItems) {
    throw new BatchError(`a batch holds at most ${maxItems} items (got ${items.length})`, "too_many_items", 422, {
      maxItems,
    });
  }

  return {
    kind,
    title,
    description,
    template: {
      riskLevel,
      criteria,
      ...(childCap !== undefined ? { spendCapUsd: childCap } : {}),
      ...(wall !== undefined ? { wallClockCapSeconds: wall } : {}),
    },
    maxConcurrency: concurrency,
    batchSpendCapUsd: rails.batch_spend_cap_usd,
    stopOnFailureRatio: ratio,
    items,
  };
}
