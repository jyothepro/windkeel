# ADR-0023: The control plane API reads direct, writes intents, and updates resume from a cursor

- Status: Accepted; amended by ADR-0024, ADR-0029 (proposed)
- Date: 2026-09-23

## Context

M7 puts a surface on a factory that has never had one.

## Decision

- §1 — The API lives on ingress, versioned `/v1`: It is the surface ADR-0002 §1 already allotted.
- §2 — Reads query Postgres directly. Writes persist an intent and return `202`: A read is one round trip against the authoritative store.
- §3 — Every command shares its implementation with the GitHub comment path that already does the same job: Approve and cancel are one mechanism with two doors, not two mechanisms.
- §4 — The API offers no merge, approve-PR, or ready-for-review: `GitHubClient` refuses those because they are not capabilities this system has (ADR-0009).
- §5 — Updates are a per-run, cursor-ordered event feed: over the two append-only tables ADR-0013 already requires — `run_state_transition` (§2) and `cost_event` (§1).
- §6 — SSE is a transport over that feed, never a second source: The stream carries the same events with the same cursors, and on being cut emits its cursor for the client to resume from.
- §7 — The feed is per run because that is the only scope where a cursor is safe.
- §8 — Steering may change *how*, never *what*: `POST /v1/runs/{id}/messages` reaches a live maker through the `WorkerAdapter.send()` the repair loop already uses.
- §9 — Secrets are repository-scoped and write-only on read-back: We broker the model key (ADR-0014 §1) and the scoped git token (§2) and nothing else, which means a repository needing a private registry credential cannot be built at all.
- §10 — The CLI splits, and half of it must not move: `task`, `reap`, `metrics`, `doctor` and `run capture` open a Postgres pool directly today and become API clients, because a CLI anyone else runs cannot hold the database's credentials.
- §11 — Auth is one operator token, and orgs/users land in this milestone: as ADR-0001 planned: additive tables, one added column on `repositories`, one backfill.

## Consequences

- **Nothing new to run.** SSE is HTTP/1.1 with `text/event-stream` and chunked writes; ingress already handles the raw Node request/response objects, and Vercel's Node runtime has full Node.js API coverage.
- **The SSE handler polls Postgres internally**, because the transaction pooler forecloses `LISTEN/NOTIFY`.

**Later changes** (full text in Background):

- Amendment, 2026-09-24 — §8 is delivered by the worker, and §9 is built
- Amendment, 2026-09-25 — §10 is delivered, and §1 bends for two routes
- Amendment, 2026-09-25 — §1 admits one more ingress secret: `WINDKEEL_WEBHOOK_SIGNING_KEY` ([#297](https://github.com/jyothepro/orqon/issues/297))

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-23
- Milestone: 7 (Product UI, REST API and CLI)

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed), §1 and §4: the API gains take-over, hand-back, submit, workspace-read and merge intents. Merge uses the signed-in person's GitHub token, never the App's; creating a human workspace is a third bend of §1 after reap and capture.

### Context

M7 puts a surface on a factory that has never had one. Every run so far was driven from a
terminal in this repository or from a GitHub label, and read back out of Postgres by hand.

Most of the shape is already decided. [ADR-0002](archive/0002-control-plane-is-hybrid-vercel-ingress-plus-worker-container.md)
§1 puts "the webhook receiver **and the thin API**" on Vercel, and §3 says ingress "validates,
persists/enqueues, and returns — nothing on the Vercel side ever holds a blocking step of a run."
[ADR-0007](archive/0007-pg-boss-backs-workflowprovider-postgres-is-authoritative.md) §1 makes Postgres authoritative.
[ADR-0001](archive/0001-v1-single-tenant-product-shape.md) says one operator until this milestone.

What was open: the endpoint set, how a client learns that something happened, and whether either
needs anything we do not already run.

Two investigations settled the rest.

**Devin's published v3 OpenAPI document** — 237 operations, 197 distinct once the same operation
in org and enterprise scope is counted once, of which 113 are RBAC, billing, infrastructure and a
code-scanning product. The comparable core is 84. Read against ours it named four things we had
simply not thought of, and confirmed one we had.

**Vercel's function limits.** Fluid compute caps a Node function at 300s on Hobby (default *and*
maximum) and 800s on Pro, "including streamed responses". Runs take ten minutes to an hour. And
ADR-0008 §1 puts ingress behind the Supavisor **transaction** pooler, which cannot deliver
asynchronous notifications — so `LISTEN/NOTIFY` is unavailable on this hop regardless of whether
the function is alive to hold it.

