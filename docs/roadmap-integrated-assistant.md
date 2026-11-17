# Integrated assistant — the phased plan

Written 2026-10-17. The decision is
[ADR-0029](adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)
(Proposed); the target console is in [ui/console-ux.md](ui/console-ux.md) (sections marked
*ADR-0029*); the milestone row is in [research/MILESTONES.md](../research/MILESTONES.md).

## Where this comes from

A UX audit on 2026-10-17 compared the console with Devin (app.devin.ai), live in both products.
The console's shell is already close to Devin's: a sidebar with *New task*, ⌘K, a live run list
grouped by what needs you, and queued steering. The gaps were the run page and three capabilities
Windkeel had refused. Findings that shape the phases:

| Finding | Devin | Windkeel today | Phase |
|---|---|---|---|
| The run page is one ~4-screen scroll; the decision card covers ~30% of the viewport and overlaps the content under it | Chat beside a tabbed workspace | Single column, two stacked sticky headers | 1 |
| The activity feed prints raw `state …` and `cost $0.00 sandbox · workspace` lines with UUIDs | *Worked for 5s* groups, a *Tasks* checklist | Turns are folded; transitions and cost are not | 1 |
| Failed runs look like cancelled ones (same gray ring, inside *Done*) | Red for failing; *Blocked* group | One *Done* group | 1 |
| ⌘K only navigates | Opens on *Start session with a prompt…*, lists actions | Navigation only | 1 |
| A 21-day-old run waiting for review says *Live* | *Waiting* / *Sleeping* states | *Live* whenever the stream is open | 1 |
| No agent or model choice in the UI | Capability picker in the composer | API and CLI only | 2 |
| Can't see the agent's files or terminal | Files, Shell, Terminal tabs | Diff only | 3 |
| Can't step in | Take over the machine | Queued guidance only | 4 |
| Can't merge | Merge from the review page | Refused by design (ADR-0009) | 5 |

Already fixed on branch `ux/devin-audit-quick-wins` (phase 0): the evidence page renders G3 stage
results instead of a stale *API gap* banner and links back to `#evidence`; *1 model calls* reads
correctly; a `FAILED` run's recommendation no longer points at failures that aren't listed.

## Rules every phase keeps

- Every candidate — the agent's, the person's, or both — reaches the PR only through an independent
  verification in a fresh sandbox (ADR-0004). No phase adds a way around it.
- The console never computes a verdict; every run leads with a decision.
- A run never changes model or harness mid-run (ADR-0011 §2, ADR-0026 §4, ADR-0027 §2).
- Nothing runs a listener in a maker or verifier sandbox.
- Each phase is one pull request into an integration branch, reviewed and merged by the tech lead.

## Phase 1 — Session view and readable activity (console only)

No API change. Ships the biggest visible difference on its own.

1. **Split pane.** `/runs/[id]` becomes conversation (decision bar, activity, chat) beside
   workspace tabs in the URL: *Changes*, *Criteria*, *Evidence*, *Progress*. Under 1180px the tabs
   move above the conversation; under 760px the sidebar is a drawer.
2. **Decision bar.** The card collapses to one line (needs + primary) once scrolled; nothing else
   pins above the conversation.
3. **Readable activity.** Transitions become stage headers; `cost` events fold into the turn's footer
   (by time until G16 carries the turn); IDs on hover. The *Live* line says *Waiting on you* when
   the run is parked on a person.
4. **Criteria tab.** The criteria as a checklist, ticked from the newest verification's `intent`
   stage; *not checked yet* before verification.
5. **Progress tab.** The transition log as a scrubber over time.
6. **Inbox.** A *Failed* group between *Ready to review* and *Done*, its next-action line in the
   danger color; the mark rule (no verdict → *skipped*) unchanged.
7. **⌘K actions.** *New task*, and on a run page *Approve criteria*, *Run again*, *Cancel run*
   (Cancel still behind its Dialog).
8. **Home.** `/` renders the composer above what needs you, instead of redirecting to `/runs`.

Done when: a run's decision, newest activity and diff are visible in one viewport at 1440×900; no
UUID appears in the feed without hovering; a failed run is never listed under *Done*; `decision.test.ts`
and the existing tests pass; screenshots before/after in the PR.

## Phase 2 — The composer picks agent, model and mode

1. **Model picker** in *New task*, filling `POST /v1/tasks` `models { maker, checker }`. Defaults
   come from `GET /v1/model-policy` and say *(organization default)*. A maker that would leave no
   independent checker is disabled with `NoIndependentProviderError`'s reason.
