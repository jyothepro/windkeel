import { isTodo } from "../site.config.ts";
import { Todo } from "./todo.tsx";

export function ConfigLink({
  href,
  label,
  className,
  compact = false,
}: {
  href: string;
  label: string;
  className?: string;
  compact?: boolean;
}) {
  if (isTodo(href) && compact) {
    return (
      <span className={className} title={`${label} URL not set yet`}>
        {label}
        <span className="todo ml-1.5 text-[0.6875rem]">TODO</span>
      </span>
    );
  }
  if (isTodo(href)) {
    return (
      <span className={className}>
        {label} <Todo>{label.toLowerCase()} URL</Todo>
      </span>
    );
  }
  return (
    <a href={href} className={className}>
      {label}
    </a>
  );
}
