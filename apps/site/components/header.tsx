import { site } from "../site.config.ts";
import { DesktopNav } from "./desktop-nav.tsx";
import { Wordmark } from "./logo.tsx";
import { MobileMenu } from "./mobile-menu.tsx";
import { ThemeToggle } from "./theme.tsx";

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md supports-[not(backdrop-filter:blur(1px))]:bg-canvas">
      <div className="container-page flex h-16 items-center gap-4">
        <a href="/" className="-ml-1 flex min-h-11 items-center rounded-md px-1" aria-label="Windkeel home">
          <Wordmark />
        </a>
        <div className="hidden flex-1 xl:flex">
          <DesktopNav />
        </div>
        <div className="ml-auto flex items-center gap-2 xl:ml-0">
          <ThemeToggle />
          <a href={site.appUrl} className="btn btn-ghost hidden xl:inline-flex">
            Sign in
          </a>
          <a href="/request-access" className="btn btn-primary hidden sm:inline-flex">
            Request access
          </a>
          <div className="xl:hidden">
            <MobileMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
