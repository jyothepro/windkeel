# Intake from Sentry/incident alerts + verifier-aware status updates back to Slack, Linear, Jira and Sentry

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

> Slug: `04-intake-slack-linear-jira-sentry`. Split into 3 sub-tasks (A, B, C) below, one PR each.

## Why

Devin and Factory.ai pick up work wherever it gets described: Slack, Linear, Jira, and production alerts. Windkeel already
takes Slack, Linear and Jira (Milestone 8). It is missing **Sentry/incident alerts**, and the updates it sends back only
say a run started, needs approval, has a draft PR, or failed. Windkeel's edge over those competitors is the **independent
verifier**. A fresh sandbox re-checks every candidate (ADR-0004), and per ADR-0029 *there is no path around
verification*. So the update that goes back to the source should report the verifier's **verdict**, not just "PR
opened". A Sentry alert that turns into a *verified* fix, with the verdict posted on the Sentry issue, is the demo that
sets Windkeel apart.

Rule for this work: **no intake and no notifier may create, mark or describe a PR as ready without the verifier's
result.** Any new source only feeds the existing pipeline → run → verify → draft PR loop.

## Background the implementer needs

### What already exists (read these files first)
- **Intake pipeline**: `src/intake/pipeline.ts`. `IntakeSource<P>` has `name`, `verify(req, ctx)`, `parse(req)`,
  `deliveryKey(req, payload)`, `interpret(payload, ctx)` (returns an intent or `ignore(reason)`), and an optional
  `respond`. `registerIntakeSource`, `runIntake` and `wireResponse` are also here. The contract: verify before parse,
  parse before the DB, and one `intake_delivery` row (migration `0023_intake_delivery.sql`) in the same transaction as
  the task. Every ignored event is recorded with a reason. A 5xx is returned only when a retry can help.
- **Task creation**: `src/intake/create-task.ts` (`createTaskFromIntake`, `IntakeTaskInput`, `RepositoryNotGrantedError`).
  Repo access comes only through `repository_grant` (ADR-0024 §2), checked with `grantedRepository` and
  `getSystemActor` from `src/factory/tenancy.ts`. A task's creator is a system actor (`principal.system_purpose`),
  never a person.
- **Existing sources**:
  - Slack: `src/intake/slack.ts` (source + notifier, `SLACK_SOURCE`)
  - Linear: `src/intake/linear.ts` + `src/integrations/linear.ts` (`registerLinearNotifier`, `LINEAR_SOURCE_TYPE`)
  - Jira: `src/integrations/jira-intake.ts` (`registerJiraNotifier`, `JIRA_SOURCE_TYPE`), `src/integrations/jira.ts`
    (`signJiraWebhookJwt`) and `src/integrations/adf.ts`
  - Signed generic webhook: `src/intake/webhook.ts` + `src/intake/webhook-endpoints.ts`. The secret is derived from
    `WINDKEEL_WEBHOOK_SIGNING_KEY`, never stored, because ingress can seal but not unseal (ADR-0014).
  - Shared helpers: `src/intake/hmac.ts` (`signHmacSha256`, `verifyHmacSha256`, `withinTolerance`) and
    `src/intake/idempotency.ts`.
- **Connections/routes**: migration `0025_integration_connection.sql`, with `integration_connection.provider` check
  `('slack','linear','jira')` and `integration_route.scope_kind` check
  `('default','slack_channel','linear_team','jira_project')`. Code is in `src/integrations/connections.ts`
  (`createConnection`, `addRoute`) and `src/integrations/errors.ts` (`PROVIDERS`, `isProvider`). Tokens come from
  `src/integrations/vercel-connect.ts` (`VercelConnectTokenSource`, `fakeConnectForwardVerifier`) and
  `src/integrations/token-source.ts` (`FakeProviderTokenSource`).
- **Ingress wiring**: `apps/ingress/src/intake-sources.ts` (`registerDeploymentIntakeSources`, one
  `register*IntakeSource()` call per source, e.g. `apps/ingress/src/linear-intake.ts`). Requests reach it at
  `POST /api/intake/:source` (`apps/ingress/api/intake.ts`). The `/v1/integrations*` routes are in
  `apps/ingress/src/api/route.ts` (around line 248) and `apps/ingress/src/api/handlers.ts`.
