"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../../../../lib/action-result.ts";
import { ApiError, batchLifecycle } from "../../../../lib/api.ts";

export async function changeBatch(batchId: string, action: "pause" | "resume" | "cancel"): Promise<ActionResult> {
  try {
    const answer = await batchLifecycle(batchId, action);
    revalidatePath(`/batches/${batchId}`);
    revalidatePath("/batches");
    const cancelled = "cancelled" in answer && Array.isArray(answer.cancelled) ? (answer.cancelled as unknown[]).length : 0;
    const message =
      action === "pause"
        ? "Paused. Runs already started carry on; nothing new starts."
        : action === "resume"
          ? "Resumed."
          : `Cancelled${cancelled ? `, and ${cancelled} running ${cancelled === 1 ? "child" : "children"} with it` : ""}.`;
    return { ok: true, message };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: err.message };
    return { ok: false, message: "Windkeel didn't answer clearly, so this may or may not have been applied. Refresh before trying again." };
  }
}
