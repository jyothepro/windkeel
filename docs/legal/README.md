# Legal drafts for the managed service

> **DRAFT, not legal advice.** These are starting points written from how the code actually
> behaves, for a lawyer to review before the managed service takes paying customers. Nothing
> here is in force, and the landing page does not link to them yet.

| Document | Purpose |
| --- | --- |
| [terms.md](terms.md) | Terms of Service for the managed factory |
| [privacy.md](privacy.md) | Privacy Policy: what the service collects, why, and for how long |
| [subprocessors.md](subprocessors.md) | Third parties that process customer data |

Placeholders a person must fill: `[COMPANY]` (the legal entity), `[ADDRESS]`, `[CONTACT EMAIL]`,
`[GOVERNING LAW]` and `[EFFECTIVE DATE]`.

Facts these drafts rely on, so a reviewer can check them against the code:

- Billing terms come from ADR-0040: 1 credit = US$0.01, plan credits reset monthly, top-ups and the
  trial expire after 12 months, a hard stop when credits run out, optional overage up to a cap.
- Evidence retention is outcome-tiered with tombstones (ADR-0015); audit events are kept for
  `WINDKEEL_AUDIT_RETENTION_DAYS`.
- Customer model keys are sealed per organization and never handed to the maker in plain form
  (ADR-0014, ADR-0026).
- People sign in with GitHub through Supabase Auth (ADR-0024).