- **Notifier seam**: `src/intake/notifiers.ts`. It defines `SourceNotifier { sourceType, timeoutMs?, notify(task, run,
  outcome, signal) }`, `RunOutcome { kind: 'started'|'state', transitionId, state, reason, terminal }`,
  `isNotifiableState`, `notifiableOutcomeKind`, `relayableReason` (bounded at `RELAYED_REASON_MAX_CHARS` = 300, with
  text the sandbox produced withheld) and `NOTIFIER_TIMEOUT_MS` = 10 s. The idempotency key is
  `outcome.transitionId`. A notification never fails or stalls a run. Notifiers are registered only in the flow
  function by `registerDeploymentNotifiers` (`src/factory/workflow/deployment-notifiers.ts`), each behind its own
  `WINDKEEL_CONNECT_<PROVIDER>`.
- **Run states**: `src/factory/run-state-machine.ts` (`RunState`, `TERMINAL_STATES`). The verifier runs in `VERIFYING`.
  Its results are in `src/factory/stage-results.ts` / `src/factory/run-report.ts` (read these to find where the
  verdict and criteria results are stored).
- **Docs**: `docs/integrations.md` (operator guide: the "front doors" table, the "who can start work" table, env
  table, per-provider sections) and `docs/webhook-intake.md`.
- **Live proof**: issue #302 covers M8 live proof and #292 the M8-0 spike. MILESTONES (`research/MILESTONES.md`)
  lists M8 as code complete with live proof pending.

### ADRs (one or two lines each)
- **ADR-0004**: verification runs in a fresh, independent sandbox. Maker output is never trusted.
- **ADR-0016**: local dev and tests are hermetic by default. No network; fakes at every edge.
- **ADR-0020**: the control plane is Vercel end to end (ingress functions, flow function, cron).
- **ADR-0021**: Vercel Workflow backs `WorkflowProvider`. `advanceRun` (where notifiers fire) runs in workflow steps,
  which can be replayed, so notifiers must be idempotent.
- **ADR-0025**: M8 borrows credentials from Vercel Connect (we store no provider token) and owns its intake. Jira has
  no Connect trigger, so Windkeel registers its own webhook and verifies it with a deployment-wide secret
  (`WINDKEEL_JIRA_WEBHOOK_SECRET`).
- **ADR-0029**: Windkeel is an integrated assistant, and the verifier stays the gate for every candidate.

### Test conventions
- Tests are `node --test` over `test/*.test.js` and import from `dist/`. `npm test` builds first.
- Fakes: `FakeGitHubClient` (`dist/github/fake.js`), `FakeSandboxProvider` (`dist/sandbox/fake.js`),
  `ScriptedWorkerAdapter` (`dist/worker/scripted.js`), `FakeProviderTokenSource`, `fakeConnectForwardVerifier`,
  `test/slack-fakes.js` (`fakeSlack`) and `test/jira-fake.js` (`FakeJira`).
- Postgres tests use `TEST_POOL` and `runMigrations` from `test/helpers.js`. Full-stack tests use
  `test/factory-stack.js` (`startFactory`) and `test/workflow-runtime.js` (`runtimeSkip`, `untilAsleep`).
- Template for the end-to-end shape: `test/e2e-m8-intakes.test.js`. Per-source unit tests to copy:
  `test/jira-intake.test.js`, `test/jira-notifier.test.js`, `test/linear-notifier.test.js`,
  `test/slack-notifier.test.js`, `test/webhook-intake.test.js`, `test/notifier-relayed-reason.test.js`.

## Scope

**In**
- A. A Sentry intake: `POST /api/intake/sentry`, signed by Sentry, turning issue/metric alerts into tasks through the
  existing pipeline.
- B. Verifier-aware status updates for Slack, Linear and Jira (and Sentry): a `verifying` progress update and a verdict
  summary on `WAITING_FOR_HUMAN` / terminal states.
- C. Posting back to Sentry (a comment on the Sentry issue with a run link, the verdict and the draft PR), plus docs and
  e2e.

