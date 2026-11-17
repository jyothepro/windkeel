import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata, Viewport } from "next";
import { Footer } from "../components/footer.tsx";
import { Header } from "../components/header.tsx";
import { AgentBridge, Toaster } from "../components/site-chrome.tsx";
import { ThemePreferences } from "../components/theme.tsx";
import { site } from "../site.config.ts";
import { geistMono, geistSans } from "./fonts.ts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: "Windkeel: independently verified agent pull requests", template: "%s · Windkeel" },
  description: site.description,
  applicationName: site.name,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: site.name,
    url: site.url,
    title: "Windkeel: independently verified agent pull requests",
    description: site.description,
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f9fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1116" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        <ThemePreferences>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <Header />
          <main id="main" tabIndex={-1} className="focus:outline-none">
            {children}
          </main>
          <Footer />
          <Toaster />
          <AgentBridge />
        </ThemePreferences>
        {process.env.VERCEL ? (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        ) : null}
      </body>
    </html>
  );
}
