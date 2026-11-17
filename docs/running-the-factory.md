# Running the factory

This replaces `docs/running-the-worker.md`, which described a component that no longer exists.
[#200] deleted `apps/worker` and pg-boss; [ADR-0020] makes the control plane Vercel end to end
and [ADR-0021] puts Vercel Workflow behind `WorkflowProvider`. The file was renamed rather than
edited because its title was the part that had become wrong, and a stale title outlives every
correction inside a document.

There is no longer anything to *start*. A run is carried by a durable execution whose stages are
separate invocations of a deployment. Operating the factory is now: configure the deployment,
check it, trigger a run, watch it, and know what to do when it stops.

Architecture context: [ADR-0020] (why there is no container), [ADR-0021] (why Postgres is the
authority and the orchestrator is not), [ADR-0008] §1 (why the connection must be session-mode),
and [ADR-0016] (why all of this still runs offline).

[#116]: https://github.com/jyothepro/orqon/issues/116
[#386]: https://github.com/jyothepro/orqon/issues/386
[#198]: https://github.com/jyothepro/orqon/issues/198
[#257]: https://github.com/jyothepro/orqon/issues/257
[#263]: https://github.com/jyothepro/orqon/issues/263
[#200]: https://github.com/jyothepro/orqon/issues/200
[#261]: https://github.com/jyothepro/orqon/issues/261
[#262]: https://github.com/jyothepro/orqon/issues/262
[#273]: https://github.com/jyothepro/orqon/issues/273
[ADR-0008]: adr/0008-supabase-postgres-and-storage-sql-file-migrations.md
[ADR-0014]: adr/0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md
[ADR-0015]: adr/0015-evidence-retention-outcome-tiered-with-tombstones.md
[ADR-0016]: adr/0016-local-development-hermetic-by-default.md
[ADR-0018]: adr/0018-repository-is-an-entity-resolved-per-task.md
[ADR-0020]: adr/0020-the-control-plane-is-vercel-end-to-end.md
[ADR-0021]: adr/0021-vercel-workflow-backs-workflowprovider.md
[ADR-0023]: adr/0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md
[ADR-0029]: adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md
[ADR-0031]: adr/0031-environment-snapshots-are-pre-maker-and-default-branch-only.md
[ADR-0026]: adr/0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md
[ADR-0027]: adr/0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md
[#213]: https://github.com/jyothepro/orqon/issues/213
[#242]: https://github.com/jyothepro/orqon/issues/242
[#340]: https://github.com/jyothepro/orqon/issues/340
[control-plane-api.md]: control-plane-api.md#model-credentials

## The short version

```sh
vercel --prod                  # the deployment is the control plane
windkeel-admin doctor                   # every check green before the first run
# then, on a repository the App is installed on:
#   label an issue `windkeel`, or: windkeel submit --repo owner/name --title … --description @task.md
windkeel show <run-id>
```

Locally, hermetically ([ADR-0016]):

```sh
docker compose up -d          # Postgres + MinIO + the evidence bucket
npm ci && npm run db:migrate
npm test                      # the whole loop, offline, against fakes
```

## What the deployment needs

Every variable is read and validated when configuration loads. A missing required one is
reported by name, with what it is for — because a deployment that accepts a webhook happily and
then dies on some later run's third stage is much worse than one that refuses.

`.env.example` documents all of them. The ones with no default:

| Variable | Why |
|---|---|
| `DATABASE_URL` | Direct (session-mode) Postgres, per [ADR-0008] §1. **Never through the transaction pooler** — it silently breaks advisory locks, which both sweeps depend on. |
| `WINDKEEL_REPOSITORY_URL` | Fallback only, for [ADR-0016]'s hermetic local path. See below. |
| The variable named by `WINDKEEL_MODEL_KEY_ENV_VAR` (default `OPENAI_API_KEY`) | The maker's model key. Validated as *present*; the broker rule names the variable and never carries the value. |
| `CRON_SECRET` | Authorises `/api/sweep`. **Without it both sweeps 401 every hour** — evidence is never retained and no expired sandbox is reaped. Vercel attaches it to its own cron invocations automatically once the variable exists. |

`CRON_SECRET` is the one that is easy to miss, because its absence is silent until an hourly
tick fails: the route fails *closed* by design, so a deployment without it is safe but inert.
The cron log is where it shows.

**The repository is per task** ([ADR-0018]). A task created from a GitHub issue names its
repository in a `repository` row, and every stage resolves the clone URL and base branch from
there. `WINDKEEL_REPOSITORY_URL` survives only as the fallback for hermetic local tasks, which
declare `source_type: local` and have no repository row; a task from any other source with a
missing row fails loudly rather than quietly running against whatever was configured.

**Git credentials are per workspace and per role** ([ADR-0014] §2). With `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` set, each sandbox gets a freshly minted installation token scoped to
that one repository: `contents: write` for the maker, `contents: read` for the verifier. The
verifier is therefore *unable* to push — the remote refuses it — which is the property
independent verification rests on. Tokens are re-minted before they expire, never written to
Postgres or to an evidence package, and reach the sandbox as a credential file rather than as a
command-line argument.

**Repository secrets and organization model keys are sealed to one key pair** ([ADR-0014] §5,
[ADR-0023] §9, [ADR-0026] §2). `windkeel-admin secrets keygen` prints both halves once:

| Variable | Read by | |
|---|---|---|
| `WINDKEEL_SECRET_PUBLIC_KEY` | The API routes | Seals a secret or a model credential. Cannot open one. |
| `WINDKEEL_SECRET_PRIVATE_KEY` | The workflow steps | Opens them, inside the one handler call that uses the value. |
| `WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY` | The workflow steps | Optional: the previous pair's private half during a key-pair rotation, so values sealed to it keep opening. See [rotating the key pair](#rotating-the-key-pair). |

**Both halves sit in the same deployment's environment, and that is stated rather than hidden.**
Since [#213] the API routes and the workflow steps are one Vercel deployment — a queue message is
addressed to the deployment that produced it — so there is no separate "stage deployment" to keep
the private key on. [ADR-0026]'s Consequences (amended for #213) say exactly what the box still
separates:

- **Against the database.** A dump, a backup, a SQL injection or another product reading the shared
  database gets ciphertext. The database alone cannot open a credential.
- **Against the code path.** No API route, handler or response can open one: nothing under
  `apps/ingress` names the reader, the validator or a private-key accessor, and
  `test/api-routing.test.js` fails the build if anything starts to.
- **Not against code execution in the deployment.** Anything that runs code in the deployment's
  functions can read the private key from the environment. Mark it a sensitive variable and keep
  team access narrow; the real reduction is a KMS unwrapping the key on use (M14), which needs no
  schema change because each sealed value records its `keypair_id`.

Both may be left unset — a factory whose repositories install from public registries and whose
organizations use Windkeel's model keys never needs either. But a deployment with secrets stored and
no private key installs *without* them, silently, which is why `windkeel-admin doctor` checks that
every stored secret opens with the key this deployment has. A run whose organization chose its own
model key on such a deployment fails by name instead of using Windkeel's key ([ADR-0026] §6).

### Rotating the key pair

Rotating does not re-seal what is stored, and nothing on the server can: re-sealing needs the value,
and only the credential's owner has it. So the old private half stays readable until every value has
been set again.

1. `windkeel-admin secrets keygen` for the new pair.
2. On the deployment, in one change: the new public half as `WINDKEEL_SECRET_PUBLIC_KEY`, the new
   private half as `WINDKEEL_SECRET_PRIVATE_KEY`, and the **old** private half as
   `WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY`. Redeploy. Everything sealed to either pair opens; everything
   stored from now on is sealed to the new one.
3. Set every value again. Repository secrets: `windkeel secret set`. Model credentials: each
   organization's admin runs `windkeel models credentials rotate <id>` (or *Rotate* in Settings →
   Models) with the same key; it is re-sealed to the new pair, goes back to `unverified`, and is
   checked again. `GET /v1/model-credentials` shows each credential's `keypairId`, so "which are
   still on the old pair" is a list, not a guess.
4. When none is left on the old pair, remove `WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY` and redeploy.
   Anything missed now fails to open, by name: `windkeel-admin doctor` lists unopenable repository
   secrets, and a run on an unopenable model credential fails with `model_policy` naming its label.

A v2 value (every model credential) names the pair that sealed it, so the right key is chosen
directly; a v1 repository secret is tried against the current key and then the previous one.

### Model routing (M9)

Nothing here is required: with no organization credential and no policy, every run is resolved at
intake to exactly the operator's models and keys above. These only matter once organizations bring
their own keys (`windkeel models`, Settings → Models; see [control-plane-api.md] §Model credentials).

| Variable | |
|---|---|
| `WINDKEEL_MAKER_MODEL`, `WINDKEEL_MAKER_VENDOR`, `WINDKEEL_MODEL_API_DOMAIN`, `WINDKEEL_MODEL_KEY_ENV_VAR` | The Windkeel-managed maker, as before. Since M9 **Codex is passed `--model WINDKEEL_MAKER_MODEL`** on every run; it used to run on Codex's built-in default whatever this said. Check that the value is the model your runs actually used. |
| `ANTHROPIC_API_KEY`, `WINDKEEL_REVIEW_MODEL` | The Windkeel-managed checker, as before. |
| `WINDKEEL_USD_PER_INPUT_TOKEN`, `WINDKEEL_USD_PER_OUTPUT_TOKEN`, `WINDKEEL_USD_PER_CACHED_INPUT_TOKEN` | Optional pins for the maker's price. **No longer defaulted**: a token is priced from the model catalog for the run's own model, and each variable set wins over the catalog for its own field. |
| `WINDKEEL_CHECKER_USD_PER_INPUT_TOKEN`, `…_OUTPUT_TOKEN`, `…_CACHED_INPUT_TOKEN` | The same, for the checker. |
| `WINDKEEL_UNPRICED_USD_PER_INPUT_TOKEN`, `WINDKEEL_UNPRICED_USD_PER_OUTPUT_TOKEN` | The rate the spend cap counts a call at when its model has no price (the catalog's highest by default, $15 / $75 per million). The ledger still records such a call as `usd` null — unknown, not zero ([#242]). |
| `WINDKEEL_CHECKER_OPENAI_API_KEY`, `WINDKEEL_CHECKER_OPENAI_MODEL` (default `gpt-5`) | A second Windkeel-managed checker, on OpenAI ([ADR-0027] §4). Unset, the checker list is Anthropic's alone, as before. With it, a maker on Anthropic's models (the Claude Code harness) still gets an independent checker on operator defaults. |
| `WINDKEEL_CHECKER_VENDORS` (default `anthropic,openai`) | The order intake tries the operator's checkers in; it takes the first whose vendor differs from the maker's. An unknown vendor is a startup error. |
| `WINDKEEL_MAKER_KEY_ENV_VAR_<PROVIDER>` | Names the variable holding the operator's maker key for that provider's host, for example `WINDKEEL_MAKER_KEY_ENV_VAR_ANTHROPIC=ANTHROPIC_MAKER_API_KEY` for a Claude Code maker on Windkeel's key. The named variable must be set. `WINDKEEL_MODEL_KEY_ENV_VAR` stays the key for the `WINDKEEL_MODEL_API_DOMAIN` provider. A provider with neither is refused by name at the stage; nothing falls back. The broker attaches an Anthropic key as `x-api-key`, every other as `Authorization: Bearer`. |
| `WINDKEEL_USD_PER_CACHE_WRITE_INPUT_TOKEN`, `WINDKEEL_CHECKER_USD_PER_CACHE_WRITE_INPUT_TOKEN` | Optional pins for the prompt-cache write rate ([ADR-0027] §8). The catalog has one for Anthropic's models (1.25x base input). Without one, a cache write is priced at the uncached input rate, never lower. |
| `WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL` | `1` lets a credential's `baseUrl` be plain `http://localhost…`. **Development and tests only**; leave it unset on a deployment. Without it a `baseUrl` must be public https, and any host resolving to a private, loopback, link-local or metadata address is refused, at store time and again at connect time. |

A run's models are frozen into `engineering_run.model_config` at intake, and every later stage reads
that, not the environment: changing a variable changes the next run, never one in flight.

### Repository knowledge (#388, ADR-0032)

Nothing here is required: knowledge is on by default and costs nothing until someone writes a note.

| Variable | |
|---|---|
| `WINDKEEL_KNOWLEDGE` | `off` (or `0`, `false`) turns repository knowledge off for the deployment: no `## Repository knowledge` section in the maker's prompt, no `run_knowledge` rows, no codebase digest, no learned lessons. Anything else, or unset, is on. Never affects the verifier, which reads none of it. |
| `WINDKEEL_KNOWLEDGE_MAX_CHARS` | The section's budget in characters (default `12000`). Whole notes are dropped lowest-priority first to fit. |

Three things are legal to leave unset, and each is announced rather than left to look like success:

- **`S3_BUCKET`** — verifications still run and record a verdict, but no evidence package is
  stored and `evidence_package_ref` stays null.
- **`ANTHROPIC_API_KEY`** — the review and mapping stages report themselves *skipped* rather than
  silently passing. A verdict from a run with no checker is a verdict about checks and findings
  only, and the evidence says so.
- **The secret key pair** — with no key, no repository secret or model credential can be stored
  or opened, and `windkeel-admin doctor` skips the check rather than passing it.

### Take over, hand back, submit: `WINDKEEL_TAKEOVER` (off by default)

[ADR-0029] §3–4 (#369) lets a person take a run over in a human workspace of their own, then submit
it for verification or hand it back. It is **off unless `WINDKEEL_TAKEOVER=1`** is set on the
deployment. Off, the four intents (`/takeover`, `/submit`, `/handback`, `/workspace/session`)
answer `409 takeover_disabled`, `mode: "pair"` is refused, the run read says
`takeover.enabled: false`, and the console draws nothing of it.

On, it also needs the sandbox provider's credentials (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
`VERCEL_PROJECT_ID`) **in the API**, not only in the workflow steps: minting a workspace session
wakes the human workspace and starts its token-gated server, ADR-0029 §4's third bend of
[ADR-0023] §1 after reap and capture. The GitHub App's installation tokens are minted on the
deployment for the push and revoked when it returns; none is ever placed in the human workspace.

What to expect while a run is in `HUMAN_EDITING`:

- The maker sandbox is held (ADR-0017 as amended) and the human workspace runs beside it; both are
  charged to the run as they accrue, and the run's spend cap still stops it. `HUMAN_EDITING` parks
  the wall clock, like the other states that wait on a person.
- The human workspace sleeps after 30 idle minutes and is deleted when the run leaves
  `HUMAN_EDITING`, or after 24 h, whichever is first.
- A person's cycles don't spend the repair budget; they are capped by `human_cycles_cap` (default
  10, on the run).

**Not for release** until ADR-0029's flip conditions hold (a live run of the human workspace and of
the push path) and the security audit signs off the capability-token gate and the bundle-out push.

### Environment snapshots: `WINDKEEL_ENVIRONMENT_SNAPSHOTS` (off by default)

[ADR-0031] (#387) sets a repository's environment up **once**, on its default branch, and lets maker
and verifier sandboxes boot from that instead of cloning and installing from nothing. Off unless
`WINDKEEL_ENVIRONMENT_SNAPSHOTS=true` on the stage deployment; off, provisioning is unchanged and no
snapshot row is ever written.

| Variable | Default | What it does |
|---|---|---|
| `WINDKEEL_ENVIRONMENT_SNAPSHOTS` | `false` | The feature. Also turns on the Vercel provider's snapshot support. |
| `WINDKEEL_SNAPSHOT_FOR_VERIFIER` | `true` | `false` forces every verifier cold; makers still restore. The kill switch. |
| `WINDKEEL_SNAPSHOT_TTL_DAYS` | `14` | A ready snapshot's lifetime. The sweep keeps the newest two per repository either way. |

How it behaves:

- **The first run is cold** and records a build request. The build runs on the stage deployment as
  its own Workflow (`orqonBuildEnvironmentSnapshotFlow`); the hourly sweep dispatches queued
  requests, and `windkeel env rebuild --repo owner/name` (or the console's Rebuild) starts one now.
- A build clones the default branch in a **setup sandbox** (read-only token, no model key), runs the
  dependency install and the `setup` in `windkeel.config.json` at that commit with the repository's
  secrets, then **scans the disk for every secret value and fails the build on a hit**. The failure
  names the secret, never the value. `setup.commands` must not write credentials to disk.
- A restore fetches and checks out the workspace's own revision. The install is skipped only when no
  lockfile, manifest or install configuration differs from the snapshot's commit; otherwise it runs
  again (on a candidate, without the secrets). A snapshot whose commit is not an ancestor of the
  checkout is not used.
- Setting or deleting a repository secret invalidates its snapshots; so does `windkeel env invalidate`.
- `windkeel-admin run report` shows `Environment  maker warm (snapshot …), verifier cold`.

Declaring a setup (all keys optional; refused entries are reported, never silently dropped):

```json
{
  "setup": {
    "commands": [{ "name": "bootstrap", "run": "make bootstrap", "timeoutSec": 900 }],
    "services": [{ "name": "postgres", "start": "sudo service postgresql start", "ready": "pg_isready", "readyTimeoutSec": 60 }],
    "secrets": ["NPM_TOKEN"],
    "egress": ["registry.example.com"],
    "cacheKeyFiles": ["scripts/bootstrap.sh"]
  }
}
```

`windkeel env status --repo owner/name` shows the snapshots and a **suggested** `setup` drafted from the
repository's Makefile, `scripts/setup*`, `docker-compose.yml` and devcontainer — a draft for a
person to review and commit, never applied or run.

**Not for release** until the live spike (restore-then-fetch on Vercel, snapshot size and cost)
has run on a real repository.

### Batches: `WINDKEEL_BATCH_MAX_ITEMS`, `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS` (both optional)

Batches (#391, [batches.md](batches.md)) need no configuration. `WINDKEEL_BATCH_MAX_ITEMS` (default
200) bounds one batch's items, on the API. `WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS` (default 10) is
an organization's run ceiling when its own `max_concurrent_runs` is null; set it to the same value
on the API, the workflow steps and the cron, since each one dispatches.

## Migrations

Merging to `main` applies migrations; nothing else does. A deploy never runs them, which is how
production ended up five behind on 2026-09-24 (every token-checked `/v1` call a 500) and, from
2026-09-25 to 2026-10-14, M8's code ran for three weeks against six missing tables (#337).

### The rule: additive and backward-compatible

**Every migration must be safe for the code that is already deployed.** The migrate job and the
Vercel deploy both start on the merge and are not sequenced, and a previous deployment keeps
serving (warm instances, rollbacks, preview URLs) after the migration lands. So a migration may:

- create a table, a view, an index (not `concurrently`: each file runs in a transaction), or a function;
- add a column that is nullable or has a default;
- add a constraint that existing code's writes already satisfy;
- widen a check constraint or an enum.

It may **not**, in the same release as the code that stops using the thing:

- drop or rename a table, column, view or function that deployed code reads or writes;
- add a `not null` column without a default, or tighten a constraint older code can violate;
- change a column's type in a way older code's queries break on.

Those take two releases: first ship code that no longer depends on the old shape, let it become
the only deployment, then ship the migration that removes it. Files are forward-only and
numbered ([ADR-0008]); a merged file is never edited.

### How a merge gets migrated: `.github/workflows/migrate.yml`

On every push to `main` the `migrate` workflow runs `npm run db:migrate` against production. One
concurrency group (`migrate-production`), never cancelled in progress, so two runs never overlap
and a queued one is never dropped. The runner also holds an advisory lock, so even a manual run
alongside it queues rather than races. Each file is its own transaction, recorded in
`schema_migrations` in that transaction; a failed file stops the run with the earlier ones
applied and the failure in the job log.

**Setup, once** (a person with admin on the repository):

1. Create the repository secret `DATABASE_URL` (Settings → Secrets and variables →
   Actions). Role **`orqon_app`**, through Supavisor's **session** pooler on port **5432**:
   `postgresql://orqon_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Not port 6543: the transaction pooler silently breaks the session advisory lock the runner
   holds ([ADR-0008] §1). The role's `search_path` must resolve to the `orqon` schema, exactly as
   the deployment's `DATABASE_URL` does — the files use unqualified names.
2. Dry-run it: Actions → `migrate` → Run workflow (branch `main`, **dry-run** checked, the
   default). It lists the pending files and applies nothing. Equivalent locally:
   `DATABASE_URL=… npm run db:migrate -- --dry-run`.
3. If the list is what you expect, run it again with dry-run unchecked, or merge anything.

The job runs only for `main`'s code (`if: github.ref == 'refs/heads/main'`), the secret is exposed
only to the steps that need it, and the token is read-only.

### What a deployment does when it is behind anyway

Every function compares `schema_migrations` with the migrations bundled into it (the build copies
`migrations/` beside each function) at cold start, and caches the answer for the instance:
current is kept for the instance's life, behind is re-checked every 15 seconds so an instance
recovers once the migrate job lands, and an unreadable database is never cached.

- `GET /v1/health` answers **503** with `schema: "behind"` and `pending: [<filenames>]`.
- Every other `/v1` route, the GitHub webhook, `/api/intake/*`, and both crons answer **503**
  `{"code": "schema_behind", "pending": [...]}` before touching a table, instead of a raw
  `relation "…" does not exist` 500. Webhook and intake senders retry a 503.
- A deployment that cannot find its own bundled migrations reports `schema: "unverifiable"`
  (503) on health — a packaging fault — but does not refuse requests.
- `/api/preflight` and `windkeel-admin doctor` fail their database/migrations checks naming the files.

The fix in every case is the same: run the `migrate` workflow (or `npm run db:migrate` with the
production URL). The workflow runtime (`/.well-known/workflow/v1/*`) is built by the Workflow SDK
and is not guarded; its steps reach the database only for runs the guarded routes started.

## What it costs your database

Two pools per warm instance: the stage graph's and the provider's, bounded at `DEPLOYED_POOL_MAX`
(2) and `DEFAULT_POOL_MAX` (4). Small on purpose, and smaller than the container's — a deployment
scales by multiplying instances, and every one of them talks to a single session-mode pooler
whose connection budget is shared with the ingress and with anything else on that database.

That is the sizing change [ADR-0020] brings and it cuts both ways: no long-lived container
holding eight connections, but no ceiling on how many instances exist either. Add the ingress's
(`max: 2` per warm instance), add the hourly sweep's, and leave room for a `psql`.

`npm run test:pg-pressure` measures the same thing for the test suite: it samples
`pg_stat_activity` while `npm test` runs and reports peak connections, how many were merely idle,
lock waits, and connection errors. That instrument turned #140's connection-pressure *hypothesis*
into a measurement.

## Two binaries

`windkeel` is the published command line: the verification engine locally (`verify`, `seal`, `bench`,
`replay`) and a deployed factory over HTTP (`runs`, `show`, `watch`, `approve`, `cancel`, `say`,
`messages`, `secrets`, `submit`, `metrics`, `reap`, `capture`, `mcp`). `npm install -g windkeel`
fetches it as one bundled file with no dependencies, and installs both `windkeel` and `windkeel`. It authenticates with `windkeel login`, or
`WINDKEEL_API_URL` and `WINDKEEL_API_TOKEN`; it never holds the database's credentials.

`windkeel-admin` is the operator's, is **not published**, and has two commands left. `doctor`
preflights a deployment from the environment it will run with, which is why it cannot be a call
*to* that deployment: one too broken to answer is the case it exists for. `secrets keygen` mints a
key pair, and is a deployment step rather than something a user of a factory does. Run them from a
checkout of this repository:

```bash
npm run build
npm run windkeel-admin -- doctor
# or: node dist/admin-cli.js doctor
```

Until 2026-09-24 `windkeel-admin` also carried `metrics`, `reap`, `task` and `run`, each holding a
direct Postgres connection and, for `reap` and `run capture`, a sandbox token. [ADR-0023] §10 moved
them onto the API; typing one of the old names prints the command that replaced it.

| Was | Is |
|---|---|
| `windkeel-admin metrics` | `windkeel metrics` |
| `windkeel-admin reap [--dry-run]` | `windkeel reap [--dry-run]` |
| `windkeel-admin task create` | `windkeel submit` |
| `windkeel-admin task status`, `windkeel-admin run report` | `windkeel show <run-id>` |
| `windkeel-admin run capture` | `windkeel capture <run-id>` |

Why they were ever separate: npm resolves dependencies from the manifest you install, not from the
imports your code reaches. While one package held both, `npm i -g windkeel` meant 264 MB and 495
packages — a TypeScript compiler among them — for people running `windkeel verify` in CI. See the
2026-09-24 amendment on [ADR-0005](adr/0005-monorepo-split-lands-with-the-control-plane.md).

## Preflight: `windkeel-admin doctor`

Before the first run, and before any run that follows a configuration change:

```sh
windkeel-admin doctor                       # exit 0 all green, 1 if anything failed
windkeel-admin doctor --json                # the same report, machine-readable
windkeel-admin doctor --repository owner/name   # when WINDKEEL_REPOSITORY_URL is not a github.com URL
```

It extends this file's rule from **is the variable set** to **does the thing it names actually
work**:

| Check | What it proves |
|---|---|
| Configuration | Every variable loads and validates. Reports **every** problem, not the first — the point is a complete list. |
| Postgres | Connects, and confirms the connection is **direct session-mode rather than pooled** ([ADR-0008] §1) by checking that two statements share a backend and that a session advisory lock survives to its own unlock. |
| Migrations | Every file in `migrations/` is recorded in `schema_migrations`. Fails naming each pending file. The same comparison the deployment makes about itself (see [Migrations](#migrations)), so `doctor` and `/v1/health` cannot disagree. |
| Workflow backing | Which machinery is selected, and how many runs are currently bound to each — the census that shows a half-migrated deployment. |
| Workflow deployment | That the deployment serving the workflow runtime exists and is reachable. A deployment serving the webhook but carrying no runtime looks completely healthy from outside and silently accepts runs it will never execute. |
| Object store | Writes one small object, **reads it back**, and deletes it. A bucket that accepts writes and serves nothing looks identical to a working one until someone tries to verify a stored package months later. |
| GitHub App | Mints a real installation token and compares the grant against ADR-0009 §1 **in both directions**. An over-grant is a finding, not a pass. |
| Webhook deliveries | Reads the App's recent deliveries, and the URL it is configured to send to, and reports whether anything **arrives**. Every other GitHub check proves a credential works; on 2026-09-18 all of them were green while the webhook pointed at a Vercel project that did not exist and every delivery 404'd for a day. A uniformly failing history is a failure, with the URL named; a mix is not, because the ingress returns 400 and 401 on purpose; **no deliveries at all is neither** — a never-triggered App and a broken one are indistinguishable from here. Authenticates with the App's own JWT, so it needs no extra secret and no extra permission. |
| Token scoping | Mints the maker's and the verifier's tokens and asserts `contents: write` and `contents: read` respectively, and that they differ ([ADR-0014] §2). |
| Model endpoints | Reaches each configured endpoint with a free, read-only list call, and asserts the maker's and checker's vendors differ (ADR-0010). |
| Model credentials | Organization model keys (ADR-0026) by status, and how many recent runs were on a customer key. Warns — does not fail — on an `invalid` credential, by label, and on one still `unverified` an hour after it was stored (the check never started; the hourly sweep retries it). Skips before migration 0029. |
| Sandbox | Creates one sandbox, runs `codex --version` in it, checks the pin, and **destroys it — including when the exec throws**. The most expensive check, and the one that most needs to happen before a real run. |

A skipped check is rendered as a skip, never as a pass, and the report says what the skip costs.
No object store means no evidence package is retained; no checker key means review and mapping
report themselves skipped; no `VERCEL_*` means [ADR-0016] local mode, where agent work runs on
the host rather than in a microVM.

**No value of any variable is ever printed.** Only names, counts, and outcomes. The report is
also scrubbed against every configured secret and every token the command mints, because the
first line is a discipline and the second is a mechanism.

**What it has not been proven against.** Every check has been exercised against stubs, and the
delivery check against a real GitHub that answered 401 to a fabricated key — real enough to prove
the path, not the thing it was written for. The 2026-09-18 incident was a *404 on every delivery*,
and nothing has yet observed that shape. A check that itself throws is reported as a failed
*check*, with a note saying so, rather than as a failed report: the command's own failure modes
have to be legible while it is still unproven.

## Secrets

Nothing logs its environment. [ADR-0014] §1 exists so a sandbox never sees a model key; a key in
a build log would undo that somewhere much harder to notice. The sandbox receives
`CODEX_API_KEY_PLACEHOLDER`; the real key is attached at the egress proxy by a broker rule. For
Windkeel's key the rule names an environment variable on the deployment; for an organization's own
key ([ADR-0026] §7) it carries a resolver that opens the sealed credential when the egress policy is
applied, so the value exists only inside that handler call and the `sandbox.update` it feeds —
never in a sandbox, a row, a log, Codex's argv or a workflow step's journalled arguments.

## Running it locally, hermetically

`docker compose up` starts Postgres and MinIO ([ADR-0016] §4). With no `VERCEL_TOKEN` the factory
falls back to `FakeSandboxProvider` — a real local `git clone` into a real temp directory — and
**announces the fallback**, because "my runs are cheap and fast" and "my runs are not really
sandboxed" must not look the same to an operator.

What is *not* hermetic, named explicitly rather than left to be discovered: a real
`CodexWorkerAdapter` needs a `codex` binary and a real model key, and a real sandbox needs a
Vercel account. The loop runs offline with the fake sandbox and fake worker; it does not run
offline with the real ones.

## The worker adapter

A real `CodexWorkerAdapter` is always built (ADR-0006). There is **no fallback to a fake worker**,
deliberately: a fake produces an empty diff and a run that verified nothing, which from the
outside looks exactly like a working factory. If the agent cannot run, the run must fail saying so.

Where the binary has to be differs by mode:

| Mode | Where `codex` runs | What you must install |
|---|---|---|
| Vercel sandbox (token, team and project set) | inside the microVM | nothing — it ships in the `universal` image |
| [ADR-0016] local mode (no Vercel credentials) | **on this host**, in a temp clone | `codex` on the host PATH |

`WINDKEEL_CODEX_VERSION` pins the CLI version the adapter will drive; a mismatch is an error because
the JSONL event schema is the only stability contract Codex offers, and it ships multiple alpha
releases a day. `WINDKEEL_ALLOW_CODEX_VERSION_DRIFT=true` downgrades that to a recorded diagnostic
and a warning, so a sandbox image bump is visible rather than an outage.

`WINDKEEL_HARNESS_INSTALL=pinned` (ADR-0027 §7.2) makes the image's drift self-healing instead: the
maker's install phase checks `codex --version` and, when it is not the run's pinned version, runs
`npm install -g @openai/codex@<pin>` before egress narrows and before any repository code runs. The
outcome is in PROVISIONING's transition reason; a failed install still fails the run at IMPLEMENTING
by name. Leave `WINDKEEL_CODEX_VERSION` unset in production so the pin in code is the only one — on
2026-10-25 a stale `WINDKEEL_CODEX_VERSION=0.154.0` kept every run failing after the code was fixed.

### More than one maker harness (ADR-0027)

The maker can be driven by more than one agent program. Each run freezes the harness it starts on,
as `{ id, version }` in its model snapshot, and every stage uses that harness's adapter. Changing a
variable or a policy moves the next run only. Every harness's change goes through the same verifier.

| Variable | |
|---|---|
| `WINDKEEL_MAKER_HARNESSES` (default `codex`) | The harnesses this deployment registers, comma-separated. One this build has no adapter for (it has `codex` and `claude-code`) is a startup error. A policy naming a harness that is not listed is refused on write (`422 harness_unavailable`) and again at intake (`stop_reason = model_policy`). |
| `WINDKEEL_DEFAULT_MAKER_HARNESS` | The harness a run gets when no policy names one. Unset, the first listed. One `WINDKEEL_MAKER_HARNESSES` does not list is a startup error. |
| `WINDKEEL_CLAUDE_CODE_BINARY` (default `claude`), `WINDKEEL_CLAUDE_CODE_VERSION`, `WINDKEEL_ALLOW_CLAUDE_CODE_VERSION_DRIFT` | The Claude Code adapter's equivalents of the Codex knobs above. |

**Claude Code is off by default and offline-tested only.** It passes the same conformance suite as
Codex against a fake binary. It has not yet been proven in a real sandbox (#395 G1), so enable it
on a staging deployment first. Claude Code calls Anthropic's API only, so its runs need an
independent checker of another vendor (`WINDKEEL_CHECKER_OPENAI_API_KEY`, or an organization checker
policy). `windkeel-admin doctor` warns when an enabled harness has none.

## Starting a run

**The supported trigger is a labelled GitHub issue.** Add the `windkeel` label; the ingress
validates the delivery, writes the rows, and enqueues a run addressed to its own deployment.

**From a terminal or an agent, `windkeel submit`** — the API's task creation, which the console's
*File task* also uses:

```sh
windkeel submit --repo owner/name --title "…" --description @task.md \
             --criteria criteria.md --risk low --spend-cap 25 --wall-clock 3600
```

`--repo` takes a repository id or `owner/name`, and only a repository the GitHub App is installed
on: the API does not invent one. The ingress writes the rows and enqueues the run addressed to its
own deployment, exactly as the label path does. If the hand-over fails you get a 503 naming the
run, and starting a run on the task again — `POST /v1/runs` with the task id, or *Start run* in the
console — retries that same run rather than creating a second one. A run is never uncapped from here.

**This replaced `windkeel-admin task create`**, which wrote the rows from wherever it ran and enqueued
the run to *that process's* deployment — so from a laptop the run sat in `CREATED` forever with no
error anywhere. Two such orphans were deleted by hand in September 2026. (Until the same change, the
API's own `POST /v1/tasks` had the same silence for a different reason: it wrote the rows and
enqueued nothing.)

`criteria.md` is one `- [ ] …` line per acceptance criterion; `--criteria` appends it to the
description under an *Acceptance criteria* heading, which is where the server extracts criteria from
and the only place it does. **Supply them.** A task with no
criteria proposes some and waits at `WAITING_FOR_APPROVAL` for `/windkeel approve` (ADR-0012);
nothing is provisioned and nothing is spent until you reply.

## How long you have to approve

**72 hours, from the moment the criteria comment is posted.** The comment says so, with the date.

After that the run is `CANCELLED` with `stop_reason = 'approval_expired'` and the issue gets a
comment saying the criteria went unapproved. Nothing was provisioned, nothing was verified, and
waiting cost nothing — so an expired gate is not a loss, it is a run you start again by re-adding
the `windkeel` label. `/windkeel approve` arriving after that answers on the issue rather than doing
nothing.

Waiting does not consume the run's wall clock. The ADR-0011 cap bounds *working* time; seconds
spent at `WAITING_FOR_APPROVAL` or `WAITING_FOR_HUMAN` are subtracted, because a parked run holds
no sandbox, no session and no model spend. It bounds money as it always did: a run that reached
its spend cap before it parked stays stopped.

**This was two hours and said nowhere until [#262].** The cap was measured from `started_at`, the
flow loop re-checked it on a parked run every five minutes, and the result was a `FAILED` run
whose reason named a clock it had not used. If you find an old run in that state, that is what
happened to it.

Set `WINDKEEL_APPROVAL_DEADLINE_SECONDS` to change the window. Do not set it above about five days:
a parked run is kept alive by a durable execution with a finite tick budget (6.94 days), past
which the run stops existing and a later approval is recorded but never acted on — see [#261].

## Watching a run

```sh
windkeel show <run-id>        # the run report: state, cost against cap, verdict, every verification
                           # cycle, repair history, provenance, evidence ref + digest
windkeel watch <run-id>       # follow it to the end
windkeel metrics              # the ADR-0013 SQL views across all runs
```

`windkeel metrics` is account-wide: in an account with more than one organization it needs an account
role, because the views do not carry an organization yet.

The run row is the authority ([ADR-0021], carrying ADR-0007 §1 forward); the orchestrator is
transport. If the two ever disagree, believe the row.

Stage narration goes to the deployment's logs as one JSON object per line, `src: "windkeel"`. Vercel
captures stdout per invocation, so structured lines survive being interleaved with every other
run sharing an instance. This is newer than it sounds: the deployed path passed no logger at all
until #225, so every line the factory wrote about itself was discarded — including `codex
diagnostic`, the one that says what the agent did and why a session ended.

## Capturing what only the sandbox has

Everything above is built from Postgres and outlives the run by years. The agent's **own**
artefacts are not: the `codex exec` JSONL transcript, its stderr, the turn's exit status and the
workspace diff live in a scratch directory *inside the maker sandbox*, and the reaper destroys
that on a schedule (see below). There is no second copy anywhere.

```sh
windkeel capture <run-id>              # -> .windkeel/capture/<run-id>/
windkeel capture <run-id> --out ./dir
```

The deployment attaches to the maker sandbox, copies every file in the scratch directory into the
evidence bucket under `captures/<run-id>/`, and writes a `session-ref.json` beside them so the
transcript has provenance — which turn, which Codex session. The CLI then downloads each file
through a presigned URL; nothing passes through the API's response, which Vercel caps at 4.5 MB.
It is read-only towards the sandbox and never destroys anything, so running it on a live run is
safe. It needs `S3_BUCKET` and the `WINDKEEL_SANDBOX_*` variables on the deployment.

**Run it while the sandbox is alive.** Afterwards it reports the sandbox as gone, which is the
truth and not a bug — and downloads the capture taken earlier, if there was one, because that copy
outlives the sandbox. Stored captures are not swept by retention. [#116] asked four questions about the JSONL shape — `item_type` vs `type`,
`exit_code`, `changes[].kind`, the `usage` keys — and was closed before anyone pulled a real log
out to answer them; the fixtures under `test/fixtures/codex/` are still hand-authored
approximations, and four sandboxes have been reaped since, each of which held the answer. The
tooling to turn a capture into a tested fixture now exists ([#386], next section); the capture
itself has still not been taken, so the caveat stands.

Nothing it writes contains a credential. The scratch directory holds the agent's output, not its
environment, and the session reference is adapter bookkeeping — a path, a turn number, a byte
watermark ([ADR-0014] §3).

### Capturing Codex fixtures, and proving cancellation live

[#386] sub-task A, an operator step. It needs the deployment and spends a few cents. Each step
names what to record; nothing here changes code until step 4.

1. **A trivial task, captured while the maker is alive.** On the scratch repository:

   ```sh
   windkeel-admin doctor                                  # all green first
   windkeel submit --repo <owner>/orqon-bench-scratch --title "Add a CHANGELOG line" \
     --description "Add a line '- bench seed' to CHANGELOG.md, creating it if absent." --spend-cap 2
   windkeel watch <run-id>                                # until VERIFYING or later
   windkeel capture <run-id>                              # -> .windkeel/capture/<run-id>/
   ```

   A run that went through a repair has `turn-2.events.jsonl` as well — that is the resumed turn.

2. **A cancelled turn.** Submit a task that keeps the agent busy (the M5 task below works), and
   while `windkeel show <run-id>` says `IMPLEMENTING`:

   ```sh
   windkeel cancel <run-id> --reason "#386 live cancellation proof"
   windkeel capture <run-id>                              # the transcript ends where the kill landed
   windkeel show <run-id>                                 # record: state CANCELLED
   windkeel reap --dry-run                                # record: no sandbox of this run listed
   ```

   Record in this document and in `research/MILESTONES.md` (M3 row) the run id, the `CANCELLED`
   state, that `turn-1.exit-status` in the capture shows the process exited, and the `reap
   --dry-run` output. If a sandbox *is* listed, that is the finding: the cancel did not release
   it, and the reaper is all that stands between it and an hour of billing.

3. **Import each transcript.** The importer audits it with the same code the suite uses, refuses
   one with a credential-shaped string in it (scrub by hand, never by script), and records which
   run and turn it came from in `test/fixtures/codex/live-sources.json`:

   ```sh
   npm run build
   node test/tools/import-codex-capture.mjs --capture .windkeel/capture/<run-1> --turn 1 \
     --name live-successful-session --outcome completed --expect started,file_changed,completed
   node test/tools/import-codex-capture.mjs --capture .windkeel/capture/<run-with-repair> --turn 2 \
     --name live-resumed-turn --outcome completed
   node test/tools/import-codex-capture.mjs --capture .windkeel/capture/<run-2> --turn 1 \
     --name live-cancelled-turn --outcome cancelled
   grep -nE 'sk-|ghs_|ghp_|github_pat_' test/fixtures/codex/live-*.jsonl   # belt and braces: expect nothing
   ```

4. **Fix what the real stream shows, then drop the caveat.** `node --test
   test/worker-codex-live-fixtures.test.js` fails on any normalizer diagnostic, on usage keys the
   normalizer does not read, and on a Codex version other than `PINNED_CODEX_VERSION`. Fix
   `src/worker/codex/events.ts` (or the pin, if the sandbox's Codex moved and the stream still
   normalizes) until it is green. Only then rewrite the paragraph above and the M3 row, and only
   for what was captured.

If `windkeel capture` after the cancel reports the sandbox gone, the cancel released it promptly —
record that (it is the orphan check passing), and take the cancelled transcript by capturing in a
second terminal while the turn is still running, then cancelling.

### Demonstrating M5 live

[#386] sub-task B, an operator step. M5 is "observed, not demonstrated" until one live run goes
`VERIFYING (fail) → REPAIRING → VERIFYING (pass) → draft PR` on a change that was genuinely
broken. The task built for it is `bench/factory/tasks/repo-scratch-duration-hours`: on the
scratch repository (see `bench/factory/README.md` for seeding it), the naive solution — teach
`formatDuration` about hours and forget `parseDuration` — fails the repository's **own** round-trip
test, and the correct one passes. Both were checked offline (`test/bench-factory-hidden.test.js`),
so a `fail` verdict on the naive candidate comes from a command that really failed, not from a
model's opinion.

```sh
windkeel-admin doctor
windkeel bench-factory bench/factory/tasks --only repo-scratch-duration-hours --check-hidden
windkeel submit --repo <owner>/orqon-bench-scratch --spend-cap 2 \
  --title "Show hours in formatDuration" \
  --description @bench/factory/tasks/repo-scratch-duration-hours/description.md
windkeel watch <run-id>
windkeel capture <run-id>                    # before the reaper, for the transcript of both turns
windkeel show <run-id>                       # the state history and the verdict per cycle
```

(`description.md` is the task's `description` plus its criteria as a `- [ ]` checklist —
`windkeel bench-factory --only repo-scratch-duration-hours` submits exactly that, if you would rather
run it through the bench.) Accept it only if the transitions show `VERIFYING → REPAIRING →
VERIFYING → PR_CREATING`, the first verdict is `fail` on the repository's tests and the second is
`pass`, and an off-machine check of the PR head passes: `git clone` the scratch repository, check
out the PR head, `npm test`. A maker that gets it right first time is not a failure of anything,
but it is not M5 either: run it again, up to three attempts, and record every one. Then update
the M5 row and "What M5 actually landed" in `research/MILESTONES.md` with the run id, cost and
duration — or, if three attempts do not converge, list them there, keep the row ⚠️, and open a
follow-up.

### The factory benchmark

`windkeel bench-factory` runs whole tasks against the deployment and scores the verifier against
hidden tests: success rate, verified false-accept and false-reject rates, repair conversion, cost
and time per task. It is observational and spends money — `$2` a task and `$50` a run by default —
so it is never in CI. How to seed its scratch repositories, run it, and record a run:
[`bench/factory/README.md`](../bench/factory/README.md).

## The sweeps

Both run on an **hourly Vercel cron** at `/api/sweep`: [ADR-0015]'s evidence retention and [#198]'s
sandbox reaper. The schedule lives in the Build Output API's `config.json`, emitted by
`apps/ingress/build-vercel-output.mjs` — **not in `vercel.json`**, where it would look right in
the repository and schedule nothing.

- **Retention** deletes the evidence packages of *superseded* verification runs past the 90-day
  window, and stamps `evidence_pruned_at` as the tombstone [ADR-0015] §3 requires. With no
  `S3_BUCKET` it reports itself skipped, with the reason, rather than sweeping nothing and calling
  that success.
- **The reaper** destroys sandboxes no process holds a handle to. `windkeel reap --dry-run` lists
  what it would destroy and why without touching anything; `windkeel reap` runs it now, under the
  cron's own lock, for an operator who cannot wait for the next tick. It matters much more than it
  used to: sandboxes now live for the lifetime their `expires_at` claims, up to four hours, where
  previously every one of them died at five minutes regardless.

- **Stalled runs** ([#340]) re-dispatches a run whose driving Workflow step died without
  throwing and was not redelivered — a binding at `running`, `queued`, `retrying` or `waiting`
  (a parked run re-ticks every 5 min, so a long approval wait never looks stalled) whose
  heartbeat (`workflow_run_binding.updated_at`) is older than **30 min** (30 poll ticks; a live
  step touches it at least every ~14 min: one 800 s step plus one 60 s poll sleep). The new
  execution resumes through the run's own handler, which reattaches the sandbox and the agent
  session; the old execution is fenced off by `execution_token` and stands down if it ever wakes.
  After 3 re-dispatches a run that stalls again is failed with `stop_reason = error` and a reason
  naming the state. See [docs/sweeps.md](sweeps.md#stalled-runs).

All take a Postgres session-level advisory lock, so overlapping invocations are safe — which is
assumed rather than hoped, because Vercel makes no single-delivery promise for crons and
deployments overlap during a rollout. This is also why `DATABASE_URL` must be session-mode: the
transaction pooler silently breaks advisory locks, verified empirically when two pooled
connections both acquired the same one.

An interrupted retention sweep repairs itself. A package is deleted from storage first and its row
nulled second, so a process killed between the two leaves a row pointing at a package that is gone
— and that row is *still eligible*, so the next sweep finds it, re-deletes (a no-op) and finishes
it off. The reverse ordering would leave objects no query can name again.

## Reading a repair loop

Two row counts look like they should agree and do not.

- **`repair_attempt`** — one row per *fail verdict*. VERIFYING writes it from the engine's packet,
  before anything decides whether a turn is affordable. REPAIRING attaches its `agent_run_id` and
  `result` to that same row rather than inserting a second one.
- **`agent_run` with `role = 'repairer'`** — one row per repair *turn actually taken*.

So a low-risk run that exhausts ADR-0011's cap of 3 ends with **four** `repair_attempt` rows and
**three** repairer runs. The last row has a null `agent_run_id`: it is the verdict that found no
budget left and stopped the run. `attempts = 4` against a cap of 3 reads like a breached cap and
is not one.

```sql
select attempt_number, agent_run_id is not null as had_turn
  from repair_attempt where engineering_run_id = $1 order by attempt_number;
```

## What a repair budget costs

ADR-0011 caps repair attempts by risk — 3 for low, 2 for medium, 1 for high — and that number is
the only lever an operator has. It counts *attempts*, not spend.

A repair **resumes** the maker's session (ADR-0017 keeps the sandbox and session alive through
verification precisely so it can), so each turn's prompt carries every turn before it. Measured on
run `f28748b2`, a documentation change to one file:

| turn | input tokens | of which cached | output | cost |
|---|---|---|---|---|
| maker | 424,658 | 94.8% | 1,532 | $0.093 |
| repair 1 | 699,795 | 96.2% | 2,723 | $0.144 |
| repair 2 | 936,517 | 96.7% | 4,141 | $0.193 |
| repair 3 | 1,207,733 | 97.1% | 5,308 | $0.243 |

Roughly **+260k input tokens per attempt**, and **$0.67** of model spend — $0.69 for the run.

**The cached column is the point, and it is newer than the rest of this section.** Until [#263]
every cached input token was billed at the full input rate, and this table read $0.55 → $0.90 →
$1.21 → $1.56 for a total of $4.24. That figure appeared in the run report, in this document, and
in the argument for giving the repair cap a spend dimension. It was about **6× too high**. Across
all 21 agent turns this system has run, 94.3% of input tokens were served from cache.

The growth in *tokens* is real and is what a resumed session costs. The growth in *dollars* is
mostly the same prefix, re-sent and re-cached, at a tenth of the rate.

### Estimating a cap before you set it

The per-turn increment is close to **0.6× the first turn**, and flat rather than compounding —
measured at 0.54, 0.57, 0.59, 0.64, 0.65 across four runs. So for a first turn costing `f` and a
cap of `n` attempts, the whole budget is about:

```
total ≈ f × (n + 1) × (1 + 0.3n)
```

| cap | multiple of one clean run | on content-machine (f ≈ $0.09) |
|---|---|---|
| 1 (high risk) | 2.6 × | ~$0.24 |
| 2 (medium) | 4.8 × | ~$0.45 |
| 3 (low) | 7.6 × | ~$0.70 |

Checked against `f28748b2`: $0.093 × 7.6 = $0.71 against an actual $0.67, within 6%. One clean
no-repair run on your repository gives you `f`; the table gives you the rest. `windkeel show`
prints each turn's cost, its delta and its cached share.

Two things still worth knowing:

- **The same cap means different money on different repositories.** Turn one's size is the
  repository's, and every resumed turn is larger again. `3` reads identically whether it buys
  $0.70 or $70. The formula above is what makes it readable; the cap itself does not.
- **The spend cap cannot see a turn until it ends.** Cost is recorded when an agent run completes,
  so a run crosses its cap and finds out afterwards. `enforceSpendAndTimeRails` is checked before
  spawning the next stage, which is correct — the number it checks is stale by one turn. At $0.24
  a turn against a $25 cap the overshoot is noise. It stops being noise on a repository where one
  turn is itself several dollars, and that is the condition to watch for.

Whether the cap should bound spend as well as attempts was decided in [#257]: it should not, yet.
The reasoning, and what would change the answer, is in ADR-0011.

## Stopping a run

There is no process to signal. To stop a run, stop *the run*:

```sh
windkeel cancel <run-id> [--reason <text>]
# or comment on the issue, or remove the `windkeel` label:
/windkeel cancel
```

The two are one mechanism with two doors ([ADR-0023] §3), so a run cancelled from either reads the
same on both.

**What happens to its sandbox is the part worth understanding.** Under the container, SIGTERM
destroyed every sandbox the process still held. There is no such moment now: nothing outlives a
stage, so no process is ever both holding a live sandbox and knowing it is about to stop. The
guarantee moved to the reaper, which is why the hourly cron is not optional.

The window is therefore **up to an hour of billing** for a sandbox whose run has stopped, bounded
by `expires_at` in the worst case. That is a real cost and a deliberate trade: the alternative was
a teardown that only ever worked for a graceful shutdown, and an abruptly-killed container leaked
until `expires_at` anyway.

## What a run actually looks like

Written from run `b409263b` (2026-09-22), the run that produced
[content-machine#92](https://github.com/jyothepro/content-machine/pull/92). Timings are that run's;
costs are real.

```
03:00:20  CREATED       → CLASSIFYING    task from github_issue jyothepro/content-machine#91, risk low
03:00:20  CLASSIFYING   → PLANNING       no separate plan; the maker plans
03:00:20  PLANNING      → PROVISIONING   6 acceptance criteria stated by the author;
                                         no generation, no approval pause (ADR-0012 §1)
03:00:40  PROVISIONING  → IMPLEMENTING   maker workspace ready                          (~20s)
03:04:0x  IMPLEMENTING  → VERIFYING      agent session produced candidate 065f05c4       (~3m30)
03:10:5x  VERIFYING     → PR_CREATING    verdict warn                                    (~6m30)
03:10:5x  PR_CREATING   → PR_READY       opened draft pull request #92
03:10:56  PR_READY      → WAITING_FOR_HUMAN
```

**$0.0997, 10m 36s, zero repairs.** Watch it with `windkeel watch <run-id>`; the run row is
authoritative and the transitions carry their own reasons.

The shape is stable across runs: intake is sub-second, provisioning ~20s, implementing 2–4
minutes, and **each verification 6–7 minutes**. That last number matters — it is why the
five-minute sandbox lifetime that shipped before #226 killed a scanner mid-stage and produced a
`warn` that read as a security finding.

### What a `warn` means here

Run `b409263b` ended `warn`, and correctly:

```
Acceptance criteria       5/6
Blocking findings         0
Advisory findings         2
Verdict of record         WARN
```

A `warn` reaches a human; it never goes to the repair loop (ADR-0003). Zero blocking findings with
two advisory ones is the reviewer noting things worth mentioning and declining to block on them.
A criterion the evidence cannot settle is `unknown`, which also warns — that is not the change
failing, it is nobody having checked.

### Where the money goes

One verification's model spend is the checker's; the rest is the maker's agent turn. On this run
the maker's turn was $0.0949 of the $0.0997 total — **the sandbox is noise and the model is
everything**.

A run that *repairs* costs more, though far less than it used to appear to: a repair resumes the
maker's session, so each turn carries every turn before it — and a carried prefix is cached, at a
tenth of the rate. Run `f28748b2` took four turns for **$0.69 total**. ADR-0011's cap counts
attempts, not spend; *What a repair budget costs* above has the table and the estimate.

## Before the first run: what to check

In this order, because each depends on the last.

1. **`windkeel-admin doctor`** — every check green. The skips it reports are honest and each says what
   running without it costs.
2. **`CRON_SECRET` is set on the deployment.** Without it both sweeps 401 hourly, silently apart
   from the cron log, and nothing is ever retained or reaped.
3. **Model credit.** Run `f420f448` failed at IMPLEMENTING with *"You have no credits remaining"*
   after provisioning a sandbox — $0.0003 and a sandbox to discover an empty balance.
4. **Label a real issue** with `windkeel`, with acceptance criteria as a `- [ ]` checklist. Criteria
   that can only be settled by *running* something ("the command works from a clean checkout")
   are hard to demonstrate and will usually come back `unknown`; prefer criteria a reader can
   check against the repository.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Labelling an issue does nothing, no run appears | The App's webhook URL. Run `windkeel-admin doctor` — the delivery check names the configured URL and reports whether anything arrives. A column of 404s means it points at a project that does not exist. Failing that, *Advanced → Recent Deliveries* on the App shows the same thing. |
| A run sits in `CREATED` forever | Created by `windkeel-admin task create` from outside a deployment, or by `POST /v1/tasks` before 2026-09-24, when neither enqueued anything a deployment could pick up. `POST /v1/runs` with the task id hands a `CREATED` run over now. |
| `windkeel submit` answers 503 `enqueue_failed` | The rows were written and the hand-over to the workflow failed. The message names the run; `POST /v1/runs` with the task id retries the same run. |
| `windkeel reap` or `windkeel capture` answers 503 `sandbox_unconfigured` | The deployment has no `WINDKEEL_SANDBOX_*` variables; the message names the one missing. |
| A run parked for approval reached `FAILED` with `wall_clock_cap` | Fixed in [#262]; the run predates it. The wall-clock cap used to be measured from `started_at` and re-checked every five minutes on a parked run, so the approval gate had an undocumented two-hour fuse. Re-add the `windkeel` label to start a fresh run. |
| `/windkeel approve` does nothing and nothing is posted | Two causes with the same silence. An unauthorised commenter is refused with no reply *on purpose* — answering would let anyone make the App post what they liked; `intake_delivery` records the refusal. Otherwise there may be no live run: a gate that expired answers on the issue, but a run that finished some other way does not. |
| A run sits in a state with no handler | Every non-terminal state needs one; a state without one is a *parking* state by design (it is how `WAITING_FOR_APPROVAL` works) and therefore silent. |
| Run at `BLOCKED` right after CLASSIFYING | The task had no acceptance criteria. |
| `evidence_package_ref` is null | No `S3_BUCKET` configured. |
| `evidence_package_ref` points at a package the store 404s for | A sweep was killed between deleting the objects and nulling the row. The next sweep repairs it; the ordering is chosen so it can. |
| Nothing is ever swept, storage grows, sandboxes outlive their runs | `CRON_SECRET` is unset, so `/api/sweep` 401s every hour. The cron log shows it. |
| Two sweeps appear to run at once | Expected and safe — the advisory lock serialises them. A problem only if *no* invocation ever logs a completion. |
| Advisory locks appear not to work at all | `DATABASE_URL` is the transaction pooler. Use the direct session-mode endpoint ([ADR-0008] §1). |
| Run `FAILED` at PROVISIONING saying a workspace's sandbox could not be re-attached | The row exists with no recorded handle, so nobody knows whether a sandbox was created. Provisioning a second one might double-spend, so the run stops instead. |
| Run fails at IMPLEMENTING with a version mismatch | The sandbox image's `codex` is not the pin (`WINDKEEL_CODEX_VERSION`, else the code's). Set `WINDKEEL_HARNESS_INSTALL=pinned`, re-pin it, or set `WINDKEEL_ALLOW_CODEX_VERSION_DRIFT=true`. |
| Refuses to start naming `WINDKEEL_CODEX_BINARY` | Local mode with no `codex` on this host. Install it, or set the `VERCEL_*` variables. |
| A verification stage reports `WARNING` with no findings | Something killed a scanner rather than a scanner finding something. Check the stage's exit code in the evidence package: 143 is SIGTERM, 137 is SIGKILL. |
| `E: Unable to locate package …` installing a declared tool | The egress proxy does not pass port 80. The install phase rewrites apt sources to HTTPS; a source it does not know about will still fail. |
| A repair turn completes and changes nothing | Usually a check that *could not run* being reported as a check that failed, so the repairer is asked to fix code for a command that does not exist. |
| `MAX_REPAIR_ATTEMPTS_REACHED` with *more* `repair_attempt` rows than the cap allows | Not a breached cap. A `repair_attempt` row is written by VERIFYING for **every** fail verdict, not per repair *turn* — so a low-risk run that hits the cap has four rows and three turns: the fourth verdict found no budget and stopped the run. Count `agent_run` rows with `role = 'repairer'` to see the turns actually taken. |
| A correct change ends `MAX_REPAIR_ATTEMPTS_REACHED` and the repair turn changed nothing | The repairer may be right, and the criterion may be unsatisfiable. A criterion can be contradicted by a fact no diff can alter — a miscount, a filename that does not exist, a stale line number — and that is recorded as `unsatisfied`, which fails the run and then asks a repairer to close something no change can close. Observed on run `db2bdce9`: a criterion said *seven* pre-existing tests and the file held **eight**, the mapper's own reason ended "even though these tests are unchanged and pass", and a correct change died at 7/8 for $0.2931. Read the mapper's `reason` for the failed criterion in the evidence package before blaming the repairer; if it disputes a fact rather than the change, that is [#273]. |
| A run burns its whole repair budget on a change that looks correct | Check whether every finding says the diff gives *no evidence* for something, rather than that something is wrong. The reviewer reads only the diff, and a criterion it cannot judge is recorded as unmet — so a criterion answerable only from the repository ("this file exists") can never be satisfied. Observed on run `f28748b2`: four verdicts, no pull request, correct change. |
| `WINDKEEL_WORKFLOW_BACKING=pg-boss` refuses to start | That backing was deleted by [#200]. Unset the variable. |
| A run is refused because it is bound to `pg-boss` | It was started before [#200] deployed and nothing will tick it again. It cannot be adopted; cancel it. |
| A run sat at `IMPLEMENTING` (or any stage) for half an hour or more, then moved on | The step driving it died without throwing — a killed function, a timeout, a deploy rollover — and the stalled-run sweep re-dispatched it ([#340]). `workflow_run_binding.reclaim_count` counts how often; the sweep's log line names the run, its state and its last heartbeat. Nothing needs doing. |
| Run `FAILED` saying its driving step "stopped making progress … re-dispatched 3 time(s)" | The stalled-run sweep's bound. Three fresh executions stalled in the same state, which is a bug in that stage (or the platform), not bad luck — read the stage's logs around `workflow_run_binding.reclaimed_at`. |
| Run `FAILED` at IMPLEMENTING saying an agent "was being launched when the delivery launching it stopped" | The delivery that launched the maker died before recording the session's reference, so whether an agent is running in the checkout is unknown. Launching another could put two agents in one checkout, so the run stops and its sandbox is released, which stops any agent that did start ([#340]). Rare: the window is one `start()` call. |
| Run `FAILED` at IMPLEMENTING or REPAIRING saying a session "cannot be re-acquired" | The agent's session output is gone from the sandbox (reset or replaced). Its checkout may hold edits, but there is no turn to finish, and a fresh agent on that checkout would be a second agent on one attempt — so no new agent is started. |
| Run `FAILED` saying "implementing failed: …" / "repairing failed: …" | The stage threw after its maker sandbox was released, so a retry would have had nothing to resume. The message is the error that actually happened ([#340]; before that the retry failed one delivery later naming a missing workspace). |
| `workflow_run_binding.tick_budget_exhausted_at` is set | The run's durable execution ran out of ticks and ended. At the parked-run sleep that is **6.9 days** at `WAITING_FOR_HUMAN`, so it is what a pull request nobody has merged for a week looks like. The run row is unharmed and exactly where it was, and the next signal — a merge, a close, a cancel — adopts it and carries on; nothing needs doing. A run *not* parked showing this has looped 2000 times, which is a bug worth reading the transitions for. |

## Billing, budgets and self-serve signup

ADR-0037 and ADR-0038 (#394). Nothing here changes a deployment that does not opt in: with no
budget row an organization is unlimited, the default account is never billed, and the billing
provider is the in-memory fake.

- **Usage** is the cost ledger for one calendar month (UTC): `windkeel usage [--period YYYY-MM]`, or
  `GET /v1/usage`. Billable is Windkeel-key AI cost × `WINDKEEL_BILLING_AI_MULTIPLIER` plus the compute fee
  (all sandbox cost × `WINDKEEL_BILLING_COMPUTE_MULTIPLIER`, plus `WINDKEEL_BILLING_VERIFICATION_FEE_USD`
  per verification). Own-key (BYOK) spend is shown and never billed; unpriced calls are counted and
  never invoiced. Verification is its own line and is never waived.
- **Budgets**: Settings → Billing, or `PUT /v1/budget`. A spent month refuses new runs at intake
  (`402 org_budget_exhausted`) and stops a running run before its next maker turn (`org_budget`).
  A verification already under way always finishes, and its verdict stands.
- **Reporting** runs on the hourly sweep (`docs/sweeps.md`): each billed organization's month is
  reported to the provider as increments, keyed so a retry is never a second charge.
- **Stripe**: `WINDKEEL_BILLING_PROVIDER=stripe` with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
  `STRIPE_METER_EVENT_NAME` (a meter priced at US$0.000001 per unit — usage is reported in micro-USD),
  and `STRIPE_PRICE_ID`, the metered price on that meter that overage and pay-as-you-go usage are
  invoiced on (required since #439: every plan checkout carries it). The credit plans and packs
  (ADR-0040) need `STRIPE_PRICE_STARTER|PRO|TEAM|SCALE` (monthly) and `STRIPE_PRICE_TOPUP_10|25|50`
  (one time). Point a Stripe webhook at `https://<deployment>/v1/billing/webhooks/stripe` with
  `checkout.session.completed`, `invoice.payment_failed`, `invoice.paid`,
  `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. `windkeel-admin doctor` and
  `/api/preflight` fail by name when a key is missing.
- **Invite-only signup**: set `WINDKEEL_SELF_SERVE_SIGNUP=invite`, `WINDKEEL_GITHUB_APP_SLUG`, and the App's
  install settings (`docs/github-app.md` §7); mint codes with `windkeel-admin signup-invite`. A new
  account starts on credits with a one-time trial of 500 credits (ADR-0040). The console sends a
  signed-in person with no organization to `/welcome` instead of *not a member*.
