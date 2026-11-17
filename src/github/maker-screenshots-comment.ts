import type { CommentLike } from "./summary.js";
import { COMMENT_LIMIT, plain } from "./summary.js";

export function makerScreenshotsMarker(engineeringRunId: string): string {
  return `<!-- windkeel:maker-screenshots:${engineeringRunId} -->`;
}

export function findMakerScreenshotsComment<T extends CommentLike>(
  comments: readonly T[],
  engineeringRunId: string,
): T | undefined {
  const marker = makerScreenshotsMarker(engineeringRunId);
  return comments.find((comment) => comment.body.includes(marker));
}

export interface MakerScreenshotLine {
  name: string | null;
  url: string | null;
  pageTitle: string | null;
  consoleErrors: string[];
}

function cell(text: string | null, max: number): string {
  const clean = plain((text ?? "").slice(0, max))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([[\]!])/g, "\\$1")
    .replace(/:\/\//g, "&#58;//")
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}&#46;`);
  return clean || "—";
}

function code(text: string | null, max: number): string {
  if (!text) return "—";
  const clean = text
    .slice(0, max)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/<!--/g, "<!‑-")
    .replace(/-->/g, "-‑>")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|");
  return clean ? `\`${clean}\`` : "—";
}

const MAX_ROWS = 30;

export function renderMakerScreenshotsComment(
  engineeringRunId: string,
  screenshots: readonly MakerScreenshotLine[],
  runPageUrl: string | null,
): string {
  const rows = screenshots.slice(0, MAX_ROWS).map((s, i) => {
    const errors = s.consoleErrors.length;
    return `| ${i + 1} | ${cell(s.name, 80)} | ${code(s.url, 120)} | ${cell(s.pageTitle, 80)} | ${errors} |`;
  });
  const more = screenshots.length > MAX_ROWS ? [`… and ${screenshots.length - MAX_ROWS} more on the run page.`, ""] : [];
  const body = [
    makerScreenshotsMarker(engineeringRunId),
    "### 📷 Maker screenshots — unverified, not verification evidence",
    "",
    "The **maker agent** took these while it was building, to check its own work. They are " +
      "maker-authored and unverified: the independent verifier did not take, read or check them, and " +
      "they played no part in the verdict. Windkeel's evidence summary on this pull request is the verifier's.",
    "",
    "| # | Name | Page | Title | Console errors |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...more,
    runPageUrl ? `See the images on the [run page](${runPageUrl}) (sign-in required).` : `See the images on run \`${engineeringRunId}\`'s page in the console.`,
  ].join("\n");
  return body.length > COMMENT_LIMIT ? `${body.slice(0, COMMENT_LIMIT - 20)}\n\n… (truncated)` : body;
}
