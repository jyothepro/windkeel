export function lastOutcomeText(outcome: string | null): { text: string; intent: "neutral" | "success" | "warning" | "danger" } {
  if (outcome === null) return { text: "Hasn't fired yet", intent: "neutral" };
  if (outcome === "created") return { text: "Filed a task", intent: "success" };
  if (outcome === "existing") return { text: "Found the task it had already filed", intent: "success" };
  if (outcome === "duplicate") return { text: "Already handled", intent: "neutral" };
  const [kind, detail = ""] = outcome.split(":", 2) as [string, string | undefined];
  if (kind === "ignored") {
    const why: Record<string, string> = {
      previous_run_in_flight: "Skipped: its previous run is still open",
      previous_run_requeued: "Restarted its previous run, which had never started",
      coalesced: "Skipped: caught up after downtime",
      repository_not_granted: "Skipped: the repository is no longer granted",
    };
    return { text: why[detail] ?? `Skipped: ${detail.replace(/_/g, " ")}`, intent: detail === "repository_not_granted" ? "danger" : "warning" };
  }
  if (kind === "failed") return { text: `Failed${detail ? ` (${detail})` : ""} five times; that slot was given up`, intent: "danger" };
  return { text: outcome, intent: "neutral" };
}
