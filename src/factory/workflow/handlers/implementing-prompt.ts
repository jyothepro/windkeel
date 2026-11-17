
import { playbookCriteria, type PlaybookSnapshot } from "../../playbooks.js";

export interface MakerPromptBrowser {

  helper?: string | undefined;
  startCommand?: string | undefined;
  port?: number | undefined;
}

export function buildMakerPrompt(
  task: {
    title: string;
    description: string;
    acceptanceCriteria: Array<{ id: string; text: string }>;
    playbook?: PlaybookSnapshot | null;
  },

  knowledge?: string,

  browser?: MakerPromptBrowser,
): string {
  const all = [
    ...task.acceptanceCriteria,
    ...playbookCriteria(task.playbook),
  ];
  const criteria = all.length
    ? all.map((c) => `- [${c.id}] ${c.text}`).join("\n")
    : "- (none stated; satisfy the description)";
  const playbook = task.playbook
    ? [`## Playbook: ${task.playbook.slug} (v${task.playbook.version})`, task.playbook.makerInstructions.trim(), ""]
    : [];
  return [
    `# ${task.title}`,
    "",
    task.description,
    "",
    ...(knowledge ? [knowledge, ""] : []),
    ...playbook,
    "## Acceptance criteria",
    criteria,
    "",
    "Make the change in this checkout. Run the repository's own tests before you finish.",
    ...(browser ? ["", ...browserSection(browser)] : []),
  ].join("\n");
}

function browserSection(browser: MakerPromptBrowser): string[] {
  const helper = browser.helper ?? "windkeel-browse";
  const port = browser.port ?? 3000;
  const start = browser.startCommand
    ? `Start the app with \`${helper} serve --port ${port} -- ${browser.startCommand}\` (it waits for the port), then look at it.`
    : `Start the app's dev server in the background with \`${helper} serve --port <port> -- <command...>\`, then look at it.`;
  return [
    "## Browser",
    "You have a headless browser for checking UI work as you go.",
    start,
    `- \`${helper} screenshot http://localhost:${port}/ --name home\` saves a PNG under \`.windkeel/browser/\` and prints the page title, HTTP status and any console errors.`,
    "- Options: `--full-page`, `--wait-for <css selector>`, `--viewport 1280x800`.",
    "- Only local pages (http on localhost, 127.0.0.1, 0.0.0.0) can be opened; the internet is not reachable.",
    "- Screenshots are for your own self-checking and are shown to people as unverified maker screenshots. " +
      "They are not verification evidence: an independent verifier checks the change afterwards. " +
      "Never commit `.windkeel/browser/`.",
  ];
}