**Out of scope**
- PagerDuty, Datadog and Opsgenie as first-class sources. They can use the existing signed webhook today. Add a docs
  recipe only.
- Two-way chat (answering run questions in Slack threads).
- Auto-resolving Sentry issues on merge.
- Anything that marks a PR ready, or merges it, from a notifier.
- Console UI beyond listing the new provider in the existing integrations settings section.

## Design

### Sentry intake (sub-task A)
- **Mechanism**: a Windkeel **Sentry integration** (public or internal) with webhooks on. Sentry sends:
  - `Sentry-Hook-Resource` (`issue`, `event_alert`, `metric_alert`, `installation`)
  - `Sentry-Hook-Signature` (hex HMAC-SHA256 of the raw body under the integration's client secret)
  - `Sentry-Hook-Timestamp`
  - `Request-ID`
  Check the current Sentry docs before relying on these, and write in the PR what you checked and on what date, as
  `docs/integrations.md` §Jira does.
- **Verification**: mirror Jira. A deployment-wide env `WINDKEEL_SENTRY_CLIENT_SECRET`, read per request.
  - Unset → 503 `integration_misconfigured`.
  - Bad signature → 401.
  - Timestamp outside the window (`withinTolerance`, `DEFAULT_TOLERANCE_SECONDS`) → 401.
  - Use `verifyHmacSha256` from `src/intake/hmac.ts` (constant-time).
- **Delivery key**: `Request-ID`. Fall back to `sha256(resource + body)` if it is missing.
- **Tenant mapping**: the payload's `installation.uuid` is `integration_connection.external_tenant_id` for
  `provider='sentry'`. Store the Sentry org slug as `external_tenant_name`.
- **Routes**:
  - New scope kind `sentry_project` (scope_value = Sentry project slug), plus the existing `default` kind.
  - The trigger is **not** a label. A route fires when `trigger_label` matches the alert rule name (exact match,
    case-insensitive) **or** `trigger_label = '*'`.
  - Default `trigger_label` for Sentry routes: `windkeel`. That means an alert rule must be *named* to include the
    `windkeel` token. This keeps reach explicit.
- **interpret**:
  - Accept only `event_alert` (issue alert rule fired) and `metric_alert` with `action=critical`.
  - Everything else → `ignore('sentry_resource_not_acted_on:<resource>')`.
  - Inactive or unknown installation → `ignore('connection_not_found')`.
  - No matching route → `ignore('no_route')`.
  - Repo not granted → `ignore('repository_not_granted')` (same wording as the other sources; grep their reasons and
    reuse them).
- **Task content**:
  - Title: `Fix Sentry issue <shortId>: <title>`, bounded at 300.
  - Description: built from culprit, error type/value, top in-app stack frames (filename:lineno function), first seen,
    event count, environment, release and the Sentry issue URL. Bounded at 64 KiB.
  - Treat **all payload text as untrusted**. It goes into the description only, never into a shell or a prompt
    template outside the task description, and goes through the same sanitisation the webhook source uses.
  - `source_type='sentry'`. `source_reference` = Sentry issue id, so a re-firing alert for the same issue is **one
    task** (the unique index from 0023 on `(organization_id, source_type, source_reference)`). Later firings record
    `duplicate`.
  - `source_context` = `{ installationUuid, orgSlug, projectSlug, issueId, shortId, issueUrl }`.
  - Risk level: `medium` by default. A route may override it later; none for now.
- **System actor**: add `sentry` to the system actors, following how `jira`/`linear` actors are seeded. Grep
  `system_purpose` in `migrations/` and `src/factory/tenancy.ts`.

### Migration
- New file `migrations/0037_sentry_integration.sql`. The latest is `0036_run_merge_claim.sql`; re-check `ls migrations`
  before naming it.
  - Drop and re-add the `integration_connection.provider` check with `'sentry'` added.
  - Drop and re-add the `integration_route.scope_kind` check with `'sentry_project'` added.
  - Add a `system_purpose` value / seed for `sentry`, if the actor constraint or seeding needs it.
  - Not schema-qualified (ADR-0024 §11). Include a header comment like the other migrations.
- Status-update claims need no new tables. Reuse each notifier's existing `source_context.notified` claim pattern
  (see the Slack notifier).

### Code
- New file `src/integrations/sentry.ts`: payload types, `verifySentrySignature`, `signSentryWebhook` (for tests),
  `SENTRY_SOURCE_TYPE = 'sentry'`, `createSentryIntakeSource({ startRun, secret: () => string|undefined })` and, in
  sub-task C, `registerSentryNotifier`.
- `src/integrations/errors.ts`: add `'sentry'` to `PROVIDERS`.
- `src/integrations/connections.ts`: let `sentry_project` routes through validation.
- New file `apps/ingress/src/sentry-intake.ts`, registered in `apps/ingress/src/intake-sources.ts`.
- `POST /v1/integrations` already takes provider + tenant. Make sure `provider:'sentry'` with
  `externalTenantId=<installation uuid>` works.

### Status updates (sub-task B)
- Extend `RunOutcomeKind` to `'started' | 'state' | 'progress'`. `notifiableOutcomeKind` returns `'progress'` on the
  **first** entry into `VERIFYING` per run, so a repair loop doesn't spam (for example by checking whether a previous
  transition into VERIFYING exists, or just firing on each `transitionId` and letting notifiers that don't care
  ignore it). **Default: fire on every entry. Notifiers post at most one "Verifying…" per run**, tracked by a claim in
  `source_context.notified.verifying`.
