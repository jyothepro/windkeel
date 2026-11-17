import type { SettingsTab } from "../../../lib/permissions.ts";

export const SECTION: Record<SettingsTab, { group: "personal" | "organization"; blurb: (org: string) => string }> = {
  general: { group: "personal", blurb: () => "Who you're signed in as, the connection, and the theme." },
  tokens: { group: "personal", blurb: () => "Tokens that act as you, for CI and scripts." },
  members: { group: "organization", blurb: (org) => `Who's in ${org}, their roles, and who's invited.` },
  access: { group: "organization", blurb: (org) => `The repositories ${org} can work on, and which one takes intake.` },
  models: { group: "organization", blurb: (org) => `The model keys ${org} brings, which models make and check its work, and its presets.` },
  integrations: { group: "organization", blurb: (org) => `Slack, Linear, Jira and Sentry workspaces connected to ${org}, and which repository their work goes to.` },
  schedules: { group: "organization", blurb: () => "Work that starts itself, on a cron." },
  webhooks: { group: "organization", blurb: () => "Signed URLs any system can call to start a task, without a Windkeel token." },
  "service-principals": { group: "organization", blurb: (org) => `Identities that automations act as in ${org}, and their tokens — never a person's.` },
  merging: { group: "organization", blurb: (org) => `Whether ${org} allows merging from Windkeel, and the GitHub authorization you merge with.` },
  audit: { group: "organization", blurb: (org) => `Who did what in ${org}, when and from where — filterable, exportable, and tamper-evident.` },
  roles: { group: "organization", blurb: () => "Roles of your own for the whole account, made from permissions you hold." },
  knowledge: { group: "organization", blurb: (org) => `Notes the maker is given on every repository ${org} works on. It shapes the maker, never the verifier.` },
  playbooks: { group: "organization", blurb: (org) => `Kinds of work ${org} reuses: instructions for the maker, and checks that only ever add to verification.` },
  billing: { group: "organization", blurb: (org) => `What ${org} used this month, its monthly budget, and its plan.` },
};
