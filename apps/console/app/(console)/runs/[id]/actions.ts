"use server";

import { revalidatePath } from "next/cache";
import {
  ApiError,
  approveRun,
  cancelRun,
  createRun,
  handBackRun,
  loadModelPicker,
  mergeRun,
  openWorkspaceSession,
  sendGuidance,
  submitRun,
  takeoverRun,
} from "../../../../lib/api.ts";
import { modelsFromForm } from "../../../../lib/model-picker.ts";

export type CommandResult = { ok: true; runId?: string } | { ok: false; code: string; message: string };

async function command(runId: string, fn: () => Promise<{ engineeringRunId?: string }>): Promise<CommandResult> {
  try {
    const res = await fn();
    revalidatePath(`/runs/${runId}`);
    return { ok: true, runId: res.engineeringRunId };
  } catch (err) {
    if (err instanceof ApiError && (err.status < 500 || err.code.startsWith("api_"))) return { ok: false, code: err.code, message: err.message };
    return {
      ok: false,
      code: err instanceof ApiError ? err.code : "unreachable",
      message: "Windkeel didn't answer clearly, so this may or may not have been applied. Refresh to see the run's state before trying again.",
    };
  }
}

export async function approve(runId: string): Promise<CommandResult> {
  return command(runId, () => approveRun(runId));
}

export async function cancel(runId: string, reason: string): Promise<CommandResult> {
  return command(runId, () => cancelRun(runId, reason || undefined));
}

export async function guide(runId: string, message: string): Promise<CommandResult> {
  return command(runId, () => sendGuidance(runId, message));
}

export async function runAgain(runId: string, taskId: string): Promise<CommandResult> {
  return command(runId, () => createRun(taskId));
}

export async function runAgainWith(runId: string, taskId: string, form: FormData): Promise<CommandResult> {
  const picked = modelsFromForm(form, await loadModelPicker(), { rerun: true });
  if ("problem" in picked) return { ok: false, code: "invalid_models", message: picked.problem };
  return command(runId, () => createRun(taskId, picked.models ?? undefined));
}

export async function takeOver(runId: string): Promise<CommandResult> {
  return command(runId, () => takeoverRun(runId));
}

export async function submit(runId: string): Promise<CommandResult> {
  return command(runId, () => submitRun(runId));
}

export async function handBack(runId: string): Promise<CommandResult> {
  return command(runId, () => handBackRun(runId));
}

export async function openWorkspace(runId: string): Promise<{ ok: true; url: string } | { ok: false; code: string; message: string }> {
  try {
    const res = await openWorkspaceSession(runId);
    if (typeof res.url !== "string" || !res.url.startsWith("https://")) {
      return { ok: false, code: "bad_workspace_url", message: "Windkeel answered without a workspace address. Try again in a moment." };
    }
    return { ok: true, url: res.url };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: "unreachable", message: "Windkeel didn't answer. Try again in a moment." };
  }
}

export async function mergePullRequest(runId: string, form: FormData): Promise<CommandResult> {
  const acknowledgements = form.getAll("ack").map(String);
  const markReady = form.get("markReady") === "true";
  const mergeMethod = String(form.get("mergeMethod") ?? "squash");
  return command(runId, () => mergeRun(runId, { acknowledgements, markReady, mergeMethod }));
}