### Decision

1. **The API lives on ingress, versioned `/v1`.** It is the surface ADR-0002 §1 already allotted.
   It keeps ingress's secret surface: the webhook secret and the GitHub App credentials, and no
   model key or `VERCEL_TOKEN`. **An endpoint that would need those is in the wrong process.**

2. **Reads query Postgres directly. Writes persist an intent and return `202`.** A read is one
   round trip against the authoritative store. A write is not an action: `POST /v1/runs/{id}/cancel`
   records a signal and the worker container acts on it. A `200` would be a claim about work that
   has not happened.

3. **Every command shares its implementation with the GitHub comment path that already does the
   same job.** Approve and cancel are one mechanism with two doors, not two mechanisms. #228 was
   two surfaces rendering the same run differently; the same divergence in a *command* is worse
   than a cosmetic one.

4. **The API offers no merge, approve-PR, or ready-for-review.** `GitHubClient` refuses those
   because they are not capabilities this system has (ADR-0009). An API offering them would be
   claiming otherwise.

5. **Updates are a per-run, cursor-ordered event feed** over the two append-only tables ADR-0013
   already requires — `run_state_transition` (§2) and `cost_event` (§1). We are not inventing an
   event log; we are exposing the two we are obliged to keep. The page envelope is
   `{ items, endCursor, hasNextPage }`, and `endCursor` is never null: an idle run returns the
   caller's own cursor so a polling client always holds a usable position.

6. **SSE is a transport over that feed, never a second source.** The stream carries the same
   events with the same cursors, and on being cut emits its cursor for the client to resume from.
   The stream *will* be cut mid-run, every run, because the duration cap is shorter than a run.
   **The run is durable; the connection never is** — so the design goal is not an uninterrupted
   stream, it is making interruption free. Nothing may require the client to have been connected.

7. **The feed is per run because that is the only scope where a cursor is safe.** `seq` is drawn
   at insert and becomes visible at commit, so in general a reader can advance past a row not yet
   committed and never see it. What closes the gap is the `engineering_run` row lock, which both
   writers take: `advanceRun` already locked with `for update` before writing its transition, and
   `recordCost` now takes it **before** its insert rather than after. A feed across runs has no
   such lock and would need a visibility watermark; it is therefore not offered.

8. **Steering may change *how*, never *what*.** `POST /v1/runs/{id}/messages` reaches a live maker
   through the `WorkerAdapter.send()` the repair loop already uses. But a run holds a contract —
   the criteria it will be judged against — so a message that changes the goal invalidates the bar
   silently. Changing what a run is for means new criteria, and new criteria mean the ADR-0012 §4
   approval gate again. A session without acceptance criteria has no such constraint, which is why
   Devin's equivalent endpoint is unrestricted and ours cannot be.

9. **Secrets are repository-scoped and write-only on read-back.** We broker the model key
   (ADR-0014 §1) and the scoped git token (§2) and nothing else, which means a repository needing
   a private registry credential cannot be built at all. The management surface lands here rather
   than with BYOK: these are the repository's secrets, not the customer's model keys. Responses
   carry the key, the note and who set it. There is no field for the value.

