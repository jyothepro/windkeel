# Signed webhook intake

Any system that can send an HTTP request — CI, PagerDuty, an internal tool — can start a Windkeel task
without a Windkeel client or token. It needs a **webhook endpoint**: a URL and a secret, tied to one
organization and one repository. (M8-5, #297; the intake contract is ADR-0025 §4–§5.)

For callers that *do* hold a Windkeel token, `POST /v1/tasks` also accepts an `Idempotency-Key`
header — see [the API](#post-v1tasks-with-idempotency-key) below.

## Making an endpoint

Needs `integrations.manage` in the organization (the admin role has it).

```sh
windkeel webhook create --name pagerduty --repo <repository-id> [--risk low|medium|high]
windkeel webhook list
windkeel webhook rotate <endpoint-id>      # new secret; the old one stops working at once
windkeel webhook delete <endpoint-id>
```

or `GET/POST /v1/webhook-endpoints`, `PATCH/DELETE /v1/webhook-endpoints/{id}` (`name`, `enabled`,
`defaultRiskLevel`), `POST /v1/webhook-endpoints/{id}/rotate`.

**Create and rotate answer the secret (`whsec_…`) once.** No other response ever carries it, and
Windkeel does not store it: it is derived on demand from the deployment's `WINDKEEL_WEBHOOK_SIGNING_KEY`
and the endpoint's id and secret version (ADR-0014: ingress can seal but never unseal, so there is
nothing it could keep a readable secret in). Without that variable, create, rotate and every delivery
answer `503 webhook_signing_unconfigured`. Rotating bumps the version; changing the signing key
retires every endpoint's secret at once.

**Rotation is a hard cutover.** The receiver accepts exactly one `v1=` signature, under the current
version's secret; there is no overlap window in which the old secret still works. Rotate, then
update the sender, and expect deliveries in between to be `401` (retry them with the new secret).

**The signing key must be at least 32 bytes.** Every endpoint owner holds one secret and knows its
`{id}:{version}`, so a short or guessable key could be recovered offline from that one pair, and
every other endpoint's secret derived from it. The key is used as the UTF-8 bytes of the variable's
trimmed text — it is not base64- or hex-decoded, so an encoded key counts by its characters.
Generate one with `openssl rand -base64 48`. A shorter key is treated as unset (`503
webhook_signing_unconfigured`) and the reason — its length, never the key — is logged once. Holding
this key on ingress is recorded in ADR-0023's 2026-09-25 amendment.

## Sending a task

```
POST /api/intake/webhook/{endpointId}
Content-Type: application/json
X-Windkeel-Timestamp: 1790000000
X-Windkeel-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{rawBody}")>
X-Windkeel-Delivery: <your id for this delivery, ≤200 chars>

{"title": "…", "description": "…", "riskLevel": "low", "externalId": "INC-1234"}
```

| Header | Rule |
| --- | --- |
| `X-Windkeel-Timestamp` | Unix seconds. Refused when more than **300 s** from the server's clock, either way. |
| `X-Windkeel-Signature` | `v1=` then the lower-case hex HMAC-SHA256, keyed with the whole secret string (including `whsec_`), over the timestamp, a `.`, and the **exact bytes** of the body. |
| `X-Windkeel-Delivery` | Required. Your id for this delivery; a redelivery with the same id is answered `duplicate` and does nothing. |

| Body field | |
| --- | --- |
| `title` | Required, ≤300 characters. |
| `description` | Required. Acceptance criteria are extracted from it exactly as for an issue (ADR-0012); with none, criteria are generated and the run waits for approval. |
| `riskLevel` | Optional `low` / `medium` / `high`; defaults to the endpoint's. |
| `externalId` | Optional, ≤200 characters. The task's reference becomes `webhook:{endpointId}:{externalId}`, so re-sending the same external item — even under a new delivery id — returns the existing task instead of making another. Without it, the delivery id is used. |

The task is created as the organization's `webhook` system actor, never as a person (ADR-0024 §2).

### Answers

| Status | Meaning | Retry? |
| --- | --- | --- |
| `202 {taskId, engineeringRunId}` | Task created (or, for a known `externalId`, found). | No. |
| `200 {duplicate: true}` | This `X-Windkeel-Delivery` was already handled. | No. |
| `200 {intent: "ignore", reason}` | Accepted but not acted on (the repository is no longer granted). | No. |
| `400` | Missing `X-Windkeel-Delivery`, or a bad body; `error` says which. | Not unchanged. |
| `401` | Bad signature, or timestamp outside the window. | Not unchanged. |
| `404` | No such endpoint, or it is disabled. | No. |
| `503` | Signing unconfigured, or the database was unavailable. | Yes, with backoff. |
| `500` | The task committed but could not be handed to the workflow; the delivery is released. | Yes — the retry finishes it. |

Retry with the **same** `X-Windkeel-Delivery` and a **fresh** timestamp and signature.

### curl and openssl

```sh
SECRET='whsec_…'; ENDPOINT='https://your-ingress.vercel.app/api/intake/webhook/<endpoint-id>'
BODY='{"title":"Fix flaky upload test","description":"- [ ] upload retries a 500 three times"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -sS -X POST "$ENDPOINT" -H 'content-type: application/json' \
  -H "x-windkeel-timestamp: $TS" -H "x-windkeel-signature: v1=$SIG" \
  -H "x-windkeel-delivery: $(uuidgen)" --data-raw "$BODY"
```

### Node

<!-- test/webhook-intake.test.js runs this block against the real receiver. Keep it self-contained. -->
```js
import { createHmac, randomUUID } from "node:crypto";
export async function sendTask(endpointUrl, secret, task, deliveryId = randomUUID()) {
  const body = JSON.stringify(task);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const headers = { "content-type": "application/json", "x-windkeel-timestamp": String(ts),
    "x-windkeel-signature": `v1=${sig}`, "x-windkeel-delivery": deliveryId };
  const res = await fetch(endpointUrl, { method: "POST", headers, body });
  return { status: res.status, body: await res.json() };
}
```

Or from a terminal, with the secret in the environment:

```sh
export WINDKEEL_WEBHOOK_SECRET='whsec_…'   # or read it from your secret store
windkeel webhook send <endpoint-id> --url <deployment-url> --title … --description …
```

That is the reference client. Prefer `WINDKEEL_WEBHOOK_SECRET` to `--secret`: a flag's value lands in
shell history and is visible to every user on the machine in `ps` while the command runs.

## `POST /v1/tasks` with `Idempotency-Key`

An automation retrying a request it never saw answered must not make a second task. Send
`Idempotency-Key: <≤200 printable characters>`:

- The key is recorded in the delivery ledger (`intake_delivery`, `source = 'api'`,
  `delivery_key = '{organizationId}:{principalId}:{key}'`) **in the task's own transaction**, with a
  SHA-256 of the canonical request body (keys sorted) and the response given.
- The same key with the same body answers **the original response, verbatim** — same `taskId`,
  `engineeringRunId` and `enqueued` — with header `Idempotent-Replayed: true`. Nothing is
  re-checked: a replay is not turned into a `404` by a grant withdrawn since, nor into a `503` by a
  workflow outage. When the first request's hand-over failed (`503 enqueue_failed`), the replay
  answers the stored `202` with `enqueued: false` and, as a side effect only, hands the run — if it
  never left `CREATED` — to the workflow again (idempotently); nothing starts twice.
- The same key with a different body is `422 idempotency_key_reused`.
- Keys are per organization and per principal: two callers using the same key are independent, and
  so is one token using the same key in two organizations.
- Keys do not expire while the ledger keeps the row; acted rows are kept (only ignored rows are
  pruned after 30 days).
