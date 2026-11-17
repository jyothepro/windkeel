export interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

export const ADF_MAX_DEPTH = 50;
export const MAX_DESCRIPTION_CHARS = 20_000;
export const TRUNCATION_MARKER = "[… description truncated by Windkeel]";

export function truncateDescription(text: string, max: number = MAX_DESCRIPTION_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n\n${TRUNCATION_MARKER}`;
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "decisionList",
  "codeBlock",
  "blockquote",
  "rule",
  "panel",
  "table",
  "mediaSingle",
  "mediaGroup",
  "blockCard",
  "expand",
  "nestedExpand",
]);

export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!isNode(doc)) return "";
  const blocks = doc.type === "doc" ? children(doc) : [doc];
  return renderBlocks(blocks, 0, 0).trim().replace(/\n{3,}/g, "\n\n");
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function flatText(root: AdfNode): string {
  const out: string[] = [];
  let length = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0 && length <= MAX_DESCRIPTION_CHARS) {
    const node = stack.pop();
    if (!isNode(node)) continue;
    const attrs = isNode(node.attrs) ? node.attrs : undefined;
    const piece =
      typeof node.text === "string"
        ? node.text
        : typeof attrs?.["text"] === "string"
          ? (attrs["text"])
          : typeof attrs?.["url"] === "string"
            ? (attrs["url"])
            : "";
    if (piece) {
      out.push(piece);
      length += piece.length;
    }
    if (Array.isArray(node.content)) for (let i = node.content.length - 1; i >= 0; i -= 1) stack.push(node.content[i]);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function renderBlocks(nodes: AdfNode[], depth: number, d: number): string {
  const out: string[] = [];
  let inline: AdfNode[] = [];
  const flush = (): void => {
    if (inline.length > 0) out.push(renderInline(inline, d));
    inline = [];
  };
  for (const node of nodes) {
    if (node.type && (BLOCK_TYPES.has(node.type) || node.type === "listItem" || node.type === "taskItem")) {
      flush();
      out.push(renderBlock(node, depth, d + 1));
    } else {
      inline.push(node);
    }
  }
  flush();
  return out.filter((s) => s.length > 0).join("\n\n");
}

function renderBlock(node: AdfNode, depth: number, d: number): string {
  if (d > ADF_MAX_DEPTH) return flatText(node);
  switch (node.type) {
    case "paragraph":
      return renderInline(children(node), d);
    case "heading": {
      const level = clampLevel(node.attrs?.["level"]);
      return `${"#".repeat(level)} ${renderInline(children(node), d)}`.trimEnd();
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "decisionList":
      return renderList(node, depth, d);
    case "codeBlock": {
      const language = typeof node.attrs?.["language"] === "string" ? (node.attrs["language"]) : "";
      const code = children(node)
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      return `\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\``;
    }
    case "blockquote":
      return renderBlocks(children(node), depth, d)
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    case "blockCard": {
      const url = node.attrs?.["url"];
      return typeof url === "string" ? url : "";
    }
    case "table":
      return children(node)
        .map((row) =>
          children(row)
            .map((cell) => renderBlocks(children(cell), 0, d + 2).replace(/\n+/g, " "))
            .join(" | "),
        )
        .map((line) => `| ${line} |`)
        .join("\n");
    default:
      return renderBlocks(children(node), depth, d);
  }
}

function renderList(list: AdfNode, depth: number, d: number): string {
  if (d > ADF_MAX_DEPTH) return flatText(list);
  const indent = "  ".repeat(depth);
  const startRaw = list.attrs?.["order"];
  let n = typeof startRaw === "number" && Number.isFinite(startRaw) ? Math.max(0, Math.floor(startRaw)) : 1;
  const lines: string[] = [];
  for (const item of children(list)) {
    let marker: string;
    if (list.type === "orderedList") {
      marker = `${n}.`;
      n += 1;
    } else if (list.type === "taskList" || list.type === "decisionList") {
      const state = item.attrs?.["state"];
      marker = state === "DONE" || state === "DECIDED" ? "- [x]" : "- [ ]";
    } else {
      marker = "-";
    }
    if (item.type === "taskList" || item.type === "bulletList" || item.type === "orderedList") {
      lines.push(renderList(item, depth + 1, d + 1));
      continue;
    }
    const parts = children(item);
    const leading: AdfNode[] = [];
    const nested: AdfNode[] = [];
    for (const part of parts) {
      if (part.type === "bulletList" || part.type === "orderedList" || part.type === "taskList") nested.push(part);
      else leading.push(part);
    }
    const body =
      item.type === "taskItem" || item.type === "decisionItem"
        ? renderInline(leading, d + 1)
        : renderBlocks(leading, depth + 1, d + 1).replace(/\n\n/g, `\n${indent}  `);
    lines.push(`${indent}${marker} ${body}`.trimEnd());
    for (const sub of nested) lines.push(renderList(sub, depth + 1, d + 2));
  }
  return lines.join("\n");
}

function renderInline(nodes: AdfNode[], d: number): string {
  return nodes
    .map((node) => renderInlineNode(node, d + 1))
    .join("")
    .trim();
}

function renderInlineNode(node: AdfNode, d: number): string {
  if (d > ADF_MAX_DEPTH) return flatText(node);
  switch (node.type) {
    case "text":
      return applyMarks(typeof node.text === "string" ? node.text : "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention": {
      const text = node.attrs?.["text"];
      return typeof text === "string" ? text : "";
    }
    case "emoji": {
      const text = node.attrs?.["text"] ?? node.attrs?.["shortName"];
      return typeof text === "string" ? text : "";
    }
    case "inlineCard": {
      const url = node.attrs?.["url"];
      return typeof url === "string" ? url : "";
    }
    case "date": {
      const ts = Number(node.attrs?.["timestamp"]);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
    }
    case "status": {
      const text = node.attrs?.["text"];
      return typeof text === "string" ? `[${text}]` : "";
    }
    default:
      if (typeof node.text === "string") return node.text;
      return children(node)
        .map((child) => renderInlineNode(child, d + 1))
        .join("");
  }
}

function applyMarks(text: string, marks: AdfNode["marks"]): string {
  if (!Array.isArray(marks) || text.length === 0) return text;
  let out = text;
  let href: string | null = null;
  for (const mark of marks) {
    if (!isNode(mark)) continue;
    if (mark.type === "code") out = `\`${out}\``;
    else if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `*${out}*`;
    else if (mark.type === "strike") out = `~~${out}~~`;
    else if (mark.type === "link" && typeof mark.attrs?.["href"] === "string") href = mark.attrs["href"];
  }
  return href ? `[${out}](${href})` : out;
}

function clampLevel(value: unknown): number {
  const n = typeof value === "number" ? Math.floor(value) : 1;
  return Math.min(6, Math.max(1, n));
}

export type AdfInline = { type: "text"; text: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };

export function adfText(text: string): AdfInline {
  return { type: "text", text };
}

export function adfLink(text: string, href: string): AdfInline {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] };
}

export function adfStrong(text: string): AdfInline {
  return { type: "text", text, marks: [{ type: "strong" }] };
}

export function adfParagraph(...content: AdfInline[]): AdfNode {
  return { type: "paragraph", content: content.filter((c) => c.text.length > 0) };
}

export function adfDoc(...paragraphs: AdfNode[]): { type: "doc"; version: 1; content: AdfNode[] } {
  return { type: "doc", version: 1, content: paragraphs };
}