10. **The CLI splits, and half of it must not move.** `task`, `reap`, `metrics`, `doctor` and
    `run capture` open a Postgres pool directly today and become API clients, because a CLI anyone
    else runs cannot hold the database's credentials. **`verify`, `seal`, `verify-package`,
    `replay` and `bench` keep working with no server, no token and no network** — they are the M0
    engine on the user's own machine, and that is the open-source PR gate.

11. **Auth is one operator token, and orgs/users land in this milestone** as ADR-0001 planned:
    additive tables, one added column on `repositories`, one backfill.

    > Amended by [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md):
    > the tables are account, organization and principal; repositories are granted to
    > organizations rather than owned by one; the added column is on the task; and the operator
    > token survives as a bootstrap credential beside per-principal tokens.

### Consequences

- **Nothing new to run.** SSE is HTTP/1.1 with `text/event-stream` and chunked writes; ingress
  already handles the raw Node request/response objects, and Vercel's Node runtime has full
  Node.js API coverage. No new dependency, and `packages/verification` keeps `dependencies: {}`.

- **The SSE handler polls Postgres internally**, because the transaction pooler forecloses
  `LISTEN/NOTIFY`. SSE does not remove polling; it relocates it server-side, which is still the
  win: one client connection instead of hundreds of requests, and sub-second latency instead of a
  poll interval.

- **A stream needs its own connection, not a slot in the webhook pool.** `webhook.ts` holds
  `new Pool({ max: 2 })` per warm instance; under fluid compute a stream holding one of those for
  the duration of a run could starve a GitHub delivery on the same instance, and a failed delivery
  is one GitHub retries into a wall.

- **The ceiling is file descriptors** — 1,024 shared across concurrent executions, each stream
  costing a socket plus a database connection. Irrelevant at one operator; it is the number that
  decides how many viewers can watch at once.

- **Cost scales with watching, not with events.** Vercel bills active CPU, and I/O wait does not
  count; a stream sleeping between polls is cheap on CPU and pays provisioned memory for its wall
  clock.

- **Two schema changes were prerequisites, not niceties** (`migrations/0017`): a `seq` cursor on
  both append-only tables, and `engineering_run.created_at`, which had never existed — its only
  anchors were `started_at` and `completed_at`, both null for a run that has not begun, which is
  why `listEngineeringRuns` ordered by a random uuid.

- **Three of Devin's four gaps are additive; one is not.** `GET /v1/self` and `GET /v1/queue` were
  oversights. Secrets is a missing capability that silently bounds which repositories Windkeel can
  build. Steering is the one with a real design constraint attached, recorded in §8.

- **What we are not copying**: model-generated session summaries. Our equivalents — the evidence
  package and the run report — are derived from rows and artifacts. When the question is "what
  happened and can I trust it", a model's summary of a model's work is the wrong instrument; run
  `db2bdce9` is why we know that, because the summary everyone believed for two days was wrong and
  only `mapping.json` settled it.

### Amendment, 2026-09-24 — §8 is delivered by the worker, and §9 is built

Two of this record's decisions shipped as refusals. `POST /v1/runs/{id}/messages` answered "this
deployment cannot reach a live maker session" on every call, and the three secrets routes answered
`501`. Both are now implemented, and one of them required correcting this ADR rather than only
extending it.

#### §8: the API queues; the worker delivers at a turn boundary

§8 says guidance "reaches a live maker through the `WorkerAdapter.send()` the repair loop already
uses". That sentence is true about the mechanism and was wrong about the caller, and the code
followed the wrong reading: `control.ts` grew an optional `sendToMaker` port that nothing could ever
supply.

Nothing could supply it for two independent reasons, either of which settles it:

1. **§1 and ADR-0002 §3.** A function on this hop calling `send()` would be driving an agent session
   from ingress. §1 also keeps `VERCEL_TOKEN` out of this process by name — and re-acquiring a
   `WorkerSession` means attaching to its sandbox, which needs exactly that token.
