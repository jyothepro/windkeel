import type { Metadata } from "next";
import "../../../design/windkeel.css";
import "./console.css";

export const metadata: Metadata = {
  title: { default: "Windkeel", template: "%s · Windkeel" },
  robots: { index: false },
};

export const dynamic = "force-dynamic";

const THEME_BOOT = `try{var t=localStorage.getItem("windkeel-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
