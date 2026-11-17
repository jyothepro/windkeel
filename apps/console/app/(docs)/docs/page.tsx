import type { Metadata } from "next";
import Link from "next/link";
import { DOC_PAGES } from "../../../lib/docs-pages.ts";

export const metadata: Metadata = { title: "Docs" };

export default function DocsIndex() {
  return (
    <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-4)" }}>
      <h1>Windkeel docs</h1>
      <ul>
        {DOC_PAGES.map((page) => (
          <li key={page.slug}>
            <Link href={`/docs/${page.slug}`}>{page.title}</Link> — <span className="oq-muted">{page.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
