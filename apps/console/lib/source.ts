export type SourceKind = "github" | "slack" | "linear" | "jira" | "schedule" | "webhook" | "batch" | "api" | "local" | "other";

export interface SourceView {
  kind: SourceKind;
  label: string;
  detail: string | null;
  href: string | null;
  external: boolean;
}

const LABEL: Record<SourceKind, string> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  jira: "Jira",
  schedule: "Schedule",
  webhook: "Webhook",
  batch: "Batch",
  api: "API",
  local: "Local",
  other: "Other",
};

export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function linearUrl(raw: unknown): string | null {
  const url = safeHttpsUrl(raw);
  if (!url) return null;
  const host = new URL(url).hostname;
  return host === "linear.app" || host.endsWith(".linear.app") ? url : null;
}

export function describeSource(
  task: { sourceType: string; sourceReference: string; sourceContext?: Record<string, unknown> | null },
  openable: readonly string[] = [],
): SourceView {
  const ctx = task.sourceContext ?? {};
  const view = (kind: SourceKind, detail: string | null, href: string | null, external = href !== null): SourceView => ({
    kind,
    label: LABEL[kind],
    detail,
    href,
    external,
  });

  switch (task.sourceType) {
    case "github_issue": {
      const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(task.sourceReference);
      return view("github", task.sourceReference || null, m ? `https://github.com/${m[1]}/issues/${m[2]}` : null);
    }
    case "slack": {
      const team = str(ctx["teamId"]);
      const channel = str(ctx["channelId"]);
      const href = team && channel ? `https://slack.com/app_redirect?team=${encodeURIComponent(team)}&channel=${encodeURIComponent(channel)}` : null;
      return view("slack", channel ? `#${channel}` : null, href);
    }
    case "linear": {
      return view("linear", str(ctx["identifier"]), linearUrl(ctx["url"]));
    }
    case "jira": {
      const key = str(ctx["issueKey"]);
      const site = safeHttpsUrl(ctx["siteUrl"]);
      const href = key && site && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? `${new URL(site).origin}/browse/${key}` : null;
      return view("jira", key, href);
    }
    case "schedule":
      return view("schedule", null, openable.includes("schedules") ? "/settings/schedules" : null, false);
    case "webhook":
      return view("webhook", null, openable.includes("webhooks") ? "/settings/webhooks" : null, false);
    case "batch": {
      const batchId = str(ctx["batchId"]);
      const ok = batchId !== null && /^[0-9a-f-]{36}$/i.test(batchId);
      return view("batch", null, ok ? `/batches/${batchId}` : null, false);
    }
    case "api":
      return view("api", null, null);
    case "local":
      return view("local", null, null);
    default:
      return { ...view("other", task.sourceType || null, null), label: task.sourceType || LABEL.other };
  }
}
