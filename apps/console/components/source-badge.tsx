import { describeSource } from "../lib/source.ts";
import { playbookBadge, type PlaybookSnapshot } from "../lib/playbooks.ts";
import { IconExternal } from "./icons.tsx";
import { Badge } from "./status.tsx";

export function SourceBadge({
  task,
  withDetail = true,
  link = true,
  openable,
}: {
  task: { sourceType: string; sourceReference: string; sourceContext?: Record<string, unknown> | null };
  withDetail?: boolean;
  link?: boolean;
  openable?: readonly string[];
}) {
  const s = describeSource(task, openable);
  const badge = (
    <Badge small intent={s.kind === "schedule" || s.kind === "webhook" ? "agent" : "neutral"}>
      {s.label}
    </Badge>
  );
  const detail = withDetail && s.detail ? <span className="oq-mono">{s.detail}</span> : null;
  if (!s.href || !link) {
    return (
      <span className="console-source" data-source={s.kind}>
        {badge}
        {detail}
      </span>
    );
  }
  return (
    <a
      className="console-source console-source--link"
      data-source={s.kind}
      href={s.href}
      {...(s.external ? { target: "_blank", rel: "noreferrer" } : {})}
      title={s.external ? `Open in ${s.label}` : undefined}
    >
      {badge}
      {detail}
      {s.external ? <IconExternal small /> : null}
    </a>
  );
}

export function PlaybookBadge({ playbook }: { playbook?: PlaybookSnapshot | null }) {
  const label = playbookBadge(playbook);
  if (!label) return null;
  return (
    <span className="console-source" data-playbook={playbook!.slug}>
      <Badge small intent="neutral">
        {label}
      </Badge>
    </span>
  );
}
