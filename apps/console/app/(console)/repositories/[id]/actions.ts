"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../../../../lib/action-result.ts";
import { ApiError, invalidateRepositoryEnvironment, rebuildRepositoryEnvironment } from "../../../../lib/api.ts";
import { refusalText } from "../../../../lib/refusals.ts";

async function run(form: FormData, fn: (repositoryId: string) => Promise<void>): Promise<ActionResult> {
  const repositoryId = String(form.get("repositoryId") ?? "");
  if (!repositoryId) return { ok: false, message: "No repository." };
  try {
    await fn(repositoryId);
    revalidatePath(`/repositories/${repositoryId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: refusalText(err.code, err.message) };
    throw err;
  }
}

export async function rebuildEnvironment(form: FormData): Promise<ActionResult> {
  return run(form, rebuildRepositoryEnvironment);
}

export async function invalidateEnvironment(form: FormData): Promise<ActionResult> {
  return run(form, invalidateRepositoryEnvironment);
}
