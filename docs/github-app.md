# The Windkeel GitHub App

Zero to a verified draft pull request. Everything here is ADR-0009's scope and nothing more — if a
step asks you to grant a permission this page does not list, something is wrong.

## What it does

Add the **`windkeel`** label to an open issue. Windkeel reads the issue, verifies a candidate change
against the issue's own acceptance criteria in an independent sandbox, repairs it if verification
fails, and opens a **draft** pull request with an evidence summary and an
`windkeel/verification` check run. A human reviews it, marks it ready, and merges. Windkeel never marks
ready, approves, or merges — the client has no method for any of those.

> **Behind a flag ([ADR-0029](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) §5, #371):** a person can merge from the console, with
> *their* GitHub user-to-server token (a one-time authorization), so branch protection and required
> reviews apply and GitHub attributes the merge to them. The App's own client keeps no merge method,
> and its installed permissions don't change. Off unless the deployment sets `WINDKEEL_MERGE=1` and an
> organization admin turns it on — see [§6](#6-merging-as-the-person-optional-off-by-default).

## 1. Register the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Field | Value |
|---|---|
| Name | anything; `windkeel` is the obvious choice |
| Homepage URL | your repository or site |
| Webhook URL | `https://<your-ingress-host>/api/webhook` |
| Webhook secret | generate a long random string — you will need it twice |
| Where can this be installed | **Only on this account** (ADR-0001: single-tenant until the Product UI milestone) |

### Repository permissions — exactly these

| Permission | Access | Why |
|---|---|---|
| Metadata | Read | mandatory; default branch and clone URL |
| Issues | Read & write | read the labelled issue, post run-start and terminal comments |
| Contents | Read & write | clone, create the working branch, push the candidate |
| Pull requests | Read & write | open the draft PR, edit the sticky evidence comment |
| Checks | Read & write | publish `windkeel/verification` on the candidate |

Nothing else. No Actions, no Administration, no Webhooks management, and nothing
organization-level. Windkeel fails a run loudly if a permission it needs is missing (ADR-0009 §6); it
never degrades quietly, so an over-broad grant buys you nothing.

### Subscribe to exactly five events

- **Issues** — `labeled` triggers a run, `unlabeled` cancels it.
- **Issue comment** — `created`, for `/windkeel approve` and `/windkeel cancel`.
- **Pull request** — `closed`, so a merge drives the task to `COMPLETED` without polling.
- **Pull request review** — `submitted` with *changes requested*, or *commented* with text, on a
  pull request Windkeel opened, becomes a **suggested** repository-knowledge note (#432, ADR-0032).
- **Pull request review comment** — `created`, the same for an inline comment, recording its path
  and line.

Review feedback is never applied on its own: it waits under *Knowledge → Suggested* until a person
accepts it. Reviews and comments by bots, Windkeel's own included, are ignored, and so is an approval.
The two review events need no new permission: **Pull requests: Read & write** already covers them.

### Generate a private key

At the bottom of the App's settings page, **Generate a private key**. It downloads a `.pem`. That
file is the App's identity; treat it like a password.

## 2. Install it on a repository

App settings → **Install App** → choose the account → **Only select repositories** → pick the one.
Same-repo only is a v1 rule (ADR-0009 §6): events from forks are ignored, and Windkeel never opens a
pull request from or into one.

## 3. Configure the two deployables

Windkeel is two processes (ADR-0002). They share a database and nothing else.

### The ingress (Vercel, `apps/ingress`)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | direct/session-mode Postgres, never through a pooler (ADR-0008 §1) |
| `GITHUB_WEBHOOK_SECRET` | yes | the secret from step 1; every delivery is verified before anything is persisted |
| `GITHUB_APP_ID` | yes | the numeric App id |
| `GITHUB_APP_PRIVATE_KEY` | yes | the PEM. A raw PEM, a PEM with `\n` escapes, or base64 of one all work |
| `CRON_SECRET` | no | not read by the webhook route. Required by `/api/sweep` — see below |
| `WINDKEEL_WORKFLOW_BACKING` | no | `vercel-workflow` is the only value and the default. A deployment still setting `pg-boss` is refused by name (#200) |
| `GITHUB_APP_INSTALLATION_ID` | no | discovered per repository when absent (ADR-0001 — one installation) |
| `GITHUB_API_BASE_URL` | no | defaults to `https://api.github.com`; set it for GitHub Enterprise Server (`https://HOST/api/v3`). OAuth for merging as the person uses the matching web host |
| `WINDKEEL_MERGE` | no | `1` turns on merging as the person (§6). Anything else, or unset, and every merge route answers 404 |
| `WINDKEEL_KNOWLEDGE` | no | `off` turns repository knowledge off (#388): no knowledge in the maker's prompt, no digest, no learned lessons. On by default. `WINDKEEL_KNOWLEDGE_MAX_CHARS` (default 12000) bounds it; see `docs/running-the-factory.md` |
| `GITHUB_APP_CLIENT_ID` | no | the App's OAuth client id (`Iv…`), for finishing a person's GitHub authorization and refreshing it (§6) |
| `GITHUB_APP_CLIENT_SECRET` | no | the App's client secret, same use. Never sent to a browser |
| `WINDKEEL_WEBHOOK_SIGNING_KEY` | no | not read by the webhook route. Derives every signed-webhook endpoint secret (`docs/webhook-intake.md`); at least 32 bytes — shorter counts as unset — and without it signed webhooks answer 503 |
| `WINDKEEL_SELF_SERVE_SIGNUP` | no | `invite` (or `1`) turns on invite-only self-serve signup and installation linking (ADR-0038, §7 below). Unset: single-tenant, first-seen installations are the default account's |
| `WINDKEEL_GITHUB_APP_SLUG` | no | the App's URL slug, for the install link the welcome wizard offers (`https://github.com/apps/<slug>/installations/new`) |
| `WINDKEEL_BILLING_PROVIDER` | no | `fake` (default) or `stripe` (ADR-0037). `stripe` needs the `STRIPE_*` variables below, and preflight fails by name without them |
| `STRIPE_SECRET_KEY` | no | Stripe's secret API key, when the provider is `stripe` |
| `STRIPE_WEBHOOK_SECRET` | no | verifies `POST /v1/billing/webhooks/stripe`, when the provider is `stripe` |
| `STRIPE_METER_EVENT_NAME` | no | the Stripe meter usage is reported to (priced per micro-USD), when the provider is `stripe` |
| `STRIPE_PRICE_ID` | no | the metered price on that meter that overage and pay-as-you-go usage are invoiced on; required when the provider is `stripe` (#439), with the `STRIPE_PRICE_<PLAN>` and `STRIPE_PRICE_TOPUP_*` prices |

**`CRON_SECRET` is required in practice, by a different route.** `/api/sweep` runs ADR-0015's
evidence retention and #198's sandbox reaper on an hourly cron, and it fails **closed** without
the variable. The webhook starts fine regardless, which is why it is a `no` here and not a `yes`
— but a deployment without it never retains evidence and never reaps a sandbox, and the only
sign is an hourly 401 in the cron log. See `docs/sweeps.md`.

**Why the ingress holds App credentials even though it never orchestrates.** ADR-0002 §3 forbids
the Vercel side a *blocking step of a run* — no model call, no sandbox, no stage handler. It does
not forbid it a voice. A delivery that the ingress refuses, or accepts and turns into a run, is
answered on the issue itself: "the issue is closed", or the run-start comment naming the criteria
Windkeel will verify against. That comment is a GitHub API call, it happens after the delivery's
transaction commits, and it needs the App's own identity — so `apps/ingress/api/webhook.ts`
builds its client at module scope and the function will not initialise without an App id and a
private key. An operator who leaves them out gets a 500 on every delivery, which is a
particularly unhelpful way to learn this.

The line is therefore *orchestration*, not *network*. Everything that decides what a run does next
lives in the worker; the ingress only acknowledges.

**Deploying it.** `apps/ingress/vercel.json` carries everything except the settings Vercel only
accepts from its own UI:

1. **New Project → import this repository.**
2. **Root Directory: `apps/ingress`.** This is the setting that puts the function at
   `/api/webhook`; Vercel only turns files under `<root-directory>/api/` into functions. Leave
   *Include files outside the Root Directory in the Build Step* **on** — the ingress reaches the
   root `dist/` through a workspace symlink and will not build without it.
3. **Node.js Version: 22.x.** `apps/ingress/package.json` declares it too; the project setting is
   the one Vercel applies.
4. **Framework Preset: Other**, and do not override Build or Install Command in the UI — they come
   from `vercel.json` and they climb to the repository root on purpose. Overridden, the build runs
   only the ingress's own `tsc` and fails with
   `Cannot find module 'windkeel/dist/factory/repository-entity.js'`.
5. **Environment variables:** the four required ones above, for Production — and for Preview too if
   you want preview deployments to be able to start at all. `DATABASE_URL` must be the direct
   session-mode string, not the pooler (ADR-0008 §1).
6. **Deploy**, then open the deployment's root URL. It serves a one-line page naming the app: the
   cheapest confirmation that the build succeeded and routing works, and it costs no delivery.
7. **Set the App's Webhook URL** to `https://<your-deployment>/api/webhook`, then use Advanced →
   Recent Deliveries → **Redeliver** to send a real signed request. A 200 with `{"ok":true,…}`
   means the whole path is live — signature, database, queue. A 500 naming a variable means step 5
   is incomplete, and the response body says which one.

`docs/webhook-ingress.md` §Deploying it explains why each line of `vercel.json` is what it is,
including why nothing is listed in `includeFiles`.

See `docs/webhook-ingress.md` for the endpoint's behaviour, status codes, and idempotency.

### The stage host (the same deployment, since ADR-0020)

Everything in `docs/running-the-factory.md`, plus the App's own credentials. This used to be a
separate container; #200 deleted it, and the flow function that executes a run's stages now reads
the same environment from the same deployment:

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_APP_ID` | yes | the numeric App id. Its presence is what switches the factory out of ADR-0016's hermetic mode, so an unset one is *legal* and means "no GitHub" |
| `GITHUB_APP_PRIVATE_KEY` | yes | required once `GITHUB_APP_ID` is set; the same PEM as above |

`GITHUB_WEBHOOK_SECRET` is read only by the webhook route, which is the only thing that verifies
a signature.

With the App configured, the factory mints a **per-workspace, per-role installation token** for
every sandbox: `contents: write` for the maker, `contents: read` for the verifier (ADR-0014 §2).
The verifier is therefore unable to push — the remote refuses it — which is the property
independent verification rests on. `SANDBOX_GIT_TOKEN` is local-development only and cannot be
scoped per role; leave it unset in production.

## 3½. Preflight, before anything costs money

```sh
windkeel-admin doctor
```

Validates every worker variable, connects to Postgres and confirms it is direct rather than
pooled, writes and reads back one object, **mints a real installation token and compares this
App's grant against §1's list in both directions**, mints the maker's and verifier's tokens and
asserts their scopes differ, reaches both model endpoints, and creates and destroys one sandbox.
Exit 1 if anything failed.

Two things it will tell you that this page cannot. First, whether the permissions you actually
granted match §1 — including anything granted *beyond* it, which is a finding rather than a pass.
Second, whether the App's private key and id in your two deployables are the ones the
installation expects, which is otherwise discovered as a 500 on the first delivery.

`docs/running-the-factory.md` has the full check list, what each skip costs, and a note on what
the command itself has and has not been proven against.

## 4. Trigger a run

1. Open an issue. **State the acceptance criteria as a checklist**:

   ```markdown
   The uploader gives up on the first 500.

   - [ ] retries a 500 three times with backoff
   - [ ] gives up after the third and reports the failure
   ```

2. Add the **`windkeel`** label.
3. Windkeel comments that it has started, naming the criteria it will verify against.

**If the issue states no criteria**, Windkeel proposes some, posts them, and **waits**. Nothing is
provisioned and nothing is spent until you reply `/windkeel approve` (ADR-0012). Reply
`/windkeel cancel`, or remove the label, to stop instead.

Optionally add a **`risk:high`** (or `risk:medium` / `risk:low`) label. Risk is operator-set in
M6 — it decides how many autonomous repair attempts a run gets (ADR-0011 §1), and Windkeel does not
infer it.

## 5. What you get

- A **draft pull request**, titled from the issue, whose body is the evidence summary and
  `Resolves #<issue>`.
- An **`windkeel/verification` check run** on the candidate commit: `success` for a pass, `neutral`
  for a warn, `failure` for a fail.
- **One sticky comment** on the pull request with the full summary — criteria and whose words they
  are, every verification cycle, repair history, model provenance, and cost. It is *edited* on
  re-verification, never re-posted.
- **One comment on the issue** when the pull request opens. The issue hears at run start and at
  the end, never per stage.

You mark it ready for review, and you merge it — on GitHub, or from the console as yourself where
§6 is on. When you do, the run reaches `COMPLETED`; if you close it unmerged, the run is
`CANCELLED`, with the reason recorded either way.

## 6. Merging as the person (optional, off by default)

[ADR-0029 §5](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md),
#371. **Not for release until ADR-0029's flip condition 2** — a person runs Spike C's harness
(`research/spikes/user-merge/`) against a protected branch and the results show the wrong-SHA probe
answered 409, the merge 200 and `merged_by` the person. Until then, leave it off in production.

The App's installed permissions do not change: merging needs Contents: write, which §1 already
grants, intersected with the person's own repository permission. **Do not add Workflows**: a pull
request that touches `.github/workflows/*` is refused with *merge it on GitHub* instead (a GitHub App
user token has no OAuth scopes; it would need the App's Workflows permission).

1. **App settings → General** (Spike C, FINDINGS.md *Running it* §1):
   - **Callback URL:** `https://<console-host>/api/github/user-authorization/callback`.
   - **Expire user authorization tokens:** leave **checked**. Access tokens last 8 hours and refresh
     tokens 6 months, single use; Windkeel refreshes only when a merge needs it, under a row lock. A
     non-expiring token would be a long-lived merge credential for everyone who connected.
   - **Request user authorization (OAuth) during installation:** not needed.
   - **Enable Device Flow:** only for running Spike C's harness; the console uses the web flow with
     `state` and PKCE.
   - Note the **Client ID** and **generate a client secret**.
2. **The control plane deployment:** `WINDKEEL_MERGE=1`, `GITHUB_APP_CLIENT_ID`,
   `GITHUB_APP_CLIENT_SECRET` (§3), and `WINDKEEL_SECRET_PUBLIC_KEY` / `WINDKEEL_SECRET_PRIVATE_KEY` as for
   model credentials — the tokens are sealed with the same box. The merge runs in a one-step workflow
   on the stage side, the only place a token is opened.
3. **The console:** `GITHUB_APP_CLIENT_ID` (the same value; it is public), and on GitHub Enterprise
   Server the same `GITHUB_API_BASE_URL` as the control plane: OAuth there is on the enterprise host
   (`https://HOST/login/oauth/…`), which both the console's authorize link and the API's code
   exchange and refresh derive from it. Sign-in must be on
   (Supabase GitHub), because the token's GitHub account is checked against the account the person
   signs in with, and both connecting and merging refuse a token caller.
4. **An organization admin** opens Settings → Merging and turns on *Allow merging from Windkeel*.
5. **Each person who merges** (Admin role: `runs.merge`) opens Settings → Merging → *Connect GitHub
   to merge* once, and authorizes with the GitHub account they sign in with. A different account is
   refused and its token revoked.

Then a verified pull request's run shows **Verified — review and merge**; *Merge pull request* (or
*Mark ready and merge* for a draft) opens a dialog with the verified SHA and, on a warn, each item to
acknowledge. Windkeel merges only that SHA (GitHub refuses with 409 if the head moved), never on
`BLOCKED`, never as anyone GitHub reports can bypass the repository's protection (an admin while
*Do not allow bypassing the above settings* is off, or anyone on an active ruleset's bypass list —
read with the person's token from `viewerCanMergeAsAdmin` and each ruleset's
`current_user_can_bypass`), and records a `run_merge` row. **For an admin to merge from Windkeel, turn on
*Do not allow bypassing the above settings* (or empty the ruleset's bypass list).** The `pull_request.closed`
webhook still moves the run to `COMPLETED`.

Because `windkeel[bot]` opens the pull request, the person merging can be its only required approver.
An organization that wants two people should require a review from someone other than the merger in
GitHub. A person revokes Windkeel on github.com under Settings → Applications → Authorized GitHub Apps;
the next merge then fails as `needs_reauth` and the console asks them to connect again.

## Commands

| Comment on the issue | Effect |
|---|---|
| `/windkeel approve` | Approves generated acceptance criteria; the run provisions and starts work |
| `/windkeel cancel` | Cancels the active run |
| Removing the `windkeel` label | The same cancellation, through the same path |

Commands must be **the first line** of the comment — a comment that merely mentions
`/windkeel cancel` in a sentence is prose, not an instruction — and only someone with push access to
the repository can issue one.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing happens after labelling | The delivery's response body carries the reason. Check the App's Advanced → Recent Deliveries: `label X is not the trigger`, `… is a fork`, `the issue is closed`. |
| 401 on every delivery | `GITHUB_WEBHOOK_SECRET` differs between the App and the ingress. |
| Runs fail with "the App's permissions changed mid-run" | A permission was removed after installation. Re-grant it in the App's settings and re-apply the label. |
| A run sits at `WAITING_FOR_APPROVAL` | The issue stated no criteria. Reply `/windkeel approve` or `/windkeel cancel`. |
| A run sits at `CREATED` | The queue never received it. Re-applying the label re-enqueues it, which is the intended repair. |

`windkeel show <engineering-run-id>` prints everything above from the database alone, for a run
still in flight or long finished.

## 7. Self-serve: linking an installation to an organization (ADR-0038)

With `WINDKEEL_SELF_SERVE_SIGNUP=invite`, an installation is no longer the default account's the first
time Windkeel sees it: it waits for the person who installed it to link it from the welcome wizard.

1. In the App's settings, turn on **Request user authorization (OAuth) during installation**, and set
   the **Setup URL** to the console's `/api/github/installation-callback` (redirect on update too).
   The App's client id and secret (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`) must be on the
   API: they trade the callback's `code` for the user token that proves the person **owns** the
   installation: it is listed in `GET /user/installations`, and its account is that person or an
   organization they are an active admin of. Without them linking answers 503.
   For installations on organizations, the self-serve App also needs **Organization permissions →
   Members: Read**, so the user token can call `GET /user/memberships/orgs/{org}`; without it an org
   admin is refused as `installation_not_owned`. (A single-tenant App needs nothing organization-level.)
2. Set `WINDKEEL_GITHUB_APP_SLUG` so the wizard can offer the install link.
3. The wizard asks the API for a single-use state (`POST /v1/github-installations/state`), sends the
   person to GitHub, and the callback posts `installation_id`, `state` and `code` to
   `POST /v1/github-installations`. The installation's repositories are granted to the organization.
   The person must still hold `repositories.manage` in that organization when the callback lands:
   someone removed, or whose role lost it, inside the 30-minute window is refused with
   `403 permission_revoked`. It is checked before the state is spent (so a refusal there leaves the
   state usable if the permission comes back) and again, with the membership and role rows locked, in
   the transaction that claims the installation.

An installation another account already owns — including one the default account claimed before
signup was turned on — is refused with `409 installation_claimed`; move it deliberately, not by a
callback.
