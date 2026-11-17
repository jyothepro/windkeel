import { unstable_rethrow } from "next/navigation";
import { CommandPalette } from "../../components/command-palette.tsx";
import { ConnectionBanner } from "../../components/connection-banner.tsx";
import { SettingsSidebar } from "../../components/settings-sidebar.tsx";
import { currentOrganization, getIdentity } from "../../lib/api.ts";
import { SETTINGS_TABS, visibleTabs } from "../../lib/permissions.ts";
import type { OrganizationView } from "../../lib/types.ts";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  let tabs = SETTINGS_TABS.filter((t) => t.needs === null);
  let org: OrganizationView | null = null;
  try {
    const identity = await getIdentity();
    org = await currentOrganization(identity);
    tabs = visibleTabs(org?.permissions ?? [], identity.accountRole?.permissions ?? []);
  } catch (err) {
    unstable_rethrow(err);
  }
  return (
    <div className="console-shell">
      <SettingsSidebar tabs={tabs} org={org} />
      <div className="console-page">
        <ConnectionBanner />
        {children}
      </div>
      <CommandPalette />
    </div>
  );
}
