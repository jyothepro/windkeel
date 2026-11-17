/**
 * #394 (09e): the docs pages the console serves under `/docs` exist, and every internal link on them
 * resolves — to another docs page or to a console route that exists on disk.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { brokenLinks, CONSOLE_ROUTES, DOC_PAGES } from "../apps/console/lib/docs-pages.ts";
import { repoRoot } from "./helpers.js";

test("the docs cover what onboarding links to", () => {
  assert.deepEqual(
    DOC_PAGES.map((p) => p.slug).sort(),
    ["billing", "byok", "cli", "getting-started", "github-app", "verification"],
  );
  for (const page of DOC_PAGES) assert.ok(page.sections.length > 0, `${page.slug} has content`);
});

test("every internal docs link resolves", () => {
  assert.deepEqual(brokenLinks(), []);
  assert.deepEqual(
    brokenLinks([{ slug: "x", title: "x", summary: "x", sections: [{ heading: "h", blocks: [{ kind: "links", links: [{ href: "/docs/nope", label: "n" }] }] }] }]),
    ["x → /docs/nope"],
    "the checker catches a dead link",
  );
});

test("every console route a doc may link to is a page on disk", () => {
  const app = join(repoRoot, "apps", "console", "app");
  const pageFor = {
    "/": "(console)/page.tsx",
    "/runs": "(console)/runs/page.tsx",
    "/welcome": "(onboarding)/welcome/page.tsx",
    "/settings": "(settings)/settings/page.tsx",
  };
  for (const route of CONSOLE_ROUTES) {
    const file = pageFor[route] ?? (route.startsWith("/settings/") ? "(settings)/settings/[section]/page.tsx" : null);
    assert.ok(file && existsSync(join(app, file)), `${route} has no page`);
  }
  assert.ok(existsSync(join(app, "(docs)", "docs", "[slug]", "page.tsx")));
});
