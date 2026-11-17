import { refusalText } from "./refusals.ts";

export function installOutcome(search: { installed?: string; install_error?: string }): { intent: "success" | "danger"; text: string } | null {
  if (search.installed) return { intent: "success", text: "The GitHub App is installed and linked. Its repositories are this organization's now." };
  if (search.install_error) {
    const code = search.install_error.replace(/[^a-z_]/g, "").slice(0, 40);
    return { intent: "danger", text: refusalText(code, "GitHub didn't send the installation back. Start the installation again from here.") };
  }
  return null;
}

export function installReturn(outcome: { ok: true } | { ok: false; code: string }): string {
  return outcome.ok ? "/welcome?installed=1" : `/welcome?install_error=${encodeURIComponent(outcome.code.replace(/[^a-z_]/g, "").slice(0, 40) || "failed")}`;
}
