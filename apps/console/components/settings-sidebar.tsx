import { SECTION } from "../app/(settings)/settings/nav.ts";
import type { OrganizationView } from "../lib/types.ts";
import type { SETTINGS_TABS, SettingsTab } from "../lib/permissions.ts";
import { IconArrowLeft, IconBook, IconBot, IconChart, IconClock, IconCpu, IconKey, IconLock, IconPlug, IconPullRequest, IconShield, IconTasks, IconUser, IconUsers, IconWebhook } from "./icons.tsx";
import { NavLink } from "./nav-link.tsx";

export const SECTION_ICON: Record<SettingsTab, () => React.ReactNode> = {
  general: () => <IconUser />,
  tokens: () => <IconKey />,
  members: () => <IconUsers />,
  access: () => <IconLock />,
  models: () => <IconCpu />,
  integrations: () => <IconPlug />,
  schedules: () => <IconClock />,
  webhooks: () => <IconWebhook />,
  "service-principals": () => <IconBot />,
  merging: () => <IconPullRequest />,
  audit: () => <IconTasks />,
  roles: () => <IconShield />,
  knowledge: () => <IconBook />,
  playbooks: () => <IconTasks />,
  billing: () => <IconChart />,
};

export function SettingsSidebar({ tabs, org }: { tabs: typeof SETTINGS_TABS; org: OrganizationView | null }) {
  const group = (g: "personal" | "organization") => tabs.filter((t) => SECTION[t.tab].group === g);
  const row = (t: (typeof SETTINGS_TABS)[number]) => (
    <NavLink key={t.tab} href={`/settings/${t.tab}`}>
      {SECTION_ICON[t.tab]()}
      <span className="oq-nav-item__label">{t.label}</span>
    </NavLink>
  );
  return (
    <nav className="console-sidebar" aria-label="Settings">
      <div className="console-sidebar__top">
        <a className="oq-nav-item console-back" href="/runs">
          <IconArrowLeft />
          <span className="oq-nav-item__label">Back to the console</span>
        </a>
      </div>
      <div className="oq-nav-group">
        <div className="oq-nav-group__label">Personal</div>
        {group("personal").map(row)}
      </div>
      {group("organization").length ? (
        <div className="oq-nav-group">
          <div className="oq-nav-group__label">Organization</div>
          {org ? (
            <div className="oq-nav-item console-subnav__owner">
              <span className="console-org__mark" aria-hidden="true">
                {org.name.charAt(0).toUpperCase()}
              </span>
              <span className="oq-nav-item__label">{org.name}</span>
            </div>
          ) : null}
          <div className="console-subnav">{group("organization").map(row)}</div>
        </div>
      ) : null}
    </nav>
  );
}
