import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { currentOrganization, getIdentity } from "../../../../lib/api.ts";
import { SETTINGS_TABS, visibleTabs } from "../../../../lib/permissions.ts";
import { SECTION } from "../nav.ts";
import { Models } from "../model-sections.tsx";
import { Merging } from "../merge-sections.tsx";
import { OrganizationKnowledge } from "../knowledge-sections.tsx";
import { Playbooks } from "../playbook-sections.tsx";
import { Billing } from "../billing-sections.tsx";
import { Access, General, Integrations, Members, PersonalTokens, Schedules, ServicePrincipals, Webhooks } from "../sections.tsx";
import { AuditLog, Roles } from "../audit-sections.tsx";

type Props = {
  params: Promise<{ section: string }>;
  searchParams?: Promise<{ github?: string; action?: string; after?: string; before?: string; cursor?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params;
  const tab = SETTINGS_TABS.find((t) => t.tab === section);
  return { title: tab ? `${tab.label} · Settings` : "Settings" };
}

export default async function SettingsSection({ params, searchParams }: Props) {
  const { section } = await params;
  const search = (await searchParams) ?? {};
  const identity = await getIdentity();
  const org = await currentOrganization(identity);
  const tab = visibleTabs(org?.permissions ?? [], identity.accountRole?.permissions ?? []).find((t) => t.tab === section);
  if (!tab) notFound();

  return (
    <main className="console-main">
      <header className="console-header">
        <div>
          <h1>{tab.label}</h1>
          <p className="console-header__sub">{SECTION[tab.tab].blurb(org?.name ?? "your organization")}</p>
        </div>
      </header>
      {tab.tab === "general" ? <General identity={identity} /> : null}
      {tab.tab === "tokens" ? <PersonalTokens identity={identity} /> : null}
      {tab.tab === "members" && org ? <Members org={org} /> : null}
      {tab.tab === "access" && org ? <Access org={org} /> : null}
      {tab.tab === "models" && org ? <Models org={org} /> : null}
      {tab.tab === "integrations" && org ? <Integrations org={org} /> : null}
      {tab.tab === "schedules" && org ? <Schedules org={org} /> : null}
      {tab.tab === "webhooks" && org ? <Webhooks org={org} /> : null}
      {tab.tab === "service-principals" && org ? <ServicePrincipals org={org} /> : null}
      {tab.tab === "merging" && org ? <Merging org={org} outcome={search.github} /> : null}
      {tab.tab === "audit" && org ? <AuditLog org={org} filter={search} accountHeld={identity.accountRole?.permissions ?? []} /> : null}
      {tab.tab === "roles" && org ? <Roles held={identity.accountRole?.permissions ?? []} /> : null}
      {tab.tab === "knowledge" && org ? <OrganizationKnowledge org={org} /> : null}
      {tab.tab === "playbooks" && org ? <Playbooks org={org} /> : null}
      {tab.tab === "billing" && org ? <Billing org={org} /> : null}
    </main>
  );
}
