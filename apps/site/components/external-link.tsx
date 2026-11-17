import { isTodo } from "../site.config.ts";

export function ConfigLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  className?: string;
}) {
  if (isTodo(href)) return null;
  return (
    <a href={href} className={className}>
      {label}
    </a>
  );
}