2. **`send()` starts a turn, and a turn cannot start while one is running.**
   `CodexWorkerAdapter.send` refuses outright, because "two concurrent codex processes mutating one
   workspace is a corrupted attempt with no clean recovery". There is no interrupt primitive on this
   interface, and there is no version of this feature that delivers instantly.

So guidance is an intent like every other write (§2). The API validates that a maker is listening,
writes a `run_guidance` row and answers **202 `queued`**. `pollSession` — which already runs once a
minute to enforce the ADR-0011 rails — claims pending guidance under the run's row lock at the next
turn boundary and sends it as one new turn.

Three consequences worth stating, because each one is a thing a reader would otherwise get wrong:

- **The latency is real and is published.** The rest of the current turn, plus up to one poll
  interval. `windkeel say` prints it and the MCP tool description says it, specifically so that an agent
  does not re-send guidance because the next minute of output looked unchanged.
- **Delivery is ordered after the rails, not before.** A run stopped by a spend or wall-clock cap does
  not get a new turn started on it; steering must not be a door through the caps.
- **A run can end with guidance undelivered**, and that is reported as `superseded` rather than left
  reading `queued`. The state is derived from the run, so it cannot drift from the run.

An unbounded stream of guidance extends a session indefinitely, and the bound on that is ADR-0011's
spend cap and wall clock — checked on the poll immediately before each delivery — not a turn counter
here, which would be a second and weaker cap on the same thing.

##### Three alternatives, considered and declined on 2026-09-24

Recorded because each one is the first thing a reader hits this limitation and reaches for, and a
decision nobody wrote down gets re-litigated by whoever is most annoyed by it.

**Interrupting the running turn (`windkeel say --now`).** Technically available: the adapter's refusal is
about two *concurrent* processes, and cancel-then-resume is a different sequence. Declined because the
agent would be killed at an arbitrary instant — possibly mid-file-write — and would resume with no
knowledge that it had been interrupted. A truncated file then reaches the verifier as a genuine
defect, and the run's evidence would blame the candidate for something the control plane did. The
limitation this accepts is real and worth stating plainly: **an operator who sees an agent twenty
minutes into the wrong approach cannot redirect it any faster than the turn ends.** Their only faster
lever is `windkeel cancel`, which ends the run.

That made the bluntness of `cancel` worth examining, and it was blunter than it looked: candidate
capture runs at the end of a turn, so a cancellation — and equally an ADR-0011 cap trip — destroyed
the sandbox with every uncommitted edit still inside it. Twenty minutes of agent work, paid for,
discarded, with no branch and nothing to read. **A stop now captures the candidate before the teardown**
(`session-turn.ts`, `SessionPollOptions.beforeTeardown`), so the work lands on the run branch and the
run says where. The capture is best-effort and cannot prevent the teardown, because the invariant it
sits inside — "a cap that stops the agent and leaves a billing microVM behind has not capped spend" —
outranks it. The diff is extracted from the workspace rather than from the agent's stream, which is
what makes a capture meaningful after the process has been killed.

**Shortening `railsCheckIntervalMs` below 60 s.** Declined because it addresses the smaller half of
the delay — the remainder of the current turn dominates, and no poll interval changes that — while
reinstating the quadratic transfer cost the 60 s figure was chosen against (every poll re-reads the
whole agent log).

**Holding a run at a boundary until queued guidance is delivered.** Declined because it converts a run
that was about to pass into one that spends another agent turn on advice it no longer needs. A run
finishing with guidance undelivered is reported as `superseded` and nothing else is done about it: the
guidance was moot, and the operator can see so by asking.

#### §9: built, with the write-only property moved into the topology

§9's shape holds exactly as written: repository-scoped, one value per name, responses carrying the
key, the note and who set it, and no field for the value.