- Add an optional `verdict?: { passed: number; failed: number; total: number; summary: string }` to `RunOutcome`,
  filled for `WAITING_FOR_HUMAN` and terminal states from the latest verification result. It is built from structured
  fields only (criterion counts and pass/fail), never raw sandbox output, in keeping with `relayableReason`'s rule.
- Each existing notifier (Slack, Linear, Jira) adds:
  - on `progress`: "Verifying in an independent sandbox…"
  - on `WAITING_FOR_HUMAN`: "Verified ✓ N/N criteria · draft PR <link> · run <link>"
  - on `FAILED`, `MAX_REPAIR_ATTEMPTS_REACHED` or `BLOCKED`: "Not verified: k of N criteria failed" plus the relayed
    reason.
  - Never "ready" wording before the verdict.
- Every notifier must keep ignoring kinds it doesn't handle. Check `src/factory/workflow/` call sites of
  `notifyRunOutcome` and add the `progress` path there.

### Sentry post-back (sub-task C)
- Sentry comments need a token. Resolve the token path first: (1) does Vercel Connect have a Sentry connector (Custom
  OAuth)? (2) otherwise a Sentry integration token exchange.
  - **Default: Custom OAuth connector via Connect** (`WINDKEEL_CONNECT_SENTRY`), matching ADR-0025 (store no tokens).
  - If neither works, stop and flag it for a human (see Risks).
- The notifier posts to `POST /api/0/issues/{issueId}/comments/` on `started` (run link), `WAITING_FOR_HUMAN`
  (verdict + PR) and terminal states. It is idempotent on `transitionId` through a `source_context.notified` claim and
  honours the `signal`.
- Register it in `registerDeploymentNotifiers` only when `WINDKEEL_CONNECT_SENTRY` is set.

### Security
- Verify before parse, using a constant-time compare and the timestamp window.
- Who can start work: anyone who can create or rename an alert rule in a routed Sentry project. Document this in the
  "who can start work" table.
- An alert storm must not create many tasks. Dedup on the issue id. Also add a per-connection cap, **Default: at most
  20 Sentry tasks per connection per hour**, as a count over `intake_delivery` in the interpret transaction. When the
  cap is hit, `ignore('rate_limited')`.
- Payload text is untrusted (prompt injection). It is fenced in the description as quoted data. Never echo secrets in
  logs; use `describeError`.

## Implementation steps

**Sub-task A: Sentry intake**
1. Read `src/integrations/jira-intake.ts`, `src/intake/webhook.ts` and `test/jira-intake.test.js` end to end.
2. Add migration `0037_sentry_integration.sql`. Run `npm test` to confirm migrations apply (the tests run
   `runMigrations`).
