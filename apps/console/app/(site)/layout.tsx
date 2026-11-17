import type { Metadata } from "next";
import Link from "next/link";
import { REPOSITORY_URL, inviteRequestUrl } from "../../lib/site.ts";
import "./site.css";

export const metadata: Metadata = {
  robots: { index: true, follow: true },
  description: "An independent verifier for AI-written pull requests. Run the gate in your CI, or use a managed factory that turns tasks into verified draft pull requests.",
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="site">
      <header className="site-header">
        <Link href="/home" className="site-brand">
          <span className="console-mark" aria-hidden="true" />
          Windkeel
        </Link>
        <nav className="site-nav" aria-label="Site">
          <Link href="/docs">Docs</Link>
          <Link href="/pricing">Pricing</Link>
          <a href={REPOSITORY_URL}>GitHub</a>
          <Link href="/login">Sign in</Link>
          <a className="oq-button oq-button--primary oq-button--sm" href={inviteRequestUrl()}>
            Request an invite
          </a>
        </nav>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <span>Windkeel. Source-available under PolyForm Noncommercial 1.0.0.</span>
        <nav className="site-nav" aria-label="Footer">
          <a href={REPOSITORY_URL}>Source</a>
          <a href={`${REPOSITORY_URL}/blob/main/SECURITY.md`}>Security</a>
          <a href={`${REPOSITORY_URL}/blob/main/COMMERCIAL.md`}>Commercial use</a>
          <Link href="/docs">Docs</Link>
          <Link href="/pricing">Pricing</Link>
        </nav>
      </footer>
    </div>
  );
}
