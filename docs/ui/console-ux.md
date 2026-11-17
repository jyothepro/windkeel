# The console — views, flows, and what the API still owes them

Written 2026-09-24 as the first step of the Product UI milestone (M7). This is the research the
scaffold in `apps/console` is built from: who the console is for, the views it needs, the flows
between them, which `/v1` endpoint feeds each one, and where the API does not yet carry what a
view has to show.

**Revised 2026-10-17 for [ADR-0029](../adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)
(Proposed):** Windkeel is now an integrated coding assistant in the cloud. A run is presented as a
**session** (conversation beside a workspace), a person can **take over** in a workspace of their
own and hand back, the composer picks the **agent and model**, and the console can **merge as the
person**, only what was verified. Sections marked *(ADR-0029)* describe the target; the rest is
built. The phased plan is [docs/roadmap-integrated-assistant.md](../roadmap-integrated-assistant.md).

Sources: [control-plane-api.md](../control-plane-api.md) and
[ADR-0023](../adr/0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md)
(the contract), `src/factory/run-state-machine.ts` (the states), `src/factory/run-report.ts` (the
report), `packages/verification/src/evidence/format.ts` (the package), and the design system in
`design/` (voice, color jobs, components).

## Who it is for, and the one question

Single-tenant until organizations land in this milestone
([ADR-0001](../adr/archive/0001-v1-single-tenant-product-shape.md)), so today there is one kind of person:
**the operator** — they give Windkeel work, decide when it asks, and review what it brings back.
With ADR-0029 the same person also works *alongside* Windkeel: they watch it, take over, hand back
and merge.

**The console is a coding assistant whose every change is independently verified:** give Windkeel
work, watch it or step in whenever you want, and get back a change that a separate verifier has
checked. Other agent products make agent work easy to *start*. Windkeel makes it easy to start *and*
to *trust*. That puts the weight on:

- independent verification, visibly separate from the maker — and from the person, when they edit;
- a clear line from intent (the criteria) to evidence;
- honest reporting of skipped and unfinished checks;
- a portable audit trail;
- human decisions that fit on one screen.

The design system names the question every screen answers: *what is the agent doing, and did it
work?* Three rules follow:

1. **The console merges only as you, and only what was verified** *(ADR-0029 §5; built behind
   `WINDKEEL_MERGE=1` and the organization's *Allow merging from Windkeel*, #371 — where either is off the
   rule is the old one: the console is not a second GitHub)*. The merge uses the signed-in
   person's GitHub token, so branch protection and required reviews apply and GitHub attributes it
   to them; the App itself still never merges ([ADR-0009](../adr/0009-github-app-scope-for-milestone-6.md)).
   The button appears only when the PR's head is the verified candidate, the verdict of record is
   `pass` (or `warn`, acknowledged item by item), the person holds `runs.merge`, and the organization
   allows it. The console still never calls a change *merge-ready*: it says *Verified — review and
   merge*. `decision.test.ts` enforces the wording.
