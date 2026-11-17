# @windkeel/console

The Windkeel console — the Product UI milestone's web surface. Next.js on Vercel
([plan §10](../../docs/archive/2026-11/vercel-supabase-architecture-plan.md)), styled entirely by the design library
in [`design/`](../../design/README.md). What it shows and why: [docs/ui/console-ux.md](../../docs/ui/console-ux.md).

## Testing locally

**UI only, on sample data.** No setup:

```bash
npm install
npm run dev -w @windkeel/console        # http://localhost:3100
```

Every page renders from `lib/fixtures.ts`, one run in each state, and says *Showing fixtures* at
the top. Commands (approve, cancel, guidance, new task) refuse, because there is no factory to
send them to.

**Against the real API, on your machine.** The console calls the same `/v1` handler Vercel runs,
served locally by `scripts/local-api.mjs`:

```bash
npm run build                                      # builds apps/ingress/dist, which the script serves
createdb -h localhost windkeel_console
DATABASE_URL=postgresql://localhost:5432/windkeel_console npm run db:migrate
npm run api:local -w @windkeel/console -- --seed-repository jyothepro/windkeel    # /v1 on :8787

# second terminal
WINDKEEL_API_URL=http://localhost:8787 WINDKEEL_API_TOKEN=local-dev-token npm run dev -w @windkeel/console
```

Then *New task* files a real task and run through `POST /v1/tasks`, and *Cancel run* really
cancels it. The run stays **Queued** otherwise: nothing locally executes runs (that's the factory
worker, `docs/running-the-factory.md`), so states past `CREATED` only appear on a database a
factory has worked in. Point `DATABASE_URL` at one, or `WINDKEEL_API_URL` at a deployed ingress, to
see real verifications. The local API has no GitHub App, so a command that needs GitHub fails
instead of touching a real account; with no evidence storage configured, evidence files don't
load.

`npm test -w @windkeel/console` runs the state, decision and feed logic under `node --test`.

## Sign-in (ADR-0024)

With these set, people sign in with GitHub through Supabase Auth, and the console calls the API as
*them* — their role decides what they see and can do. Without them, the console runs on
`WINDKEEL_API_TOKEN` exactly as before.

| Variable | What |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | The Supabase project's URL. Public by design. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Its publishable (anon) key. Public by design. `NEXT_PUBLIC_SUPABASE_ANON_KEY` also works. |
| `WINDKEEL_API_URL` | The control plane. `WINDKEEL_API_TOKEN` isn't needed once people sign in. |

In the Supabase project, **add** `https://<console>/auth/callback` to the redirect URLs — beside the
other products' URLs on the shared project, never replacing them (ADR-0024 §5).

What's there:

- **`/login`**: *Continue with GitHub*. It's sign-up too: a GitHub sign-in grants nothing on its
  own, and you're in once an organization has invited your GitHub account.
- **`/not-a-member`**: signed in, but no organization has invited you. It says who you're signed
  in as, and never creates an account.
- **`/login/device`**: approving `windkeel login` from a terminal. It shows the code large and says what
  approving grants, in large type for `--admin`. It needs a signed-in person; a token can't approve.
- **Settings** (`/settings`, its own section with its own sidebar): *General*, *Your tokens*
  (presets Read / Execute / Approve / Admin, or Custom, shown once), *Members and invitations*,
  *Repository access*, each at `/settings/<section>`. Each shows only with the permission it needs.
  There are no organization tokens yet.
- **Automations** (M8, also under Settings): *Integrations* (Slack, Linear and Jira workspaces
  connected through Vercel Connect, and their routes to granted repositories), *Schedules* (cron
  tasks, with the API's live "next 3 fire times" preview, fire-now and an on/off switch), *Webhook
  endpoints* (signed intake URLs, with a curl example each) and *Service principals* (the
  identities automations act as, and their tokens). Integrations and schedules are readable with
  `runs.read` and changeable with `integrations.manage` / `schedules.manage`; webhook endpoints need
  `integrations.manage` even to list; service principals need `tokens.manage`. A webhook secret or
  service token is answered once by the API, shown once from the form's memory, and never stored,
  logged or put in a URL.
- **Source badge** on tasks and runs: GitHub, Slack, Linear, Jira, Schedule, Webhook or API, linking
  back to the origin where the task's `sourceContext` allows (https only).
- **Organization switcher**: a menu at the top of the sidebar, when you're in more than one.

`proxy.ts` refreshes the session on every request and sends anyone signed out to `/login`.

## Before deploying it

**Without sign-in configured, the console has no sign-in.** It acts with the operator token it holds,
so anyone who can reach a deployed console can approve criteria, cancel runs and file tasks. Set the
Supabase variables above, or keep it on your machine, or deploy it only behind Vercel Deployment
Protection. Deployed with no API settings at all, it refuses to show sample data and says what's
missing instead.

## How it works

- **The browser never holds the token.** Pages read `/v1` from the console's server (`lib/api.ts`),
  commands are server actions, and the live feed is piped through `app/api/runs/[id]/events`.
- **The shell paints first, data streams in.** The sidebar's frame and each page's skeleton
  (`loading.tsx`) render at once; the sidebar's runs and each run-page section arrive in their own
  `<Suspense>` boundary. A run page renders its feed's newest 100 events and follows live from
  there; older pages load on request, and a reload shows what the tab last showed (sessionStorage)
  while the stream resumes from its cursor.
- **Lists stay live without polling.** `components/live-lists.tsx` follows the organization's run
  changes (`app/api/events` → `GET /v1/events?stream=sse`) and refreshes the page a moment after a
  run moves: at most once every 10 s for other runs' changes, every 4 s for the run open on the page;
  with that stream down, every five minutes.
- **With no factory configured it runs on fixtures** (`lib/fixtures.ts`) and says so on every page.
- **It never computes a verdict.** `lib/run-states.ts` decides only how to draw one, and its test fails
  if the state list drifts from `src/factory/run-state-machine.ts`.
- `design/windkeel.css` is generated: change the library under `design/` and run
  `node design/scripts/build.mjs`, never edit the built file.
