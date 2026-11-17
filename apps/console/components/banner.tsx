import { IconAgent, IconInfo, IconWarning } from "./icons.tsx";

type Intent = "info" | "warning" | "danger" | "agent" | "success";

export function Banner({
  intent = "info",
  title,
  children,
  actions,
}: {
  intent?: Intent;
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const Icon = intent === "agent" ? IconAgent : intent === "warning" || intent === "danger" ? IconWarning : IconInfo;
  return (
    <div className="oq-banner" data-intent={intent} role="status">
      <Icon />
      <div>
        <strong className="oq-banner__title">{title}</strong>
        {children ? <div className="oq-banner__body">{children}</div> : null}
      </div>
      <div className="oq-banner__actions">{actions}</div>
    </div>
  );
}

export function ApiGap({ gap, title, children }: { gap: string; title: string; children: React.ReactNode }) {
  return (
    <Banner intent="info" title={title}>
      {children} <span className="oq-muted">Gap {gap} in docs/ui/console-ux.md.</span>
    </Banner>
  );
}
