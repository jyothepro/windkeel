# Privacy Policy — DRAFT

> DRAFT for legal review. Not in force. Placeholders are in `[BRACKETS]`. Check each retention
> period against the deployment's configuration before publishing.

Effective date: `[EFFECTIVE DATE]`

This policy explains what `[COMPANY]` collects when you use the managed Windkeel service, why, and
how long we keep it. The self-run CLI and GitHub Action run in your own environment and send
nothing to us.

## What we collect

| Data | Source | Why |
| --- | --- | --- |
| GitHub identity: login, user id, name, email, avatar | GitHub sign-in through Supabase Auth | To sign you in and show who did what |
| Organization, membership and role | You and your admins | Access control |
| Repository contents, branches and pull request metadata | The GitHub App you install | To run tasks and verification |
| Tasks, criteria, prompts, messages to the agent | You, and integrations you connect | To do the work you asked for |
| Agent transcripts, logs, diffs, evidence packages | The Service | To show and prove what happened |
| Model API keys you bring | You | To call models on your behalf; stored sealed per organization |
| Integration tokens (Slack, Linear, Jira, Sentry) | You, through each provider's authorization | To receive work and reply |
| Usage and cost events | The Service | Billing, budgets and receipts |
| Billing contact and payment method | Stripe | Payment; we do not store card numbers |
| Audit events, IP address, user agent | The Service | Security and the audit log |

## How we use it

To provide and secure the Service, bill you, support you, and tell you about changes to the
Service. **We do not sell personal data, and we do not use your code or content to train models.**

## Who processes it

The providers in [subprocessors.md](subprocessors.md), under contracts that limit their use of
your data to providing their service to us.

## How long we keep it

| Data | Retention |
| --- | --- |
| Evidence packages and transcripts | Tiered by run outcome (ADR-0015): `[N]` days for runs that did not produce a PR, `[N]` days otherwise; a tombstone row remains |
| Sandboxes | Destroyed after the run, or by the reaper within `[N]` hours |
| Audit events | `[N]` days (`WINDKEEL_AUDIT_RETENTION_DAYS`) |
| Account data | Until the account is closed, plus 30 days |
| Billing records | As required by tax law, typically 7 years |

## Your rights

You can access, correct, export or delete your personal data by contacting `[CONTACT EMAIL]`.
Depending on where you live, you may have further rights under laws such as the GDPR or CCPA,
including the right to complain to a supervisory authority.

## Security

Each run uses isolated sandboxes, with the verifier separate from the maker. Credentials are
brokered and scoped, model keys are sealed per organization, and every action lands in a
per-account, hash-chained audit log. Report vulnerabilities through [SECURITY.md](../../SECURITY.md).

## International transfers

Data is processed in `[REGIONS]`. Where data leaves the EEA or UK, we rely on Standard Contractual
Clauses with our providers.

## Changes and contact

We will post changes here and notify you of material ones. Contact: `[CONTACT EMAIL]`, `[ADDRESS]`.
