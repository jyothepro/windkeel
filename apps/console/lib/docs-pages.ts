export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "links"; links: Array<{ href: string; label: string }> };

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  sections: Array<{ heading: string; blocks: DocBlock[] }>;
}

export const CONSOLE_ROUTES = ["/", "/runs", "/welcome", "/settings", "/settings/billing", "/settings/models", "/settings/access", "/settings/members"] as const;

export const DOC_PAGES: DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "From an invite code to your first verified pull request.",
    sections: [
      {
        heading: "1. Create your organization",
        blocks: [
          { kind: "p", text: "Sign in with GitHub. Windkeel is invite-only for now: the welcome page asks for the code you were sent, a name for your organization, and a plan." },
          { kind: "links", links: [{ href: "/welcome", label: "Open the welcome page" }, { href: "/docs/billing", label: "Plans and budgets" }] },
        ],
      },
      {
        heading: "2. Install the GitHub App",
        blocks: [
          { kind: "p", text: "Install Windkeel's GitHub App on the repositories you want it to work on. The repositories you choose become your organization's." },
          { kind: "links", links: [{ href: "/docs/github-app", label: "Installing the GitHub App" }] },
        ],
      },
      {
        heading: "3. File a first task",
        blocks: [
          { kind: "p", text: "Describe what done looks like, ideally as a checklist: each item becomes an acceptance criterion the verifier judges the change against." },
          { kind: "code", text: "Fix pagination's last page.\n\n- [ ] 11 items with page size 10 make 2 pages\n- [ ] page 2 shows item 11" },
        ],
      },
      {
        heading: "4. Watch it to a verdict",
        blocks: [
          { kind: "p", text: "The run page shows the agent working, then the verifier's evidence. A pass opens a pull request; a fail goes back for repair, with the evidence." },
          { kind: "links", links: [{ href: "/docs/verification", label: "How verification works" }, { href: "/runs", label: "Your runs" }] },
        ],
      },
    ],
  },
  {
    slug: "github-app",
    title: "Installing the GitHub App",
    summary: "How an installation becomes your organization's, and why GitHub asks you to authorize it.",
    sections: [
      {
        heading: "Install and link",
        blocks: [
          { kind: "p", text: "From the welcome page, choose Install the GitHub App. GitHub shows the repositories to install on, then asks you to authorize Windkeel: that is how Windkeel checks the installation is one you can reach before linking it to your organization." },
          { kind: "p", text: "An installation that already belongs to another Windkeel account is never linked from a link like this." },
        ],
      },
      {
        heading: "Which repositories",
        blocks: [
          { kind: "p", text: "Every repository of the installation that no other organization holds is granted to yours. Admins change grants under Repository access." },
          { kind: "links", links: [{ href: "/settings/access", label: "Repository access" }] },
        ],
      },
    ],
  },
  {
    slug: "verification",
    title: "How verification works",
    summary: "The independent verifier is the gate — budgets, plans and onboarding never go around it.",
    sections: [
      {
        heading: "A fresh, independent sandbox",
        blocks: [
          {
            kind: "list",
            items: [
              "Every candidate change is verified in a fresh sandbox the agent never touched (ADR-0004).",
              "The repository's own checks run there; a review comes from a model independent of the one that wrote the change.",
              "Each acceptance criterion is mapped to the evidence that proves it. The evidence package is sealed and can be verified offline.",
            ],
          },
        ],
      },
      {
        heading: "Nothing goes out unverified",
        blocks: [
          { kind: "p", text: "A pull request is opened only for a pass (or a warn a person acknowledged). There is no setting, plan or budget that skips verification (ADR-0029)." },
          { kind: "p", text: "If your monthly budget runs out mid-run, a verification already under way still finishes and its verdict stands; Windkeel stops before the next agent turn and refuses new runs." },
          { kind: "links", links: [{ href: "/docs/billing", label: "Budgets and billing" }] },
        ],
      },
    ],
  },
  {
    slug: "billing",
    title: "Budgets and billing",
    summary: "Two plans, metered from the cost ledger, with a monthly budget.",
    sections: [
      {
        heading: "Plans",
        blocks: [
          {
            kind: "list",
            items: [
              "BYOK — bring your own model keys. Your model provider bills you for AI; Windkeel bills the compute fee (sandbox and verification time). A role you have not added a key for runs on Windkeel's models, and that role's AI cost is billed as on Managed — Settings → Billing shows it as its own line.",
              "Managed — Windkeel supplies the models. Windkeel bills AI cost plus the compute fee.",
            ],
          },
          { kind: "p", text: "Usage comes from Windkeel's cost ledger: every model call and sandbox minute, recorded where Windkeel makes it. Spend on your own keys is shown and never billed. Calls on a model with no known price are counted, not billed. Verification is metered like everything else and is never waived." },
        ],
      },
      {
        heading: "Your monthly budget",
        blocks: [
          { kind: "p", text: "An admin sets it under Settings → Billing. When it is spent, new runs are refused and running runs stop before their next agent turn — after finishing any verification already under way." },
          { kind: "links", links: [{ href: "/settings/billing", label: "Settings → Billing" }, { href: "/docs/byok", label: "Bringing your own keys" }] },
        ],
      },
    ],
  },
  {
    slug: "byok",
    title: "Bringing your own model keys",
    summary: "Use your own provider account for the maker and the checker.",
    sections: [
      {
        heading: "Adding a key",
        blocks: [
          { kind: "p", text: "Admins add keys under Settings → Models. Keys are sealed when stored and opened only where a run uses them; the console never shows one again." },
          { kind: "p", text: "The checker must not be the same vendor as the maker, so the review stays independent." },
          { kind: "links", links: [{ href: "/settings/models", label: "Settings → Models" }] },
        ],
      },
    ],
  },
  {
    slug: "cli",
    title: "The command line",
    summary: "The published windkeel CLI: submit work, follow runs, read usage.",
    sections: [
      {
        heading: "Common commands",
        blocks: [
          { kind: "code", text: "npm i -g windkeel\nwindkeel login --url https://<your deployment>\nwindkeel submit --repo owner/name --title \"…\" --description @task.md\nwindkeel watch <run-id>\nwindkeel usage --period 2026-10" },
          { kind: "links", links: [{ href: "/docs/getting-started", label: "Getting started" }] },
        ],
      },
    ],
  },
];

export function docPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((p) => p.slug === slug);
}

export function brokenLinks(pages: readonly DocPage[] = DOC_PAGES): string[] {
  const slugs = new Set(pages.map((p) => `/docs/${p.slug}`));
  const known = new Set<string>([...slugs, "/docs", ...CONSOLE_ROUTES]);
  const broken: string[] = [];
  for (const page of pages) {
    for (const section of page.sections) {
      for (const block of section.blocks) {
        if (block.kind !== "links") continue;
        for (const link of block.links) if (link.href.startsWith("/") && !known.has(link.href)) broken.push(`${page.slug} → ${link.href}`);
      }
    }
  }
  return broken;
}
