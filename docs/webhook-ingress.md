# The webhook ingress

The public half of the control plane (ADR-0002 §1). It receives GitHub App deliveries, validates
them, records what they mean, and returns. It never orchestrates: no model call, no sandbox, no
stage handler is reachable from this deployable.

## Endpoint

| | |
|---|---|
| Path | `POST /api/webhook` |
| Runtime | Node (not Edge — the ingress writes to Postgres over TCP; see `apps/ingress/api/webhook.ts`) |
| Body parsing | Disabled. The raw bytes are what GitHub signed, and a re-serialised parse does not reproduce them. |
| Source | `apps/ingress/api/webhook.ts` (adapter) → `apps/ingress/src/handler.ts` (everything that matters) |

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | The delivery record and the repository row (ADR-0021, carrying ADR-0007 §1: Postgres is authoritative). Must be the direct session-mode endpoint — the sweeps' advisory locks break silently through the transaction pooler (ADR-0008 §1). |
| `GITHUB_WEBHOOK_SECRET` | yes | Every delivery's `X-Hub-Signature-256` is verified before anything is persisted (ADR-0009 §6). |
| `GITHUB_APP_ID` | yes | The App's own identity, for the comment the ingress posts back on the issue. See below. |
| `GITHUB_APP_PRIVATE_KEY` | yes | The PEM behind that identity. A raw PEM, a PEM with `\n` escapes, or base64 of one all work. |
| `CRON_SECRET` | no | Not read by this function. Authorises `/api/sweep`, the hourly evidence-retention and sandbox-reaper tick, which fails **closed** without it — so a deployment that omits it serves webhooks perfectly and silently never sweeps. See `docs/sweeps.md`. |
| `WINDKEEL_WORKFLOW_BACKING` | no | Which durable machinery carries a run. `vercel-workflow` is the only value and the default since #200. A deployment still setting `pg-boss` is refused *by name*, because #199 shipped that as the default and a rollout may not have caught up. An unrecognised value is an error, not a fallback. |

