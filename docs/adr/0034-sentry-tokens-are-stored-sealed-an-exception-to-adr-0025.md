# ADR-0034: Sentry tokens are stored sealed — a Sentry-only exception to ADR-0025's "store none"

- Status: Accepted
- Date: 2026-10-21

## Context

The post-back does need a token, and ADR-0025 §1 says M8 stores none: every provider token is borrowed from Vercel Connect per call.

## Decision

- §1 — One provider credential is stored: a Sentry connection's token: in `sentry_credential` (migration `0046_sentry_integration.sql`), one row per Sentry connection, and nothing else.
- §2 — It is sealed with ADR-0026's v2 box: Ingress, which holds only `WINDKEEL_SECRET_PUBLIC_KEY`, seals the token an administrator supplies on `POST /v1/integrations` and **cannot open it**.
- §3 — It is opened in one place: the Sentry notifier in the flow function, holding `WINDKEEL_SECRET_PRIVATE_KEY`, inside one `notify` call (ADR-0026 §3).
- §4 — A disconnect deletes the credential: A disconnected Sentry org keeps no credential of ours.
- §5 — `WINDKEEL_CONNECT_SENTRY` switches the post-back on: (`registerDeploymentNotifiers`), keeping the `WINDKEEL_CONNECT_<PROVIDER>` convention.
- §6 — `WINDKEEL_SENTRY_CLIENT_SECRET` joins ingress's provider secrets: on the terms ADR-0025's Jira amendment set: read per request, used only to verify, unset ⇒ every delivery is a 503.
- §7 — Only a non-expiring token is supported for now: — an *internal* integration's token.

## Consequences

- A database dump plus the stage deployment's private key yields every Sentry token.
- A compromised ingress can **replace** a Sentry token (any principal with `integrations.manage` can), but cannot **read** one.
- The intake and the post-back are independent: with no token, alerts still become tasks and nothing is posted; with no client secret, nothing is accepted.
- Sentry's region and self-hosted API hosts are not supported yet: comments go to `https://sentry.io`.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Issue: [#389](https://github.com/jyothepro/orqon/issues/389)
- Amends: [ADR-0025](0025-m8-integrations-borrow-credentials-from-vercel-connect-own-the-intake.md) §1 (for Sentry only); uses [ADR-0026](0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md) §2–§3's sealed box

### Context

#389 adds Sentry alerts as an intake and posts the verifier's verdict back as a comment on the
Sentry issue. The intake needs no token: Sentry signs its integration webhooks with the
integration's client secret, which — like Jira's (ADR-0025, Amendment 2026-09-25) — is a
deployment-wide provider secret the ingress holds (`WINDKEEL_SENTRY_CLIENT_SECRET`) to *verify*, never
to call out.

The post-back does need a token, and ADR-0025 §1 says M8 stores none: every provider token is
borrowed from Vercel Connect per call. The maintainer's decision on #389 was: try Connect first;
if it cannot hold Sentry credentials, store the Sentry token **sealed, with the same encryption as
BYOK keys**, as a documented Sentry-only exception.

The spike (2026-10-21, recorded in docs/integrations.md §Sentry):

- Vercel Connect has no Sentry connector.
- A Custom OAuth connector models a standard authorization-code flow. A Sentry *integration*
  credential is not that: an installation's token is minted by
  `POST /api/0/sentry-app-installations/{uuid}/authorizations/` with the integration's client
  secret and the installation's grant code, is scoped to that installation, and expires after
  hours (refreshed the same way). A generic OAuth connector performs neither the per-installation
  exchange nor that refresh. A user OAuth token via Connect would comment *as a person*, which
  ADR-0025 already rejects (`subject: { type: 'app' }`, never a person).

So Connect cannot hold it, and the exception applies.

### Decision

1. **One provider credential is stored: a Sentry connection's token**, in `sentry_credential`
   (migration `0046_sentry_integration.sql`), one row per Sentry connection, and nothing else.
   Slack, Linear and Jira stay exactly as ADR-0025 §1 says.
2. **It is sealed with ADR-0026's v2 box.** Ingress, which holds only `WINDKEEL_SECRET_PUBLIC_KEY`,
   seals the token an administrator supplies on `POST /v1/integrations` and **cannot open it**. The
   AEAD context is `sentry_credential:<organization_id>:<connection_id>`, rebuilt from the ids and
   never read from the row, so a ciphertext copied onto another connection or organization fails to
   open. The row records `keypair_id` and `last4`; the API answers `last4`, never the value.
3. **It is opened in one place**: the Sentry notifier in the flow function, holding
   `WINDKEEL_SECRET_PRIVATE_KEY`, inside one `notify` call (ADR-0026 §3). The plaintext goes into one
   `Authorization` header and nowhere else — never a step argument or result, a row, or a log.
4. **A disconnect deletes the credential.** A disconnected Sentry org keeps no credential of ours.
5. **`WINDKEEL_CONNECT_SENTRY` switches the post-back on** (`registerDeploymentNotifiers`), keeping
   the `WINDKEEL_CONNECT_<PROVIDER>` convention. Its value is not read; the name is reserved for a
   connector uid if Connect ever carries Sentry, at which point this ADR is superseded and the
   table dropped.
6. **`WINDKEEL_SENTRY_CLIENT_SECRET` joins ingress's provider secrets** on the terms ADR-0025's Jira
   amendment set: read per request, used only to verify, unset ⇒ every delivery is a 503.
7. **Only a non-expiring token is supported for now** — an *internal* integration's token. A
   public integration's installation-grant exchange and refresh (which would need the client
   secret on the flow function) is deferred, and would be an amendment here.

### Consequences

- A database dump plus the stage deployment's private key yields every Sentry token. That is the
  same exposure BYOK model keys already have, and the reason the key pair has a rotation seam
  (`keypair_id`, ADR-0026 §2) and a KMS path (M14).
- A compromised ingress can **replace** a Sentry token (any principal with `integrations.manage`
  can), but cannot **read** one.
- The intake and the post-back are independent: with no token, alerts still become tasks and
  nothing is posted; with no client secret, nothing is accepted.
- Sentry's region and self-hosted API hosts are not supported yet: comments go to
  `https://sentry.io`.
- The ADR-0025 sentence "we store no provider token" now has one named exception, amended there
  with a pointer here.
