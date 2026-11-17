"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "../../../lib/action-result.ts";
import { ApiError, createTask, installLink, signUp } from "../../../lib/api.ts";
import { refusalText } from "../../../lib/refusals.ts";

const refused = (err: unknown): ActionResult => {
  if (err instanceof ApiError) return { ok: false, message: refusalText(err.code, err.message) };
  throw err;
};

export async function createOrganization(form: FormData): Promise<ActionResult> {
  const plan = form.get("plan") === "byok" ? "byok" : "managed";
  try {
    await signUp({
      inviteCode: String(form.get("inviteCode") ?? "").trim(),
      organizationName: String(form.get("organizationName") ?? "").trim(),
      plan,
    });
  } catch (err) {
    return refused(err);
  }
  redirect("/welcome?step=install");
}

export async function startInstall(orgId: string): Promise<ActionResult> {
  let url: string;
  try {
    url = await installLink(orgId);
  } catch (err) {
    return refused(err);
  }
  redirect(url);
}

export async function startFirstTask(form: FormData): Promise<ActionResult> {
  const repositoryId = String(form.get("repositoryId") ?? "");
  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  if (!repositoryId) return { ok: false, message: "Pick the repository the task is for." };
  if (!title || !description) return { ok: false, message: "Give the task a title and say what done looks like." };
  let runId: string;
  try {
    const accepted = await createTask({ repositoryId, title, description });
    runId = String(accepted.engineeringRunId);
  } catch (err) {
    return refused(err);
  }
  redirect(`/runs/${encodeURIComponent(runId)}`);
}