2. **The console never computes a verdict.** It shows the package's. Same rule as the run report
   (#228): one place decides, every renderer repeats.
3. **Every run leads with a decision.** What Windkeel needs, why, what to do, and what happens then,
   modelled on the approval screen. `lib/decision.ts` writes it, so the inbox line and the run
   page can't disagree.

## Information architecture

```text
/                         Home: the composer, then what needs you (ADR-0029; today → redirects to /runs)
/runs                     Inbox: views All · Needs you · In progress · Done (?view=), filterable by repository
/runs/[id]                Session: conversation (decision bar, activity, chat) beside workspace tabs (ADR-0029);
                          today: decision → criteria → what changed → needs a look → activity; evidence panel beside
/runs/[id]?tab=…          Workspace tab in the URL: changes · terminal · files · criteria · evidence · progress
                          · workspace (the human workspace while HUMAN_EDITING)
/runs/[id]/evidence/[v]   One verification's package, stage by stage
/tasks                    Tasks, filterable by repository / status / source
/tasks/new                New task: a guided composer (starts the first run)
/tasks/[id]               Task: criteria with provenance, and every run of it
/repositories             Repositories as cards: default branch, open runs; ?q= searches
/repositories/[id]        One repository's runs, and its secret names (values can't be read back)
/metrics                  The ADR-0013 views, nulls shown as "not measured"
/settings                 Settings' own section: an index of what you can manage
/settings/[section]       general · tokens · members · access · models (presets) · merging, each shown only with its permission
```

The shell has two columns: the sidebar and the page. Top to bottom, the sidebar holds the
organization (a menu when you're in more than one), the destinations (*New task*, *Inbox* with how
many runs need you, *Tasks*, *Repositories*, *Metrics*), the **live runs**, and who's signed in, with
Settings and Sign out behind them. Runs are two lines each, title then next action, and the next
action is amber when it's your move. Only live runs in the inbox's first three groups are listed.
Finished runs live in the inbox, so the sidebar works as a switcher rather than a second copy of it.

A run page adds a third column: the evidence panel (`panel-width`, 400px). Under 1180px the panel
drops below the run's column. Settings replaces the sidebar with its own: *Back to the console*,
then *Personal* and the organization's sections.

Pages share one pattern. The title and a sentence under it come first. Next is a toolbar: the
page's views as pill tabs with counts on the left, filters, search and the one primary action on
the right. Then the content, as rows in one bordered card or as a grid of cards. A selected nav row
or tab is neutral (`color-bg-active`), because where you are isn't an action. Iris stays for what
you can do.

| Inbox group | States | Next-action line, e.g. |
|---|---|---|
| **Needs your decision** | `WAITING_FOR_APPROVAL`, `BLOCKED`, `HUMAN_EDITING` (ADR-0029) | *Approve the criteria before work starts* · *You're editing — submit or hand back* |
| **Ready to review** | `PR_READY`, `WAITING_FOR_HUMAN` | *Verified with warnings — review pull request #274* |
| **In progress** | `CLASSIFYING` … `PR_CREATING`, and `GET /v1/queue` | *Fixing what verification found* · *Queued — starts when a worker is free* |
| **Failed** (audit, 2026-10-17) | `FAILED`, `MAX_REPAIR_ATTEMPTS_REACHED` | *Failed — stopped while implementing* · *Stopped after the repair limit — see what still fails* |
| **Done** | `COMPLETED`, `CANCELLED` | *Done — verified with warnings* · *Cancelled* |

Failed runs get their own group, and their next-action line is drawn in the danger color. Their
mark stays the hollow *skipped* ring when there is no verdict (a mark never invents a verdict); the
group and the word say *failed*, so a failed run no longer reads like a cancelled one.

## Views

### Inbox (`/runs`)

Rows, not tables. Each row has the mark, a single-line title and the next-action line (amber when
it's your move), then the pull request number, the repository and the age. The rows sit in one card
with a header row per group, so the list narrows to a phone without cropping. The header says how
many runs need you. The pill views are *All*, *Needs you*, *In progress* and *Done*, each with its
count. *All* shows the groups in order, with only the newest ten finished runs, and *Done* shows
every finished run.

- Data: `GET /v1/runs`, `GET /v1/queue`, `GET /v1/repositories` (for names — `RunSummary` carries
  only `repositoryId`).
- Empty state: *Nothing here yet* with the one `control-lg` call to action, *Give Windkeel a task*.

### Session (`/runs/[id]`) — the core screen, as ADR-0029 shapes it

The audit (2026-10-17) found the run page one ~4-screen scroll, with the decision card covering
about a third of the viewport and the activity feed printing raw `state` and `cost` lines with
UUIDs. The session view replaces it with two panes:

- **Conversation** (left, `content-max`): a one-line **decision bar** (the decision card collapses to
  its *needs* line and primary button once scrolled; expanded at the top), the **activity** —
  turns of AgentSteps, with `state` transitions shown as stage headers and `cost` events folded
  into each turn's footer (*$0.12 · 3m*), IDs on hover only — and the **chat** pinned to the foot.
  The chat is the guidance composer with the same queued semantics: *Windkeel reads this when its
  current turn ends*.
- **Workspace** (right, resizable, tabs in the URL): **Changes** (DiffView; a turn's header links to
  its changes — the turn's candidate cut to the files its steps edited, and the tab says so, because
  the diff API can't split a candidate by turn), **Terminal** (the agent's commands and the tail of
  their output from `agent` events, read-only, with durations measured between Windkeel's reads of the
  agent's log), **Files** (read-only tree and file view between turns, `?path=`), **Criteria** (a
  checklist ticked from the newest verification's `intent` stage — Devin's *Tasks*, but against the
  criteria the run is judged by), **Evidence** (today's panel), **Progress** (the transition log as
  a scrubber). While `HUMAN_EDITING`, a **Workspace** tab says who is editing and whether the workspace is awake, and
  *Open workspace* opens the person's terminal, editor and preview in its own browser tab (Spike A:
  it can't be embedded).
- **Header**: title, state, repository, PR, and the run's snapshot — *Codex · gpt-5.x · checked by
  claude-…* — so what the run used is never a tab away.

Under 1180px the workspace becomes a tab strip above the conversation; under 760px the sidebar
becomes a drawer.

Watching never opens the maker VM: every maker-side tab reads the API (ADR-0029 §2). Only the human
workspace has a live terminal, behind a per-session capability token (§4).

### Run (`/runs/[id]`) — the core screen, as built

Disclosed in the order a reviewer needs it:

The run's own column is capped at `content-max`. The evidence panel sits to its right.

1. **Title** (24px) and one line of context: state mark, repository, pull request (linked), run id.
2. **Decision card**, pinned to the top while scrolling. It holds what Windkeel needs, why, the
   recommendation, what happens then, and the primary and secondary buttons. When nothing is
   needed it goes quiet (no raised shadow) and says what Windkeel is doing.
3. **Criteria**, open while approval is pending, with their provenance.
4. **What changed**: the newest candidate's patch as DiffView, one collapsible file each, with
   the totals and the candidate's SHA.
5. **Needs a look**: unfinished tests, unapproved generated criteria, an unsigned package, signals
   nothing has read, cost that is a lower bound or disagrees with its ledger. If there are none, it
   says *Nothing flagged*.
6. **Activity**: the stage rail, then the live feed, then any guidance you sent. The agent's steps
   are grouped into one collapsible block per turn, *Windkeel worked for 3m · 8 steps*, open while
   it's working. Inside it, a command's start and finish are one AgentStep, the step running now
   is cyan, and the agent's messages are Messages.
7. **Guidance composer**, pinned to the foot of the column, but only while a session listens
   (`IMPLEMENTING`, `VERIFYING`, `REPAIRING`). Otherwise that spot says why guidance is closed.

The **evidence panel** has the verdict of record as a badge in its header. Below it comes
**Verification**, outcome first: the verdict in words (*Verified*, *Verified with warnings*, *Failed
verification*, *Not verified yet*), one line of facts (criteria met, cycles, repairs, signed), then
each stage's outcome. Before verification starts, it says when it will run and lists no stages.
Pill tabs in the URL come next: *Verifications* (the default), *Repairs*, *Cost* and *Provenance*
(maker, checker, candidate, digest, signature).

**Stage outcomes** keep uncertainty explicit. Every outcome carries its word; the mark only backs
it up:

| Outcome | From | Mark |
|---|---|---|
| Passed | stage `passed` | pass |
| Passed with warnings | `warning` | warn |
| Found issues | `completed_with_findings`: findings, whose severity is the verdict's to say | warn |
| Failed | `failed` | fail |
| Not tested | `skipped` | skipped |
| Test unavailable | the report's `incompleteStages` (a tool didn't finish) — outranks the status | warn |
| Still running | no status, run is `VERIFYING` | running |
| Not run yet | no status, verification not reached | none |
| Not reported | no status after verification: sealed before stage results were recorded | none — never drawn like success |

**Decision by state** (`decisionFor`). The API decides what it accepts; the console only offers
what it won't refuse:

| State | Needs | Primary | Secondary |
|---|---|---|---|
| `WAITING_FOR_APPROVAL` | Approve the *n* criteria this run will be judged against | Approve criteria | Cancel run |
| `PR_READY` / `WAITING_FOR_HUMAN` | Review the pull request (— verified with warnings) | Open pull request; **Merge pull request** when eligible (ADR-0029 §5) | Make changes (ADR-0029) · Cancel run |
| `HUMAN_EDITING` (ADR-0029) | You're editing — submit or hand back | Submit for verification | Hand back to Windkeel · Cancel run |
| `BLOCKED` | Unblock this run | — | Cancel run |
| `FAILED` / `MAX_REPAIR_ATTEMPTS_REACHED` | Decide what's next | Run again (*Run again with…* opens the model picker) | Open pull request, if any |
| `IMPLEMENTING` / `VERIFYING` / `REPAIRING` | Nothing needed from you | Steer this run | Take over (ADR-0029; not while `VERIFYING`) · Cancel run |
| other live states | Nothing needed from you | — | Cancel run |
| `COMPLETED` / `CANCELLED` | Nothing needed | Open pull request / Run again | — |

Cancel sits behind a Dialog (*Stop this run?*), because it can't be undone. Approve doesn't: the
criteria are on screen, and reading them *is* the confirmation. **Merge** sits behind a Dialog that
names the verified SHA and, on `warn`, lists every *Needs a look* item for the person to tick; when
merging isn't allowed, the card says which rule doesn't hold (*Merging is off for this
organization*, *A commit landed after verification — verify again*, *You need the Merge
permission*, *The repository lets you bypass its protection, so Windkeel can't guarantee it applies…*)
instead of hiding the reason. The bypass is read with the person's token at merge time, so the dialog
says up front that Windkeel refuses to merge as someone who can bypass, and after such a refusal the card
names it beside the button.

**Browser tab (#392, ADR-0035).** The maker's own screenshots, under the heading *Maker screenshots —
not verification evidence*: thumbnail, the page's URL and title, and its console errors, all the
maker's text rendered as text. The feed shows each one as a thumbnail in its turn, captioned *Maker
screenshot · unverified*, and a failed browser install as one `browser` step. Images come through the
console's proxy (`/api/runs/[id]/screenshots/[sid]`) with the API's `image/png` + `nosniff` headers.
Nothing on this tab feeds the Evidence tab, which stays the verifier's.

### Verification (`/runs/[id]/evidence/[verificationId]`)

One package in full: overall verdict with `VERDICT_RULE` in words, each stage's evidence items
(status, summary, reason, producer command + exit code + duration in a Terminal, transcript),
findings grouped blocking / non-blocking, reviewer independence (different vendor? clean context?),
scanners with `killed` called out, and the download (the API's `302` to a presigned URL — a link,
never proxied). A `pruned` package says so and when; `never_produced` says why.

### Tasks, new task, task (`/tasks`, `/tasks/new`, `/tasks/[id]`)

- **List**: rows with the title, where the criteria came from, and how much Windkeel does on its own.
- **New task** is a guided composer, not a form:
  1. *What should Windkeel change?* — one large field; the hint says to write what should be true when
     it's done, because Windkeel checks against exactly that.
  2. Repository, and an optional related issue or pull request link. The API has no link field, so
     the link travels in the description, where the criteria extractor reads it.
  3. *More options*, collapsed: a name (the first line is used if blank) and **how much Windkeel does
     on its own** — *Routine* (up to 3 repairs), *Standard* (2), *Sensitive* (1). This is the
     task's risk level (ADR-0011 §1), named for what it does to the reader: how long Windkeel keeps
     fixing before it stops for them. It does not trade verification for cost; every level is
     verified the same way.
  4. *What happens next*, stated plainly: criteria are read from the ask; any Windkeel has to write
     itself come back for approval before code is touched.
  5. *(ADR-0029 §6)* Under the field, a toolbar like Devin's composer: **Agent** (the enabled
     harnesses) and **Model** (organization presets first, raw models under *More*), each defaulting
     to what the policy would choose and saying so; **Mode** — *Autonomous* or *Pair* (stop after the
     first turn so you look before verification). A maker that would leave no independent checker is
     disabled with the reason. These fill `POST /v1/tasks` `models`; nothing changes on a running run.
  *Give Windkeel the task* → `POST /v1/tasks`, which creates the task **and starts its first run**
  (`{ taskId, engineeringRunId }`); the console lands on that run.
- **Task**: criteria with their provenance — *from the issue* (the author's words) or *written by
  `<model>`, approved by `<person>` at `<time>`* (ADR-0012), and every run of the task.

### Repositories (`/repositories`, `/repositories/[id]`)

Cards in a grid: name, owner, default branch, open runs, with a search box (`?q=`). Detail lists the repository's runs and its **secret names**
(`GET /v1/repositories/{id}/secrets`): key, note, who set it, when. A value can't be read back by
anyone — the API is cryptographically unable to open one — so the page never implies it could. Setting
and removing stay on the CLI (`windkeel secret set|rm`) for now.

### Metrics (`/metrics`)

The ADR-0013 views as stat tiles and small tables. Nulls render *not measured*, never 0 — two views
were already fixed for flattering the system (#145, #181), and a dashboard that rounds a null to zero
would reintroduce it.

### Settings (`/settings`, `/settings/[section]`)

Settings is its own section with its own sidebar. The index is a card of rows, one per section,
each saying what's in it. *Personal*: **General** (`GET /v1/self`, `GET /v1/health`, theme as a
System / Light / Dark SegmentedControl) and **Your tokens**. The organization's sections come next:
**Members and invitations** and **Repository access**, and — for whoever may merge or administer —
**Merging** (#371): the organization's *Allow merging from Windkeel* toggle (admin) and *Connect GitHub
to merge* for the person, which runs GitHub's web flow (state + PKCE) through
`/api/github/user-authorization/start` and `…/callback`. A section you don't hold the permission
for isn't listed, and its URL is not found. Old `/settings?tab=…` links redirect.

## Flows

**1. Triage (the daily loop).** Open the inbox. The header says how many runs need you. Open the
first run under *Needs your decision* or *Ready to review*, act on its decision card, then go back.
If nothing is under those two groups, nothing needs you.

**2. Approve criteria.** The run enters `WAITING_FOR_APPROVAL` and appears under *Needs your
decision* as *Approve the criteria before work starts*. The run page leads with the decision card
(who wrote the criteria, and why a person signs off) and the criteria, open. *Approve criteria* →
`202`, and the feed shows `WAITING_FOR_APPROVAL → PROVISIONING`. If the window has expired, the API
answers `409` and the card shows the reason, offering *Run again*.

**3. Give Windkeel work.** `/tasks/new` → describe the change → *Give Windkeel the task* → you land on the
new run (the `202` carries its id), following from the run's cursor.

**4. Watch a run.** Activity streams over SSE. **Being cut is the normal case** (a Vercel function
caps at 300–800 s, runs take 10–60 min): the client reconnects with `after=<cursor>` on
`budget_exhausted` and stops on `run_terminal`. A small line in the feed header says *Live* or
*Reconnecting*; never a spinner over the whole feed.

**5. Steer.** *Steer this run* while `IMPLEMENTING` / `REPAIRING` / `VERIFYING`. Guidance is
**queued**, not delivered: the worker hands it to the agent as its next turn, after the current one
ends, within about a poll interval. The composer says so, and the list under it shows each message's
state from `GET /v1/runs/{id}/messages`: *delivered*, *queued*, *couldn't be delivered* (with the
adapter's reason) or *not delivered — the run ended first*.

**6. Decide whether to trust it.** Open a run under *Ready to review*. The card says *Verified* or
*Verified with warnings*. The verification section shows the outcome first; *Needs a look* lists
anything unsettled. Open the pull request from the card to review. From a `fail`, the *Repairs*
tab shows what each repair was asked to fix.

**7. Stop a run.** *Cancel run* → Dialog → `POST /cancel {reason}` → the feed shows the transition to
`CANCELLED`.

**8. Take over** *(ADR-0029 §3)*. *Take over* while `IMPLEMENTING` / `REPAIRING`. The chat says
*Windkeel will stop after this turn*; at the boundary the agent's work is committed, the run enters
`HUMAN_EDITING`, and the **Workspace** tab opens a terminal, editor and preview in a new sandbox
cloned from that commit. Install has already run, without repository secrets (ADR-0029 §3.4; the tab says private dependencies may be missing). Idle for 30 minutes, it sleeps
and wakes when you type.

**9. Submit or hand back** *(ADR-0029 §3)*. *Submit for verification* commits your changes as you,
and the run goes to `VERIFYING` in a fresh sandbox as any candidate does; the evidence names you
as the author of your commits (*mixed* when both of you wrote the candidate). *Hand back to Windkeel*
commits the same way and the agent resumes on your commit, told what changed. Your cycles don't
spend the repair budget.

**10. Make changes after review** *(ADR-0029)*. On a verified PR, *Make changes* opens the
workspace on the PR's head; submitting re-verifies and updates the same PR.

**11. Merge** *(ADR-0029 §5; built behind `WINDKEEL_MERGE=1`, #371)*. *Merge pull request* → Dialog
(verified SHA; on `warn`, tick each item; *Mark ready and merge* for a draft; the merge method) →
Windkeel merges with your GitHub token, on its side; GitHub's protection decides, and the card follows
the attempt (*Merging as you…*, then merged, refused with the reason, or failed). Before the first
time, Settings → Merging → *Connect GitHub to merge* asks GitHub to authorize Windkeel to act as you. The `pull_request.closed` webhook moves the run to
`COMPLETED`, exactly as a merge on GitHub does.

**12. Pick the agent and model** *(ADR-0029 §6)*. In the composer, or with *Run again with…*,
which starts on *Same models as this task* and otherwise runs on exactly what it shows — the
organization default included, sent as an explicit choice so the task's own can't reapply. The
session header shows what the run used: the checker verification picks (the first independent of
the maker), not merely the first listed.

## Where the API does not yet carry what a view needs

Found while mapping views to endpoints. Each is a ticket before its view can be more than a
placeholder.

| # | Gap | Blocks | Shape of a fix |
|---|---|---|---|
| **G1** | ~~The feed carries only `transition` and `cost`.~~ **Resolved:** worker events are stored in `agent_event` (migration 0022) and served on the feed as a third kind, `agent`, under the same cursor. | — | The run page folds them into turns of AgentSteps (`lib/agent-steps.ts`). |
| **G2** | ~~No endpoint for the candidate's diff.~~ **Resolved:** `GET /v1/runs/{id}/diff` serves the patch the maker stored beside the candidate. | — | *What changed* renders it as DiffView (`components/diff-view.tsx`). |
| **G3** | ~~Stage verdicts live inside the package.~~ **Resolved:** the verifier copies each evidence item's stage and status onto the row at seal time, and the report serves them as `verifications[].stages`. A verification sealed earlier has `null` and reads *not reported*. | — | The inbox's *n warnings* could now use them too. |
| **G4** | ~~`?status=` takes one state.~~ **Resolved:** it takes a comma-separated list, and the sidebar and inbox ask for the four *needs a person* states in one request. | — | — |
| **G5** | SSE is per run. The sidebar has no cheap way to see *other* runs change. | Live sidebar. | **Done:** `GET /v1/events?stream=sse` streams the organization's run changes; `components/live-lists.tsx` re-reads the page a moment after one (at most every 10 s for other runs, every 4 s for the open run's own transitions, per visible tab), with a 5-minute fallback poll (docs/control-plane-api.md, *Following an organization*). |
| **G6** | `RunSummary` has `repositoryId`, not owner/name; no issue number or PR URL. | Every run row. | Join client side from `/v1/repositories` now; add the fields to the summary. |
| **G7** | Auth is one bearer token; a browser must not hold it. | Everything. | The console calls `/v1` **from its server** (route handlers / server components) with `WINDKEEL_API_TOKEN`; the browser talks only to the console. Sign-in arrives with users (ADR-0001). |
| **G8** | ~~Verdict words disagreed: the package says `pass / warn / fail`, the design system's StatusDot said `incomplete` for `warn`.~~ **Resolved:** the design system now uses `warn`. | — | See *Design decisions* below. |
| **G9** | No endpoint to edit criteria. The API says "to change what a run is for, change the criteria" but offers no way to. | A *Revise criteria* action on approval. | Out of scope for the scaffold; criteria render read-only. |
| **G11** | ~~No take-over, hand-back or submit intents; no `HUMAN_EDITING` state (ADR-0029 §3).~~ **Resolved behind a flag (#369, `WINDKEEL_TAKEOVER=1`, default off):** `POST /v1/runs/{id}/takeover` (also *Make changes* on a verified PR), `/submit`, `/handback`, under `runs.takeover`; `HUMAN_EDITING` and its transitions; `human_session` (migration 0034); Pair mode on `POST /v1/tasks` `mode`; each candidate's author on the run read (`candidates`). Off, every one answers `409 takeover_disabled` and the console draws none of it (docs/control-plane-api.md, *Take over, hand back, submit*). | Flows 8–10. | *Take over* / *Make changes* / *Submit for verification* / *Hand back to Windkeel* in the decision card (`lib/decision.ts`, only when `takeover.enabled`); Pair in the composer when `GET /v1/self` `features.takeover`; candidate authors under Evidence → Provenance (`lib/takeover.ts`). Not for release until ADR-0029's flip conditions and the security audit. |
| **G12** | ~~No read of the maker workspace between turns.~~ **Resolved (#366):** `GET /v1/runs/{id}/workspace?path=` reads one directory level or one file, read-only, between turns (refused mid-turn, on a terminal run, and for paths or symlinks leaving the checkout; docs/control-plane-api.md, *Reading the maker workspace*). | — | The *Files* tab (`components/workspace-files.tsx`). |
| **G13** | ~~No human workspace or capability token.~~ **Resolved behind the same flag (#369):** `POST /v1/runs/{id}/workspace/session` mints the per-session token and answers `url` with it in the fragment (`no-store`); the run read's `takeover.session` says who is editing and whether the workspace is awake. | *Workspace* tab. | `components/human-workspace.tsx`: who is editing, *Sleeping — opens again when you type*, *Open workspace* in a **new tab** (never an iframe; the token only in the fragment, never stored), Submit and Hand back. |
| **G14** | ~~No merge.~~ **Resolved behind a flag (#371):** `GET /v1/runs/{id}/merge-eligibility` (each rule, true/false + why) and `POST /v1/runs/{id}/merge`, made on the stage side with the person's user-to-server token; `runs.merge` (Admin); `run_merge`; Settings → Merging. Every route is `404 merging_disabled` until `WINDKEEL_MERGE=1`, and nothing merges until an admin turns on *Allow merging from Windkeel*. | — | The decision card shows *Merge pull request* (or *Mark ready and merge*) only when eligible, and otherwise names the failing rule (`lib/merge.ts`). Not for release until ADR-0029's flip condition 2. |
| **G15** | ~~The console can't list harnesses and models to pick from, or presets.~~ **Resolved (#365):** `GET /v1/model-policy` carries `presets` and `harnesses`; presets are written under `/v1/model-policy/presets` (`models.manage`), refused when not independent; `POST /v1/runs` takes `models` for *Run again with…*. | Composer pickers. | The defaults the picker labels are the organization's rows; the operator's defaults beneath them aren't on the API, so a pairing against them is judged at intake, not in the form. |
| **G16** | The feed's `cost` events aren't tied to a turn. | Folding cost into turns. | Carry the turn (`agent_run` id) on `cost` events, or fold by time on the client. |
| **G10** | Suggested criteria can't be shown, or edited, *while filing* a task. `POST /v1/tasks` takes no criteria. Extraction and generation happen on the server after filing (ADR-0012), and nothing edits them (G9). | Inline criteria in the task composer. | A preview endpoint that runs extraction/generation on a draft, and `criteria` accepted on create. **This changes the approval gate's contract, so it needs a decision first.** |

### How the package's words are drawn

| Package / run | StatusDot | Word shown |
|---|---|---|
| run verdict `pass`, stage `passed` | `data-verdict="pass"` | pass |
| run verdict `warn`, stage `warning` / `completed_with_findings` | `data-verdict="warn"` | warn · *n findings* |
| run verdict `fail`, stage `failed` | `data-verdict="fail"` | fail |
| stage `skipped` | `data-verdict="skipped"` | skipped · *reason* |
| run live, stage not yet reported | `data-verdict="running"` | running |
| run accepted, not started | `data-run="queued"` | queued |
| run waiting on a person | `data-run="waiting"` | the state, e.g. *Waiting for approval* |

## Build order

1. **Scaffold** (this change): `apps/console` on Next.js, the design library imported whole, the shell,
   every route above as a page, a server-side API client, SSE following with cursor resume, and fixtures
   so each page renders without a factory behind it.
2. **Read-only console on real data**: Runs, Run (Activity from transitions + cost, Evidence, Attempts,
   Cost), Tasks, Repositories, Metrics, Settings.
3. **Commands**: approve, cancel, guidance, file task, start run.
4. **API gaps** G1 → G3 → G2 (in that order: G1 is the screen the product is), each unlocking its tab.
5. **Users and organizations** (ADR-0001), sign-in replacing the server-held token.
6. **Integrated assistant** (ADR-0029), in the phases of
   [docs/roadmap-integrated-assistant.md](../roadmap-integrated-assistant.md): the session view and
   readable activity first (no API change), then pickers, then take-over, then merge.

## Design decisions

Four questions the scaffold raised, decided 2026-09-24, then four more for ADR-0029 below. All four are two-way doors: they change
the design library and the console, not the evidence format or the API.

1. **`warn`, not `incomplete`.** The design system's own rule is that verdicts are the evidence
   package's words, used exactly, and the package says `warn`. `incomplete` was a mismatch, not a
   choice. The StatusDot value, the `color-verdict-warn` token and every guideline now say `warn`.
   The run report's `incompleteStages` keeps its name: it is a fact about stages that did not
   finish, shown as *did not finish* on a `warn` mark.
2. **Queued runs get their own mark:** a dashed gray ring, `data-run="queued"`. Cyan would claim the
   agent is on it, and hollow gray already means *skipped*.
3. **"Needs you" gets its own mark:** an amber ring with a center dot, `data-run="waiting"`. It stays
   amber, matching the dashed-amber approval step, but its shape is distinct from the filled amber
   `warn` verdict. The design system tells verdicts apart by shape as well as color, and this
   follows that rule. Run marks sit on `data-run`, not `data-verdict`, because the StatusDot rule is
   that verdicts are never invented: these say where a run is, not what evidence found.
4. **Tabs that live in the URL are links.** A run's `?tab=` survives reload and can be shared. The
   Tabs guidelines gain that variant: `nav.oq-tabs` with `a.oq-tab[aria-current="page"]`, no
   `role="tab"`, identical look.

### For ADR-0029, proposed 2026-10-17

5. **A person's work gets no new color.** Cyan is *what the agent is doing right now*; a person in
   the human workspace is drawn with their avatar and name, in the neutral text colors. Commits in
   *Changes* and authors in *Provenance* say *Windkeel (Codex · model)*, *you* or *mixed*. Adding a
   fifth hue for people would blur the rule that color is a job, not decoration.
6. **`HUMAN_EDITING` wears the *needs you* mark** (amber ring with a center dot): it is waiting on a
   person, who happens to be you. Its next-action line is *You're editing — submit or hand back*.
7. **A sleeping workspace says so** — *Sleeping — opens again when you type* — and is never drawn as
   failed or stopped. Waking shows the *Reconnecting…* line the feed already uses, not a spinner
   over the editor.
8. **The decision card collapses, it doesn't stack.** Once scrolled, the card is one line (needs +
   primary button) and nothing else is sticky above the conversation, fixing the overlap the audit
   found where the card and the evidence header both pinned.

## Sign-in, tokens and organizations (ADR-0024)

Built against the API contract agreed with the ADR-0024 work on branch `adr/orgs-and-users`
(2026-09-24). Tokens are **personal only for now**; organization tokens come later.

- **Sign-up is sign-in.** *Continue with GitHub* on `/login`. A GitHub sign-in grants nothing on
  its own; an organization's invitation, matched on first sign-in, is what makes someone a member.
  Everyone else gets `/not-a-member`, which never creates an account.
- **The console acts as the person.** With Supabase configured, every `/v1` call carries the
  signed-in session's token, from the console's server. Signed out, it's a redirect to `/login`,
  never a quiet fall back to the operator token.
- **`/login/device`** approves `windkeel login`. It shows the code large, names the machine, lists
  what the token will be able to do, and warns in large type for `--admin`. The API accepts approval
  only from a session (`session_required` for a token).
- **Tokens** are created from presets (Read, Execute by default, Approve, Admin) or a custom list.
  Only the presets the person's role covers are offered: a token is the role ∩ its scope, so a wider
  preset would only look wider. The value is shown once, in a Dialog.
- **Settings sections** appear only with their permission: *Members and invitations*
  (`members.manage`), *Repository access* (`repositories.manage`).
- **Organizations.** The switcher appears in the sidebar when there is more than one. Work routes are
  sent as `/v1/orgs/{orgId}/…`. An `organization_required` answer is retried in the first
  organization the API names, so a person in several organizations still gets a page.

