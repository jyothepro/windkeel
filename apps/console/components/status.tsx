import type { Dot } from "../lib/run-states.ts";

export function StatusDot({ dot, children, dotOnly, decorative }: { dot: Dot; children?: React.ReactNode; dotOnly?: boolean; decorative?: boolean }) {
  const mark = dot === "queued" || dot === "waiting" ? { "data-run": dot } : { "data-verdict": dot };
  if (decorative) return <span className="oq-status oq-status--dot-only" {...mark} aria-hidden="true" />;
  if (dotOnly) return <span className="oq-status oq-status--dot-only" {...mark} role="img" aria-label={String(children ?? dot)} />;
  return (
    <span className="oq-status" {...mark}>
      {children ?? dot}
    </span>
  );
}

export type Intent = "neutral" | "accent" | "agent" | "success" | "warning" | "danger" | "info";

export function Badge({
  intent = "neutral",
  solid,
  small,
  children,
}: {
  intent?: Intent;
  solid?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  const cls = ["oq-badge", solid && "oq-badge--solid", small && "oq-badge--sm"].filter(Boolean).join(" ");
  return (
    <span className={cls} data-intent={intent}>
      {children}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: "pass" | "warn" | "fail" | null }) {
  if (verdict === null) return <Badge>no verdict</Badge>;
  const intent: Intent = verdict === "pass" ? "success" : verdict === "fail" ? "danger" : "warning";
  return (
    <Badge intent={intent} solid>
      {verdict === "pass" ? "Pass" : verdict === "fail" ? "Fail" : "Warn"}
    </Badge>
  );
}
