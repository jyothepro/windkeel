import { isTodo, site } from "../site.config.ts";
import { ConfigLink } from "./external-link.tsx";
import { Wordmark } from "./logo.tsx";

const RESOURCE_LINKS = [
  { label: "Docs", href: site.docsUrl },
  { label: "GitHub", href: site.githubUrl },
  { label: "Status", href: site.statusUrl },
];

const linkClass = "inline-flex min-h-11 items-center text-sm text-muted hover:text-fg";

export function Footer() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-line">
      <div className="waterline" aria-hidden="true" />
      <div className="container-page grid gap-10 py-12 md:grid-cols-[1fr_auto]">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-xs text-sm text-muted">Agent-written pull requests, independently verified.</p>
          <p className="mt-6 text-sm text-muted">© {year} Windkeel</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 sm:grid-cols-3">
          <ul>
            <li>
              <a href="/#how-it-works" className={linkClass}>How it works</a>
            </li>
            <li>
              <a href="/#pricing" className={linkClass}>Pricing</a>
            </li>
            <li>
              <a href="/request-access" className={linkClass}>Request access</a>
            </li>
          </ul>
          <ul>
            {RESOURCE_LINKS.filter((link) => !isTodo(link.href)).map((link) => (
              <li key={link.label}>
                <ConfigLink href={link.href} label={link.label} className={linkClass} />
              </li>
            ))}
          </ul>
          <ul>
            <li>
              <a href="/privacy" className={linkClass}>Privacy</a>
            </li>
            <li>
              <a href="/terms" className={linkClass}>Terms</a>
            </li>
            {isTodo(site.contactEmail) ? null : (
              <li>
                <a href={`mailto:${site.contactEmail}`} className={linkClass}>Contact</a>
              </li>
            )}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