2. **Presets.** Settings → Models gains named presets (harness + maker + checker) that an admin
   defines; the picker shows them first, raw models under *More*. Windkeel ships no tier names.
3. **Agent picker** (harness) appears only once ADR-0027 is accepted and a second harness is enabled.
4. **Mode**: *Autonomous* only in this phase (Pair arrives with phase 4).
5. **Run again with…** opens the picker and starts a new run of the same task.
6. **Session header** shows the run's frozen snapshot.

API: G15 (presets and enabled harnesses on `/v1/model-policy`). Depends on M9's code (on `main`);
ADR-0026 is still *Proposed* until the live spike #318.

## Phase 3 — A read-only view of the maker workspace

1. **Files tab**: tree and file view of the maker workspace, read between turns (G12, `getFiles`).
2. **Terminal tab**: the agent's commands and output from `agent` events, read-only, with durations.
3. **Changes per turn**: the diff scoped to a turn from its header, like Devin's worklog.

No port, PTY or server in the maker sandbox.

## Phase 4 — Take over, hand back, submit

Starts with two spikes, which are also ADR-0029's conditions for *Accepted*:

- **Spike A — human workspace.** A Vercel Sandbox cloned from a candidate through git, running a
  terminal/editor server gated by a per-session capability token; usable from the console from
  `iad1`. Measure latency, cold start, wake from sleep, cost per hour.
- **Spike B — sweep then push.** In the human workspace, stop the person's processes and commit as
  their GitHub identity. Done (#373): a person has root in the VM, so the commit leaves as a git
  bundle and the API host pushes it; no token enters the workspace (ADR-0029 §3.6). Needs one live
  run and the security audit.

Then:

1. `HUMAN_EDITING` state and transitions (ADR-0003 amended); migration; `human_session` table;
   `human_cycles` and `human_cycles_cap` on the run.
2. Intents `takeover`, `submit`, `handback`, `workspace/session` (G11, G13), permission
   `runs.takeover`.
3. Push path: the commit leaves the workspace as a git bundle; the API host checks it, pushes with
   a just-in-time token and revokes it at once (ADR-0029 §3.6).
4. Human workspace provisioning: clone through git, install without repository secrets, open with
   the install allowlist; sleep after 30 idle minutes; delete on exit or at 24 h.
5. Provenance: each candidate commit's author (maker or person) in the package's author provenance;
   *mixed* in the console.
6. Console: *Take over*, the *Workspace* tab, *Submit for verification*, *Hand back to Windkeel*,
   *Make changes* on a verified PR, Pair mode in the composer.
7. Security audit of the token gate and the push path before release.

## Phase 5 — Merge as the person

**Built behind a flag (#371):** every item below exists, off unless the deployment sets
`WINDKEEL_MERGE=1` and an organization admin turns on *Allow merging from Windkeel*. Not for release until
ADR-0029's flip condition 2 (a live run of Spike C's harness). `runs.merge` is Admin-only: Windkeel has
no per-organization role customization yet, so "grantable to Member" waits for it.

Starts with **Spike C**: a GitHub App user-to-server token merges a draft PR under branch
protection, attributed to the person; what happens when the PR touches `.github/workflows/*`.

Then:

1. GitHub user authorization flow in the console (one-time, per person), tokens sealed like model
   credentials.
2. Permission `runs.merge` (Admin; grantable to Member) and the organization setting *Allow merging
   from Windkeel* (off by default).
3. `GET /merge-eligibility` (each rule with its reason) and `POST /merge` (G14); `run_merge` row.
4. Merge Dialog: verified SHA; on `warn`, each *Needs a look* item ticked; *Mark ready and merge*
   for drafts. The card names the failing rule when merging isn't possible.
5. `decision.test.ts`: still never *merge-ready*; *Verified — review and merge* when eligible.

## Not planned

An Ask mode or codebase wiki, merging without a verdict of record, agent tiers named by Windkeel,
switching model mid-run, and attaching a person to the maker VM — see ADR-0029 *Consequences*.

## Issues to file

Not filed yet. One per phase, plus the three spikes:

1. *Console: session view, readable activity, Failed group, ⌘K actions, home composer* (phase 1)
2. *Console + API: agent/model/mode pickers and model presets* (phase 2, G15)
3. *Console + API: read-only maker workspace — Files, Terminal, per-turn changes* (phase 3, G12)
4. *Spike A: human workspace with a token-gated terminal/editor in Vercel Sandbox*
5. *Spike B: sweep-then-push as the person from a human workspace*
6. *Take over, hand back and submit* (phase 4, G11, G13)
7. *Spike C: merge with a GitHub App user-to-server token under branch protection*
8. *Merge as the person* (phase 5, G14)
