import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SECTION_ICON } from "../../../components/settings-sidebar.tsx";
import { IconChevronRight } from "../../../components/icons.tsx";
import { currentOrganization, getIdentity } from "../../../lib/api.ts";
import { visibleTabs } from "../../../lib/permissions.ts";
import { SECTION } from "./nav.ts";
import { article, roleName } from "./sections.tsx";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsIndex({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const legacy = (await searchParams).tab;
  const identity = await getIdentity();
  const org = await currentOrganization(identity);
  const tabs = visibleTabs(org?.permissions ?? [], identity.accountRole?.permissions ?? []);
  if (legacy && tabs.some((t) => t.tab === legacy)) redirect(`/settings/${legacy}`);

  const orgName = org?.name ?? "your organization";
  const card = (group: "personal" | "organization") => {
    const rows = tabs.filter((t) => SECTION[t.tab].group === group);
    if (rows.length === 0) return null;
    return (
      <ul className="console-rows">
        {rows.map((t) => (
          <li key={t.tab}>
            <a className="console-rows__link" href={`/settings/${t.tab}`}>
              <span className="console-rows__icon">{SECTION_ICON[t.tab]()}</span>
              <span className="console-rows__main">
                <span className="console-rows__title">{t.label}</span>
                <span className="console-rows__sub">{SECTION[t.tab].blurb(orgName)}</span>
              </span>
              <IconChevronRight />
            </a>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <main className="console-main">
      <header className="console-header">
        <div>
          <h1>Settings</h1>
          <p className="console-header__sub">
            Signed in as {identity.principal.displayName}
            {org ? ` · ${article(roleName(org.role))} ${roleName(org.role)} in ${org.name}` : ""}
          </p>
        </div>
      </header>
      <section className="console-section">
        <h2>Personal</h2>
        {card("personal")}
      </section>
      {tabs.some((t) => SECTION[t.tab].group === "organization") ? (
        <section className="console-section">
          <h2>{org?.name ?? "Organization"}</h2>
          {card("organization")}
        </section>
      ) : null}
    </main>
  );
}
