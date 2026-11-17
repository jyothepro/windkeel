"use server";

import { redirect } from "next/navigation";
import { ApiError, createTask, loadModelPicker } from "../../../../lib/api.ts";
import { modelsFromForm } from "../../../../lib/model-picker.ts";

export type FileTaskState = { error: string | null; field: "change" | "repository" | "link" | "model" | null };

const RISK = new Set(["low", "medium", "high"]);
const TITLE_MAX = 80;

function titleFrom(change: string): string {
  const first = change.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length <= TITLE_MAX ? first : `${first.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export async function fileTask(_prev: FileTaskState, form: FormData): Promise<FileTaskState> {
  const change = String(form.get("change") ?? "").trim();
  const title = String(form.get("title") ?? "").trim() || titleFrom(change);
  const link = String(form.get("link") ?? "").trim();
  const repositoryId = String(form.get("repositoryId") ?? "");
  const risk = String(form.get("riskLevel") ?? "medium");
  const mode = form.get("mode");
  const playbook = String(form.get("playbook") ?? "").trim();

  if (!change) return { field: "change", error: "Say what should change. Windkeel takes its criteria from this." };
  if (!repositoryId) return { field: "repository", error: "Choose the repository to change." };
  if (link && !/^https:\/\/\S+$/.test(link)) return { field: "link", error: "Paste the full link, starting with https://." };
  const picked = form.has("model") ? modelsFromForm(form, await loadModelPicker()) : { models: null };
  if ("problem" in picked) return { field: "model", error: picked.problem };

  let runId: string;
  try {
    const res = await createTask({
      repositoryId,
      title,
      description: link ? `${change}\n\nRelated: ${link}` : change,
      riskLevel: RISK.has(risk) ? (risk as "low" | "medium" | "high") : undefined,
      ...(picked.models ? { models: picked.models } : {}),
      ...(mode === "pair" || mode === "autonomous" ? { mode } : {}),
      ...(playbook ? { playbook } : {}),
    });
    runId = res.engineeringRunId;
  } catch (err) {
    if (err instanceof ApiError) return { field: null, error: err.message };
    throw err;
  }
  redirect(`/runs/${runId}`);
}
