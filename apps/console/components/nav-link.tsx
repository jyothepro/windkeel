"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  exact,
  title,
  className = "oq-nav-item",
  children,
}: {
  href: string;
  exact?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const current = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link className={className} href={href} title={title} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
