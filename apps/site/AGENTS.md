# apps/site

The Windkeel marketing site (`windkeel.dev`): a static Next.js app, Vercel project `windkeel-site`.
It never imports `@windkeel/factory`, `@windkeel/verification`, `@windkeel/api-contract` or anything in `src/`.

## Commands

Run from the repo root.

| Do | Run |
| --- | --- |
| Dev server (port 3200) | `npm run dev -w @windkeel/site` |
| Typecheck | `npm run typecheck -w @windkeel/site` |
| Unit tests (`lib/*.test.ts`) | `npm test -w @windkeel/site` |
| Production build | `npm run build -w @windkeel/site` |
| Browser, axe and agent tests (after a build) | `npm run test:e2e -w @windkeel/site` |

The browser tests start `next start` themselves, or use `SITE_URL` if set. If playwright-core's own
Chromium isn't installed, point `CHROMIUM_EXECUTABLE` at a Chrome binary.

## Rules

- Every external URL and unconfirmed fact lives in `site.config.ts`; never fill one with a guess.
  A link or the contact email left as `TODO` is hidden from the nav and footer. Unconfirmed copy
  on a page renders a visible `[TODO: …]` marker.
- Copy uses only confirmed product facts. No invented customers, numbers or quotes.
- Interactive controls are UI SDK (`@ui-sdk/react/<component>`), styled in `app/globals.css` by
  `data-slot` and state attributes. Read `node_modules/@ui-sdk/react/docs/llms.txt` first; the skill
  ships at `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md`.
- Colors come from `design/tokens/color.css` through the `@theme` names in `app/globals.css`.
  The theme preference sets `data-theme` on `<html>`, which those tokens already follow.
- Request-access submissions go to `ACCESS_REQUEST_WEBHOOK_URL` (https) when set, otherwise to the
  server log (`lib/access-adapter.ts`).
- The CLI and Action are still named `windkeel`; show them exactly as they are (`components/snippets.ts`).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
