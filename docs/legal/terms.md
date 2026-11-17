# Terms of Service — DRAFT

> DRAFT for legal review. Not in force. Placeholders are in `[BRACKETS]`.

Effective date: `[EFFECTIVE DATE]`

These terms are an agreement between you (or the organization you act for, "Customer") and
`[COMPANY]` ("we") for the managed Windkeel service ("Service"). The Windkeel source code
is licensed separately (PolyForm Noncommercial 1.0.0, or a commercial license); these terms do not
apply to it.

## 1. The Service

The Service turns tasks you describe into draft pull requests. A coding agent ("maker") writes a
change in an isolated sandbox, an independent verifier checks it in a separate sandbox, and the
Service opens a draft pull request with an evidence package. **The Service never merges a change
unless an authorized person in your organization tells it to.**

## 2. Accounts and access

- You sign in with GitHub. You are responsible for activity under your account and for the
  repositories and integrations you connect.
- Access is by invitation during early access. We may decline or end an invitation.
- You must be at least 18 and able to enter this agreement for your organization.

## 3. Your code and content

- You keep all rights in your repositories, tasks, prompts, and the code the Service produces for
  you ("Customer Content").
- You grant us a limited license to process Customer Content only to provide, secure and support
  the Service for you.
- **We do not use Customer Content to train machine learning models.** Model providers process it
  under their API terms, listed in [subprocessors.md](subprocessors.md).
- You are responsible for having the rights to the code and data you give the Service.

## 4. AI output

Code, findings and verdicts are produced by AI models and automated checks. They can be wrong.
A `pass` verdict means the checks and reviews described in the evidence package passed; it is not
a warranty that the code is correct, secure or fit for a purpose. **You are responsible for
reviewing and deciding what to merge and deploy.**

## 5. Credits, plans and payment

- Prices are listed at `/pricing`. One credit equals US$0.01 of usage.
- Plans renew monthly and are charged in advance through Stripe. Plan credits reset at each
  renewal and do not roll over.
- Top-up and trial credits expire 12 months after they are granted.
- When credits run out, new runs stop. Runs already in progress finish their current step and
  verification. If an admin turns on overage, usage beyond your credits is billed monthly up to the
  cap they set, and never beyond it.
- Fees are non-refundable except where required by law or stated in writing by us.
- You may cancel at any time; the plan runs to the end of the paid period.

## 6. Acceptable use

You will not use the Service to: attack or probe systems you do not own or have permission to
test; mine cryptocurrency or run workloads unrelated to software development in the sandboxes;
try to break out of a sandbox or access another customer's data (report it under
[SECURITY.md](../../SECURITY.md) instead); generate malware; or break the law or the terms of a
connected service such as GitHub.

## 7. Third-party services

The Service connects to GitHub, Slack, Linear, Jira, Sentry and model providers at your request.
Your use of them is governed by their terms. If you bring your own model keys, the provider bills
you directly for model usage.

## 8. Confidentiality and security

We protect Customer Content with reasonable technical and organizational measures, including
isolated sandboxes per run, sealed per-organization credentials, and an append-only audit log.
See [privacy.md](privacy.md).

## 9. Suspension and termination

We may suspend access that threatens the Service, other customers or third parties, or for
non-payment, with notice where practical. Either party may terminate for material breach not cured
within 30 days. On termination you may export your data for 30 days, after which we delete it as
described in the Privacy Policy.

## 10. Disclaimers

Except as expressly stated, the Service is provided "as is" without warranties of any kind, to
the fullest extent permitted by law.

## 11. Limitation of liability

`[To be drafted by counsel. Typical: neither party liable for indirect damages; total liability
capped at fees paid in the 12 months before the claim.]`

## 12. Changes

We may update these terms. We will give at least 30 days' notice of material changes by email or
in the console.

## 13. General

Governing law: `[GOVERNING LAW]`. Contact: `[CONTACT EMAIL]`, `[ADDRESS]`.
