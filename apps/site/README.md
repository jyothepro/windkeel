# Windkeel site

The marketing site for [windkeel.dev](https://windkeel.dev). Commands and rules: [AGENTS.md](AGENTS.md).

Vercel project `windkeel-site`, Root Directory `apps/site`. It builds only when a commit touches
`apps/site/`, the root `package-lock.json` or `design/tokens/` (the ignored-build step in `vercel.json`).

| Setting | Where |
| --- | --- |
| External URLs, placeholders | `site.config.ts` |
| Sign-in link | `NEXT_PUBLIC_APP_URL` (default `https://app.windkeel.dev`) |
| Request-access delivery | `ACCESS_REQUEST_WEBHOOK_URL` (https); unset, requests go to the server log |
