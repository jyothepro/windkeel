# Subprocessors — DRAFT

> DRAFT for legal review. Confirm each provider, region and what it receives against the
> production configuration before publishing.

| Provider | Purpose | Data it receives |
| --- | --- | --- |
| Vercel | Hosting for the API and console; Vercel Sandbox for maker and verifier sandboxes; durable workflows | Everything the Service processes, including repository contents in sandboxes |
| Supabase | Postgres database, object storage for evidence, sign-in | Account, task, run and audit data; evidence packages; GitHub identity |
| Stripe | Payments and invoicing | Billing contact, payment method, usage totals |
| GitHub | Repository access through the GitHub App, sign-in | Repository contents and metadata you grant |
| OpenAI | Maker and reviewer models, when on Windkeel's keys | Prompts, code and diffs for the run |
| Anthropic | Reviewer and maker models, when on Windkeel's keys | Prompts, code and diffs for the run |
| OpenRouter | Model routing, when configured | Prompts, code and diffs for the run |

Integrations you connect (Slack, Linear, Jira, Sentry) and model providers you bring your own keys
for act on your behalf under your own agreements with them, and are not our subprocessors.