What is stronger than §9 required is where that last guarantee lives. The stored value is a sealed
box (`src/factory/secret-box.ts`): ingress holds only the **public** half of an X25519 pair and the
stage deployment holds the private half. So "write-only on read-back" is not a property of a response
shape — it is a property of the process, which can accept a secret and is unable to open one. §1's
rule that "an endpoint that would need [a model key or `VERCEL_TOKEN`] is in the wrong process" is
what forced the question: a secrets endpoint needs *a* key, and a symmetric one would have put every
repository's registry credential within reach of the hop that faces the internet.

The injection side is ADR-0014 §5, added in the same change, and it is the half with a real trade in
it: a registry credential cannot be brokered at an egress proxy the way a model key can, so it enters
the sandbox as an environment variable for the install command and nothing else. That amendment states
the worst case rather than this one, because it is a sandbox-posture decision.

Two routes answer 200 rather than 202, against §2's letter and with its reasoning: storing a secret
*is* the row, committed before the response, with no worker step behind it. 202 would mean "ask again
later" about something already done.

Still not built from this record: §11's organizations and users, and §10's remaining operator
commands. Both are named here so their absence stays visible. (Both since built: §11 by ADR-0024,
§10 by the 2026-09-25 amendment below.)

### Amendment, 2026-09-25 — §10 is delivered, and §1 bends for two routes