3. Add `'sentry'` to `PROVIDERS` and `sentry_project` route validation in `connections.ts`.
4. Write `src/integrations/sentry.ts` with sign/verify, parse, deliveryKey, interpret and task building.
5. Add the system actor `sentry`.
6. Write `apps/ingress/src/sentry-intake.ts` and register it in `intake-sources.ts`.
7. Write `test/sentry-intake.test.js` (cases listed below). Add Sentry payload fixtures under `test/fixtures/sentry/`
   (new dir), copied from Sentry docs' sample payloads with ids changed.
8. Update `docs/integrations.md`: the front-doors table (eight doors), the who-can-start table, the env table
   (`WINDKEEL_SENTRY_CLIENT_SECRET`), a new `## Sentry` section and the migration range text.

**Sub-task B: verifier-aware status**
1. Find where the verification result is persisted (`stage-results.ts`, `run-report.ts`) and add a pure function
   `verdictForRun(pool, runId)` that returns counts or null.
2. Extend `RunOutcome` and `notifiableOutcomeKind`, and fill `verdict` at the notify call site.
3. Update the Slack, Linear and Jira notifiers' message builders. Keep per-notifier claims idempotent.
4. Update the existing notifier tests, add new cases, and update `test/notifier-relayed-reason.test.js` if message
   shapes change.
5. Update the "What happens" rows in `docs/integrations.md`.

**Sub-task C: Sentry post-back + e2e**
1. Run a spike on the token path. Record the result in the PR description.
2. Add `registerSentryNotifier` and register it in `deployment-notifiers.ts` behind `WINDKEEL_CONNECT_SENTRY`.
3. Add a new fake, `test/sentry-fake.js` (records comments, answers 429/5xx on demand), modelled on
   `test/jira-fake.js`.