| `WINDKEEL_DEPLOYMENT_URL` | no | Read by `windkeel-admin doctor`, not by the function: the deployment whose workflow runtime should be carrying runs. Without it the deployment check skips. |
| `CRON_SECRET` | no | Authorises `POST /api/sweep` (#226) and `GET /api/preflight` (#230). Both fail closed when it is absent: every hourly sweep 401s, and the preflight cannot be asked. Not read by the webhook function, which is why the contract test does not list it among the required four. |
| `WINDKEEL_WEBHOOK_SIGNING_KEY` | no | Not read by the webhook function. Read per request by `/api/intake/webhook/{id}` and the `/v1/webhook-endpoints` writes: every signed-webhook endpoint secret is derived from it and none is stored (M8-5, `docs/webhook-intake.md`). Without it — **or with fewer than 32 bytes** (the UTF-8 text, not decoded; `openssl rand -base64 48`), which is treated as unset and logged once — those answer `503 webhook_signing_unconfigured`. As sensitive as every endpoint secret together; permitted on ingress by ADR-0023's 2026-09-25 amendment. |

**This project needs far more than the table above.** The flow function executes a run's stages,
so it reads the *whole* factory configuration —
the sandbox credentials, the model keys and `WINDKEEL_MODEL_*`, the `S3_*` evidence store,
`WINDKEEL_REPOSITORY_URL`, and the rest of what `docs/running-the-factory.md` lists.

**The sandbox credentials are named differently here, and this is the one variable you cannot
copy across from a container deployment.** A container reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and
`VERCEL_PROJECT_ID`. Inside a Vercel deployment `VERCEL_PROJECT_ID` is a *system* variable holding
the id of the project being run, and a project variable of that name does not override it — so a
deployment that relied on it would ask Vercel to create the maker's sandbox inside the control
plane's own project. Vercel refuses that with `403 … You don't have permission to create the
vercel sandbox`, at PROVISIONING, naming neither the project nor the variable. Set
`WINDKEEL_SANDBOX_TOKEN`, `WINDKEEL_SANDBOX_TEAM_ID` and `WINDKEEL_SANDBOX_PROJECT_ID` instead; they take
precedence wherever they are set, and inside a deployment the fallback is refused outright rather
than guessed at. `windkeel-admin doctor` validates the same set. Two consequences worth
stating plainly: the deployment holds production secrets on every route (see "Why one deployment"
below), and a variable missing there fails a *stage*, mid-run, rather than at deploy.

All four required ones are read when the function initialises, and a missing one fails immediately
with a message naming the variable — a function that starts happily and discovers a missing secret
on the first real webhook has already told GitHub the delivery failed.

**The App credentials are not a contradiction of "it never orchestrates".** The ingress answers on
the issue: it says why it ignored a labelled issue that was closed, and it posts the run-start
comment naming the criteria a run will be verified against. Those are GitHub API calls made after
the delivery's transaction commits, and they need the App's identity — `apps/ingress/api/webhook.ts`
builds a `RestGitHubClient` at module scope for exactly that, which is why the function will not
initialise without them. What the ingress still never does is hold a blocking step of a run: no
model call, no sandbox, no stage handler. The boundary is orchestration, not network.

## App configuration

Subscribe to exactly the five events ADR-0009 §2 (as amended for #432) names, and nothing else:

- `issues` — `labeled` (the `windkeel` trigger) and `unlabeled` (cancellation).
- `issue_comment` — `created`, for `/windkeel approve` and `/windkeel cancel` (ADR-0009 §3, ADR-0012).
- `pull_request` — `closed`, so a human merging or closing drives the task to a terminal status.
- `pull_request_review` — `submitted` with changes requested, or commented with text, on a pull
  request Windkeel opened: a suggested repository-knowledge note (ADR-0032).
- `pull_request_review_comment` — `created`, the same for an inline comment.

Permissions are ADR-0009 §1's: Metadata read, Issues read/write, Contents read/write, Pull
requests read/write, Checks read/write. Nothing organisation-level.

## Preflight: `GET /api/preflight`

`windkeel-admin doctor` validates the environment of the process it runs in, so from a laptop it validates
the laptop — it can be entirely green while the deployment is broken. This route runs **inside the
deployment** and reports what *its own* environment contains:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/preflight
```

| | |
|---|---|
| Authorisation | `Bearer $CRON_SECRET`, constant-time, **failing closed when the variable is absent** — the same mechanism as `/api/sweep`, deliberately rather than a second one. |
| Status | `200` with the report whenever one can be produced, **including when checks fail** — read the `ok` field. `401` unauthorised, before any database connection. `500` only if the route itself throws. |
| Reports | Every variable the deployed path reads, as present/absent and **never as a value**; `CRON_SECRET` specifically; `DATABASE_URL` reachable and in session mode (ADR-0008 §1, reusing `doctor.ts`'s pooler detection); the evidence store if configured; whether the App's credentials authenticate. |
| Schedule | None. It is asked, not scheduled. |

**Nothing in the response is a value.** Presence and length only, and the body is scrubbed against
every configured value *after* serialisation — so a value arriving by some unanticipated path,
such as a driver error quoting the connection string, cannot route around the discipline.

**When `CRON_SECRET` is itself absent this route 401s**, so it cannot report that absence in its
body. An operator who curls with the value they meant to set and gets a 401 has their answer,
though it is indistinguishable from having sent the wrong one. That is the accepted cost of not
adding a second secret; once authorised, the `cron-secret` check is unambiguous.

## Responses

| Status | When | GitHub's behaviour |
|---|---|---|
| 200 | Handled, ignored (with a reason), or a duplicate delivery | Done |
| 400 | Missing `X-GitHub-Event`/`X-GitHub-Delivery`, or a body that is not JSON | No retry — correct, since neither improves on a second attempt |
| 401 | Signature missing, malformed, or wrong | No retry |
| 500 | Our fault (database unavailable, action failed) | Retries, which is what we want |

An ignored event returns its reason (`label bug is not the trigger`, `event push is not
subscribed`, `… is a fork`). That string is usually the fastest answer to "I added the label and
nothing happened". Since M8 (#293) it is also **recorded**: the delivery gets an
`intake_delivery` row with `intent = 'ignore'` and the reason, so the question can be answered
from the database after GitHub's delivery log has rotated —
`select received_at, event, action, reason from intake_delivery where source = 'github' and intent = 'ignore' order by received_at desc`.
A redelivered ignored event answers `duplicate`. Ignored rows are pruned after 30 days by the
hourly sweep (`docs/sweeps.md`).

Responses never echo the payload: these bodies carry private repository content.

## Idempotency

GitHub redelivers. Two mechanisms, doing different jobs:

1. **`intake_delivery`** (migrations/0023, which replaced 0006's `webhook_delivery` and copied its
   rows in as `source = 'github'`) keyed on `(source, delivery_key)` — for GitHub,
   `('github', X-GitHub-Delivery)` — "have I seen this exact event?". The row is written **in the
   same transaction as the work it causes**, so a failed delivery leaves no record claiming it was
   handled and the retry does the work.
2. **A partial unique index on `engineering_task (repository_id, source_reference)** where
   `source_type = 'github_issue'` — "does this issue already have a task?". Two *different*
   deliveries about one issue are not caught by the delivery id, and select-then-insert loses
   that race; the database arbitrates instead. ADR-0009 §3 wants one task per issue anyway:
   re-labelling starts a fresh **run** on the same task.

Every other source gets the second mechanism from migrations/0023's
`engineering_task (organization_id, source_type, source_reference)` unique index (all source types
except `github_issue` and `local`), enforced by `createTaskFromIntake`.

## The delivery ledger: `intake_delivery`

One table records every delivery from every source (ADR-0025 §4). For the Connect-carried sources
(Slack, Linear) it is the **only** record of what arrived — Connect keeps no per-event log.

| Column | |
|---|---|
| `source`, `delivery_key` | Primary key. The `IntakeSource.name` and the provider's own event id. |
| `organization_id` | Whose delivery, when the source could tell (GitHub: from the task it touched). |
| `event`, `action` | The provider's event name and action. |
| `intent` | What the intake decided: `ignore`, `create_task:started`, `command:approve:…`. |
| `reason` | Why an ignored event was ignored. Never payload content. |
| `engineering_task_id` | The task the delivery created or touched, when there was one. |
| `received_at` | When. Ignored rows older than 30 days are pruned; acted rows are kept. |

## The intake pipeline, and `/api/intake/:source`

Since #293 the ordering rules above are not GitHub's: they are `runIntake`
(`src/intake/pipeline.ts`), and GitHub is one `IntakeSource` on it (`apps/ingress/src/handler.ts`).
Every M8 source plugs in the same way:

```ts
interface IntakeSource<P> {
  name: string;                                    // the ledger's `source`
  verify(req: RawRequest, { db }): Promise<VerifyResult>; // before any parse; failure ⇒ 401
                                                   // `db` is read-only: `{ query }`, no transaction
  parse(req: RawRequest): P;                       // failure ⇒ 400 (never echoes the body)
  deliveryKey(req: RawRequest, payload: P): string;
  interpret(payload: P, ctx): Promise<IntakeIntent>; // ignore(reason) | {kind:"act", intent, act(tx)}
}
runIntake(source, req, { pool, transientStatus? }) → { status, body, reply? }
wireResponse(response) → reply ?? { status, body }   // what every adapter sends
```

**The response seam: `reply`.** A source's contract sometimes names its own answer — the signed
webhook answers `202 {taskId, engineeringRunId}`; a chat source may answer with what the provider
should show. There is exactly one channel for that: inside `act`, `tx.reply(status, body)`. The
pipeline then returns its usual fixed-shape `{status, body}` **plus** `reply: {status, body}`, and
the adapter sends `reply` **instead of** `body` (`wireResponse`, used by `api/intake.ts`). The rules:

- The last `tx.reply` wins. `body` is serialised as JSON and, like every answer here, never carries
  payload content or a secret.
- A reply only describes work that committed and was handed on. It is dropped — the pipeline
  answers as it would have — when the act later calls `tx.ignore` (200 ignore), when the
  after-commit work fails (500), and it cannot arise on a duplicate (which never reaches `act`) or
  any rejection before `act`.
- Nothing is merged: the pipeline's own `body` keeps its fixed shape (`ok`, `intent`, `reason`,
  `duplicate`, `error`) whether or not a source replied.

Two more writers use the **same** `reply`, never a second mechanism (#307):

- `IntakeSource.respond?(response, payload) → IntakeReply | undefined` shapes the answer for
  outcomes `act` never sees — an ignore, a duplicate, a failure (a Slack slash command shows its
  response text whatever happened). It runs once the payload parsed, only when the response does
  not already carry a reply (an act's `tx.reply` wins). A throw is logged (`intake respond
  failed`) and the pipeline's own answer goes out.
- An `answer` intent (`{kind: "answer", reason, reply}`) is a protocol handshake — Slack's
  `url_verification` — answered with its `reply` and **nothing written**: no ledger row, no
  connection.

Precedence: `answer` → `tx.reply` → `respond` → the pipeline's own `{status, body}`.

| Outcome | Status | Ledger |
|---|---|---|
| verification fails | 401 (or the status `verify` names) | nothing — no parse, no connection |
| body does not parse | 400 | nothing |
| ignored | 200 `{ok, intent:"ignore", reason}` | row, `intent='ignore'`, `reason` |
| ignored by `act` (`tx.ignore(reason)`, e.g. a label on a closed/locked issue) | 200 `{ok, intent:"ignore", reason}` | row, `intent='ignore'`, `reason`; the act's after-commit still runs |
| acted | 200 `{ok, intent}` — or the act's `tx.reply(status, body)`, sent instead | row, committed with the work `act` did in the same transaction |
| duplicate `(source, delivery_key)` | 200 `{…, duplicate:true}` | unchanged (rolled back) |
| `act` throws | 500 | nothing (rolled back) |
| after-commit throws (enqueue, reply) | 500 | row **deleted**, so the provider's retry finishes the job; if the delete fails too, one log line tagged `intake_delivery_release_failed` names the source and delivery key |
| transient database failure | **503** (GitHub: 500, as it always was) | nothing |

503 rather than 500 for a database outage because Vercel Connect retries only 500/502/503/504,
and a 503 says "retry" unambiguously (ADR-0025 §5). GitHub's route passes `transientStatus: 500`
so its responses are unchanged.

A 5xx body is a fixed message per status (`internal error`, `service unavailable`) — never the
error's own text, since a provider error can quote a token. The log line gets the error's name,
code and a message passed through `redactSecrets` (bearer/basic credentials, `xox?-`, `lin_`,
`orq_`, `gh?_`, `github_pat_`).

**Creating work.** An `act` that creates a task calls `createTaskFromIntake(tx.db, input, {startRun})`
(`src/intake/create-task.ts`) — the same function `POST /v1/tasks` and the GitHub label use. It
extracts criteria exactly as the API always has, applies rails, dedupes on
`(organization, source_type, source_reference)`, stores `source_context` (where the source's
notifier finds its way back: a Slack thread, a Linear issue id — never a secret) and the creating
principal, and returns `{taskId, runId, created, criteria, afterCommit}`. `afterCommit` enqueues.

**Hearing back.** A source registers a `SourceNotifier` (`src/intake/notifiers.ts`) for its
`source_type`; `advanceRun` calls it after any transition into a terminal state,
`WAITING_FOR_HUMAN` or `WAITING_FOR_APPROVAL` (`outcome.kind = "state"`), and once when the run
first leaves `CREATED` for a non-terminal state (`outcome.kind = "started"`, #307;
`notifiableOutcomeKind`). `started` lets a source anchor its conversation from the flow function
before any other outcome (Slack's thread root); a notifier with nothing to say returns on it —
Linear and Jira do (their start comments are the intake's), and GitHub has no notifier. Each call is bounded (10 s by default, a notifier's
own `timeoutMs` if set; the notifier gets an `AbortSignal`), and a failure or timeout is logged
(name, code, redacted message) and never fails the run. A workflow step retried after its
transition committed repeats the same `advanceRun(to, reason)`: that is a replay — it writes
nothing, returns the committed transition and notifies again — so notifiers must be idempotent.

The seam (#306): `notifyRunOutcome(pool, run, transition)` takes the committed
`run_state_transition` row, and `SourceNotifier.notify(task, run, outcome, signal)` receives
`outcome = {kind, transitionId, state, reason, terminal}`. **`transitionId` is the idempotency key**: a
replayed step is handed the same row, so the same id; a genuine second entry into a state (a rework
cycle back to `WAITING_FOR_HUMAN`) is a new row and a new id. Keying on `runId:state` would
suppress the second entry; keying on a count of transitions read at notify time mis-assigns a late
replay. Linear derives its comment UUID from it; Slack keys its claim on it.

Notifiers are registered by one hook, `registerDeploymentNotifiers({pool, env})`
(`src/factory/workflow/deployment-notifiers.ts`), called once from the flow function's
`buildAndPublish`. Each provider's notifier is registered only when its `WINDKEEL_CONNECT_*` is set,
so a GitHub-only deployment registers none and `advanceRun` makes no notifier query. GitHub
registers none — its comments are posted by its stage handlers, as before.

**A run whose enqueue failed is not left in `CREATED`.** The first heal is the provider's retry
(the after-commit failure releases the delivery row and answers 500). A retry can be refused (a
replay window), late, or never sent, so the sweep `requeueStrandedCreatedRunsLocked`
(docs/sweeps.md) re-enqueues any run still `CREATED` with no `workflow_run_binding` ten minutes
after creation. Replay windows stay strict.

**The route.** `POST /api/intake/:source` (`apps/ingress/api/intake.ts`, its own function in the
Build Output with the same raw-body handling as the webhook) dispatches to the source registered
under that name (`registerIntakeSource`, wired in `apps/ingress/src/intake-sources.ts`). An
unregistered name is a 404 before any database work. The body is then read before anything else:
capped at 1 MiB (413, refused on a declared `content-length` before reading), and a broken stream
is a 400. It reads `DATABASE_URL` lazily. GitHub is not
on it: the App's configured URL stays `/api/webhook`.

Shared signature helpers for sources that sign with an HMAC (`src/intake/hmac.ts`):
`verifyHmacSha256({secret, body, signature, prefix?, encoding})` (constant time) and
`withinTolerance(timestampSec, nowSec, 300)`. GitHub's `signature.ts` is built on them.

## Deploying it

**This deployment serves two things**: the GitHub webhook at `/api/webhook`, and — since
[ADR-0020](adr/0020-the-control-plane-is-vercel-end-to-end.md) — the Vercel Workflow runtime at
`/.well-known/workflow/v1/flow`, which is what executes a run's stages when
`WINDKEEL_WORKFLOW_BACKING=vercel-workflow`. They are one deployment and that is forced, not chosen;
see "Why one deployment" below.

**Root Directory is `apps/ingress`, not the repository root.** Set it in Project Settings → Build
& Deployment → Root Directory, and leave "Include files outside the Root Directory" **on** (its
default) — the build climbs to the workspace root.

**`buildCommand` is `cd ../.. && npm run build && npm run -w @windkeel/ingress build:vercel`.** Two
halves:

- The root build, because `apps/ingress/src` imports `windkeel/dist/factory/...`, which does not
  exist until the root `tsc` has run, and the root build in turn needs `@windkeel/verification`
  built first. `installCommand` climbs the same two directories so npm installs the workspace root
  rather than treating `apps/ingress` as a lone package.
- `build:vercel`, which emits `.vercel/output` — the [Vercel Build Output
  API](https://vercel.com/docs/build-output-api/v3) directory. When that directory exists Vercel
  deploys it verbatim and ignores the `api/` convention, `outputDirectory` and `functions`
  entirely. Those keys are therefore **absent** from `vercel.json` rather than left as decoration.

### Why a build script and not two more functions in `api/`

The flow route cannot be an ordinary function. `VercelBuildOutputAPIBuilder` registers it with an
`experimentalTriggers` **queue subscription** (`type: queue/v2beta`, topic `__wkf_workflow_*`), and
that subscription is how the Vercel Queue System discovers the function as the consumer for
workflow messages. `vercel.json` has no field for it. A hand-written `api/flow.ts` plus a rewrite
would deploy cleanly, answer an HTTP probe, and never be dispatched to — which is the worst
available failure shape, because everything looks healthy.

So `apps/ingress/build-vercel-output.mjs` calls the SDK's own builder — the same code path
`workflow/next`, `/nitro` and `/nest` go through — and adds this app's webhook function beside it.
Its header explains the one genuinely odd thing it does: the build runs with its working directory
set to the repository's `src/`, because that is what the workflow **id** is derived from, and the
emitted output is then moved here. `test/workflow-deploy-build.test.js` asserts the id that comes
out.

### Why one deployment, and what it costs

The obvious split — webhook in one Vercel project, workflow runtime in another — is not available.
`@workflow/world-vercel` addresses every queue message to the **producer's own** deployment
(`opts?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID`), so a webhook that calls `start()` in
project A addresses the message to project A, which would have no flow function. Producer and
consumer are one deployment by construction.

Two things follow that an operator needs to know:

- **Only the deployment can start a run on this backing.** A process that is not inside a deployment
  has no deployment id, so `start()` throws. Runs are started by the deployed webhook or by the
  deployed API (`POST /v1/tasks`, `POST /v1/runs` — what `windkeel submit` calls), both of which
  enqueue to their own deployment. `windkeel-admin task create`, which enqueued from wherever it ran,
  was removed for this reason (ADR-0023 §10).
- **Every function in this deployment can read every environment variable**, including
  `VERCEL_TOKEN`, the model keys and the App private key — Vercel scopes variables per project and
  environment, not per function. Under ADR-0002 the webhook deployment held none of the three.
  ADR-0020's Consequences record this as an accepted cost with the residual risk stated;
  [ADR-0014](adr/0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §1 and §2 are
  unaffected.

The separation that *does* survive is at the code level, and it is tested rather than asserted:
the webhook's bundle contains no sandbox SDK, no object store client and no agent adapter, while
the flow function's contains all three. That holds because `tick` reaches the stage graph through
an `import()` inside the step body, and nothing the webhook imports references `tick`, so esbuild
eliminates it. `test/ingress-deploy-config.test.js` is what keeps it true.

### Deployment Protection

Vercel turns it on by default for new projects, and it 302s every unauthenticated request to SSO
— **including GitHub's webhook deliveries**, which is a silent "the App is configured and nothing
happens". Either turn it off for this project, or append the automation bypass secret to the
Webhook URL's query string. The internal queue dispatch to the flow function is a separate path
and is not affected.

### Durations

**The webhook is capped at 30s.** GitHub gives up waiting after 10 and retries, so this is not
about GitHub's patience — it is about not killing the function *mid-transaction* on a slow cold
start plus a slow first connection. The delivery is idempotent (`intake_delivery`, keyed on
`X-GitHub-Delivery`), so a retry after a slow success is harmless; a function terminated between
the commit and the after-commit GitHub call is not.

**The flow function is capped at `max`** (800s on Pro). A Workflow *step* runs there, and
`session-turn.ts`'s poll arithmetic is built on the step not being the binding constraint — a run
waits in `sleep`, outside any step, which is what makes its total duration unbounded. Lowering
this silently shortens the longest agent turn a stage can drive.

### Node version

Both functions pin `nodejs22.x` in their `.vc-config.json`, written by the build script. That
replaces the old reliance on `engines.node` in the Root Directory's `package.json`, which is what
Vercel reads under the `api/` convention and does not read here. The repository's real floor,
`>=22.12.0`, stays in the root `package.json` where npm and CI enforce it.

## Local development

The handler is importable and needs no server:

```js
import { handleWebhook } from "@windkeel/ingress/dist/src/handler.js";
import { signWebhookBody } from "@windkeel/ingress/dist/src/signature.js";

const rawBody = JSON.stringify(payload);
await handleWebhook(
  {
    headers: {
      "x-github-event": "issues",
      "x-github-delivery": "local-1",
      "x-hub-signature-256": signWebhookBody(secret, rawBody),
    },
    rawBody,
  },
  { secret, pool, actions },
);
```

`test/ingress-handler.test.js` drives it exactly this way, including against a real Postgres when
`TEST_DATABASE_URL` is set.
