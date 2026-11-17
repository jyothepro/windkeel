import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOC_PAGES, docPage } from "../../../../lib/docs-pages.ts";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return DOC_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = docPage((await params).slug);
  return { title: page ? `${page.title} · Docs` : "Docs" };
}

export default async function DocsPage({ params }: Props) {
  const page = docPage((await params).slug);
  if (!page) notFound();
  return (
    <article className="oq-stack" style={{ ["--gap" as string]: "var(--space-4)" }} data-doc={page.slug}>
      <header>
        <h1>{page.title}</h1>
        <p className="oq-muted">{page.summary}</p>
      </header>
      {page.sections.map((section) => (
        <section key={section.heading} className="console-section">
          <h2>{section.heading}</h2>
          {section.blocks.map((block, i) => {
            if (block.kind === "p") return <p key={i}>{block.text}</p>;
            if (block.kind === "code") return <pre key={i} className="console-mono">{block.text}</pre>;
            if (block.kind === "list")
              return (
                <ul key={i}>
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              );
            return (
              <p key={i} className="console-actions">
                {block.links.map((link) => (
                  <Link key={link.href} href={link.href} className="oq-button oq-button--ghost oq-button--sm">
                    {link.label}
                  </Link>
                ))}
              </p>
            );
          })}
        </section>
      ))}
    </article>
  );
}