4. Extend `test/e2e-m8-intakes.test.js` with a Sentry row. Make the shared `fetch` fake answer Sentry.
5. Add a Sentry step to the live checklist (comment on #302, or a new section in `docs/integrations.md` "Going live").

## Done condition
- `npm test` passes, with the new test files included and no existing test skipped or weakened.
- A signed Sentry `event_alert` for a routed project creates exactly one `engineering_task` (`source_type='sentry'`)
  plus a run and an `intake_delivery` row in one transaction. A redelivery and a re-fire for the same Sentry issue
  each record `duplicate` and create no new task.
- Each of these answers as specified and creates no task (no `engineering_task` row): bad or missing signature (401),
  stale timestamp (401), missing secret (503), unknown installation, unrouted project, ungranted repository, a
  non-alert resource, and the rate cap. Each ignored case has its `intake_delivery.reason`.
- The Slack, Linear and Jira notifiers post one "verifying" message per run and include verdict counts on
  `WAITING_FOR_HUMAN` and on failure. Replaying the same `transitionId` posts nothing new.
- No notifier text contains raw sandbox output. `relayableReason` rules hold.
- (C) The Sentry notifier comments on the Sentry issue with the run link, the verdict and the draft PR link. It is
  registered only when `WINDKEEL_CONNECT_SENTRY` is set.
- `test/e2e-m8-intakes.test.js` proves the path Sentry → verified draft PR → comment on the Sentry issue.
- `docs/integrations.md` documents the Sentry front door, who can start work, the env vars and the migration.

## How to verify the done condition
- `npm test`: all green. Use `node --test test/sentry-intake.test.js test/slack-notifier.test.js
  test/linear-notifier.test.js test/jira-notifier.test.js test/e2e-m8-intakes.test.js` after `npm run build` for a
  fast loop.
- Postgres-backed tests need the local test DB that `test/helpers.js` `TEST_POOL` expects. Follow the README /
  `docs/` local dev setup (ADR-0016, hermetic).
- `npm run db:migrate` on a fresh DB applies 0037 cleanly. `select provider from integration_connection` accepts
  `'sentry'`.
- Spot check: in the e2e test, assert that `select source, intent, reason from intake_delivery where source='sentry'`
  holds the expected rows.
- Manual/live (after merge, by a human with a Sentry org): create the integration, set `WINDKEEL_SENTRY_CLIENT_SECRET`,
  connect via `POST /v1/integrations`, add a `sentry_project` route, and fire a test alert named `windkeel …`. You should
  see a task in the console, a "started" comment, then a verified draft PR and a verdict comment on the Sentry issue.

## Tests required

**Unit / DB tests**
- New file `test/sentry-intake.test.js`:
  - Signature: valid passes; tampered body, wrong secret, missing header and non-hex all fail; the timestamp window is
    enforced both ways; a missing secret gives 503.
  - Parse: malformed JSON → 400; oversize title/description are bounded.
  - Resource filter: `issue`, `installation` and `metric_alert` resolved/warning are ignored with reasons;
    `event_alert` and `metric_alert` critical are acted on.
  - Routing: `sentry_project` beats `default`; a rule name that doesn't match the trigger is ignored; `*` matches all;
    an inactive connection is ignored; an ungranted repo is ignored (`repository_not_granted`).
  - Dedup: the same `Request-ID` gives duplicate; a different `Request-ID` for the same issue id gives one task.
  - Rate cap: the 21st alert in an hour is ignored with `rate_limited`.
  - Task content: description includes stack frames and the issue URL; payload text containing backticks or
    "ignore previous instructions" is fenced as data; `created_by_principal_id` is the `sentry` system actor.
- `test/issue-intake.test.js` / connections tests: `isProvider('sentry')` is true; a route with an ungranted repo is
  rejected with 422.
- Notifier tests (Slack, Linear, Jira):
  - `progress` is posted once per run across a repair loop.
  - Verdict text is right for pass, partial fail and null verdict (with a sensible fallback).
  - A replayed `transitionId` doesn't post again.
  - Abort signal honoured.
  - A notifier that ignores `progress` doesn't throw.
- `test/notifier-relayed-reason.test.js`: the verdict summary never includes sandbox text.
- (C) New file `test/sentry-notifier.test.js`: comments on started, waiting-for-human and terminal; idempotent; retries
  429/5xx with a bound; registration gated on env (extend the `registerDeploymentNotifiers` test if one exists — grep
  for it).

**Integration / e2e**
- `test/e2e-m8-intakes.test.js`: a Sentry row using `FakeGitHubClient`, `FakeSandboxProvider`,
  `ScriptedWorkerAdapter`, the new `test/sentry-fake.js` and `FakeProviderTokenSource`. It goes from a signed request
  through `runIntake` to a verified draft PR, then a comment on the Sentry fake. The existing Slack, Linear and Jira
  rows assert the new verifying and verdict messages.
- An ingress handler test (pattern: `test/ingress-handler.test.js`) confirming that `/api/intake/sentry` is
  registered.

**Browser**
- None required. If the console integrations settings page (`apps/console/app/(settings)/settings/automation-sections.tsx`)
  lists providers from a fixed list, add `sentry` and extend `test/console-browser.js` with one assertion that the
  Sentry option renders.

## Risks & open questions
- **Sentry token path for post-back (C)**: Connect may not support Sentry. *Default*: Custom OAuth via Connect. If
  that's impossible, ship A and B, and leave C `ready-for-human` for an ADR amendment (store a sealed integration
  token? That would break the ADR-0025 "store none" rule).
- **Trigger semantics**: should the trigger be the alert rule name or a Sentry tag? *Default*: rule name contains the
  trigger token (`windkeel`) as an explicit opt-in.
- **Rate cap value**: *default* 20/hour/connection, as a constant. Make it configurable later.
- **Progress noise**: *default* one "verifying" post per run. A human may prefer none in Slack.
- **Payload header names / signature format**: confirm against the current Sentry docs before coding. Don't guess.
- **ADR**: this extends ADR-0025. Add an "As built: Sentry" note to ADR-0025 rather than writing a new ADR, unless C
  needs stored credentials.

## Suggested labels and dependencies
- Sub-task A: `ready-for-agent`. Sub-task B: `ready-for-agent`. Sub-task C: `ready-for-human` until the token-path spike
  is decided, then `ready-for-agent`.
- Blocked-by: none for A/B. C's live verification and the e2e being meaningful live is soft-blocked by
  `01-live-proof` (the M8 live proof, #302).
- Related: `05-agent-types-playbooks` (a "fix Sentry error" playbook could consume `source_context`) and
  `06-parallel-and-batch` (alert storms).