§11 was built by [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
(#283). This amendment closes §10, and with it the milestone's last named gap.

#### What moved, and where

| `windkeel-admin` | Now | Over |
|---|---|---|
| `metrics` | `windkeel metrics` | `GET /v1/metrics`, which already existed; only the client was missing |
| `task status`, `run report` | `windkeel show` | `GET /v1/runs/{id}`, which already returned the rendered report |
| `task create` | `windkeel submit` | `POST /v1/tasks`, now with caps and a hand-over (below) |
| `reap [--dry-run]` | `windkeel reap [--dry-run]` | `POST /v1/sandboxes/reap`, `GET /v1/sandboxes/reapable` |
| `run capture` | `windkeel capture` | `POST` / `GET /v1/runs/{id}/capture`, `GET …/capture/{path}` |

`windkeel-admin` keeps `doctor` and `secrets keygen`, and answers each removed name with the command
that replaced it.

#### `doctor` stays, against §10's list

§10 named `doctor` among the commands that become API clients. It does not, because it answers a
different question. `doctor` checks a deployment's credentials from the environment they will run
with — before there is a deployment, or when there is one too broken to answer. An API call *to* the
deployment cannot be that check. `/api/preflight` (#230) is already the deployment answering for
itself, and it covers the other half. The two are complementary and neither replaces the other.
ADR-0024's consequence that `doctor` would authenticate with an organization token is withdrawn with
this.

#### The hand-over §2 assumed was not there

Porting `task create` found that `POST /v1/tasks` and `POST /v1/runs` had never enqueued anything.
They wrote the rows and answered 202, and the run sat in `CREATED` for good. That is the silence
`windkeel-admin task create` produced from a laptop, reached by a different road. The tests stubbed the
command port, so nothing noticed.

Both routes now hand the run to the workflow through the same `runEnqueuer` the webhook uses. A
failed hand-over is `503 enqueue_failed` naming the run, not a 202. `POST /v1/runs` on a task whose
live run is still `CREATED` hands that run over again rather than refusing, which makes the failure
recoverable. Enqueuing is idempotent (`VercelWorkflowProvider.startRun`), so nothing starts twice.

#### §1, for reap and capture

§1 said the API holds no `VERCEL_TOKEN`, and that "an endpoint that would need [one] is in the wrong
process." Reap and capture need one: each attaches to a sandbox by its stored handle. They are on the
API anyway, for two reasons.

- **The premise did not survive ADR-0020.** #213 established that producer and consumer must be one
  Vercel deployment, and that Vercel scopes variables per project rather than per function. So every
  function in this deployment, including `/api/v1`, already has the sandbox token in its environment.
  `/api/sweep` reaps from the same deployment every hour. §1's line was drawn between processes that
  no longer exist as separate processes.
- **The alternative was worse.** Leaving reap and capture in `windkeel-admin` kept a sandbox token *and*
  the database's direct credentials on an operator's laptop. §10 exists to end that. Moving them
  behind a scoped token in a deployment that already holds both is a reduction, not an extension.

The bounds are specific. Reap runs the cron's own `reapSandboxesLocked` under the cron's own advisory
lock, so it adds a second way in to one sweep rather than a second sweep. It destroys only what the
predicate selects: a run that ended, a workspace past its expiry, one marked orphaned. Like metrics
it is account-wide, and in an account with more than one organization it is refused to anyone
without an account role. Capture is read-only towards the sandbox. It copies into the evidence
bucket, and the files come back as presigned URLs, so no file passes through a response (Vercel caps
those at 4.5 MB). Both routes load the sandbox SDK only when called, and both answer `503
sandbox_unconfigured` naming the missing variable rather than a bare 500.

Both answer 200, with the reasoning §9's secret writes used: the work has happened by the time the
response is sent.

#### Named and not done

- **Stored captures are not swept.** ADR-0015's retention covers evidence packages, and
  `captures/<run-id>/` is outside it. They are small and rare today.
- **The reaper does not capture before it destroys.** Doing so would make #252's loss impossible
  rather than avoidable. The pieces now exist; the change is a decision about storage cost, not code.
- **Organization tokens** (ADR-0024 §6) remain unbuilt, so `windkeel reap` in CI runs on a person's
  token.

### Amendment, 2026-09-25 — §1 admits one more ingress secret: `WINDKEEL_WEBHOOK_SIGNING_KEY` ([#297](https://github.com/jyothepro/orqon/issues/297))

§1 fixed ingress's secret surface at "the webhook secret and the GitHub App credentials". M8-5's
signed generic webhooks add one: **`WINDKEEL_WEBHOOK_SIGNING_KEY`**, an optional, lazily read ingress
variable. It is now a permitted ingress secret, on these terms.

#### Why ingress, and why a key rather than stored secrets

Every delivery to `/api/intake/webhook/{id}` is verified against that endpoint's secret, so the
process that receives deliveries must be able to *produce* the secret on every request. ADR-0014
gives ingress only the public half of the sealing pair: it **can seal but cannot unseal**
(`src/factory/secret-box.ts`, and §9's amendment above). A per-endpoint secret stored sealed would
therefore be unreadable exactly where it is needed; stored in the clear it would put every
endpoint's credential in the database. Neither is acceptable, and moving verification to the stage
deployment (which holds the private key) would put a network hop and a second deployment in front
of every inbound webhook.

So no endpoint secret is stored. Each is derived:
`whsec_ + base64url(HMAC-SHA256(WINDKEEL_WEBHOOK_SIGNING_KEY, "{endpointId}:{secretVersion}"))`,
answered once on create and on rotate, and recomputed per delivery. The key is the one secret ingress
must hold to do that — the same shape as §1's existing webhook secret (a symmetric key ingress uses
to *check* what arrives), not a capability to open anything sealed. The private sealing key stays
off ingress, and ADR-0014's property is unchanged.

#### The terms

- **Optional and lazy.** Nothing reads it at import; without it, endpoint create/rotate and every
  delivery answer `503 webhook_signing_unconfigured`, and the rest of ingress is unaffected.
- **At least 32 bytes**, or it counts as unset (logged once, by length only). An endpoint owner
  holds one derived secret and knows its `{id}:{version}`, so a weak key could be brute-forced
  offline from that pair and every other tenant's secret derived from it.
- **As sensitive as every endpoint secret together.** Leaking it leaks all of them; changing it
  retires all of them at once. It is never logged, echoed or persisted.
- Its scope is signed-webhook intake only. It grants nothing on `/v1` beyond issuing endpoint
  secrets to callers who already hold `integrations.manage`.
