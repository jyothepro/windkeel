import { CommandPalette } from "../../components/command-palette.tsx";
import { LiveLists } from "../../components/live-lists.tsx";
import { ConnectionBanner } from "../../components/connection-banner.tsx";
import { DrawerBar } from "../../components/drawer.tsx";
import { Sidebar } from "../../components/sidebar.tsx";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="console-shell">
      <Sidebar />
      <LiveLists />
      <div className="console-page">
        <DrawerBar />
        <ConnectionBanner />
        {children}
      </div>
      <CommandPalette />
    </div>
  );
}
