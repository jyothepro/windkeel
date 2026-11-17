# ADR-0029: Windkeel is an integrated coding assistant — a cloud workspace you can take over, merge as you, and a model picker — and the independent verifier stays the gate

- Status: Proposed
- Date: 2026-10-17

## Context

The goal, in the user's words: *"treat this as an integrated coding assistant"*, running in the cloud.

## Decision

**Windkeel becomes a cloud coding assistant you work alongside — watch the agent live, take over in a workspace of your own, hand back, pick the agent and model per task, and merge from the console as yourself — while every candidate, whoever wrote it, still reaches the pull request only through an independent verification in a fresh sandbox.** The positioning moves from *an inbox for engineering decisions* to *a coding assistant whose every change is independently verified*; "make agent work easy to trust" stays the differentiator.

- §1 — The run is the session.
- §2 — Watching the agent is read-only, and never opens the maker VM.
- §3 — Taking over: a human workspace, seeded through git.
- §4 — Terminal, editor and preview: a server in the human workspace, behind a capability token.
- §5 — Merge, as the person, only what was verified.
- §6 — The model picker chooses the task's snapshot, never a running one.
- §7 — What does not change.

## Consequences

- The console's information architecture changes: the run page becomes a session view (split pane), the composer becomes the home page's primary surface, and Settings gains merge and model presets.
- New API surface, all intents or reads under ADR-0023's shape: `POST /runs/{id}/takeover`, `POST /runs/{id}/handback`, `POST /runs/{id}/submit`, `GET /runs/{id}/workspace` (tree and file reads), `POST /runs/{id}/workspace/session` (mints the capability token), `POST /runs/{id}/merge`, `GET /runs/{id}/merge-eligibility`, and model presets under `/v1/model-policy`.
- New permissions: `runs.takeover` (Admin and Member) and `runs.merge` (Admin; grantable).
- New rows: `human_session`, `run_merge`; `engineering_run.human_cycles` and `human_cycles_cap`.

**Later changes** (full text in Background):

- What flips this to Accepted
- Open questions

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Proposed
- Date: 2026-10-17
- Milestone: Integrated assistant (unnumbered until sequenced; see `research/MILESTONES.md`)
- Amends: [ADR-0003](0003-factory-domain-model-and-run-state-machine.md) (one state, its
  transitions, a second cycle), [ADR-0009](0009-github-app-scope-for-milestone-6.md) §5,
  [ADR-0011](0011-repair-loop-policy-and-run-safety-rails.md) §2,
  [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §3,
  [ADR-0017](0017-the-maker-outlives-verification-while-the-repair-loop-has-budget.md),
  [ADR-0023](0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md) §1, §4,
  [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
  (two permissions), and the console's first rule (`docs/ui/console-ux.md`)
- Leaves unchanged: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) (the gate),
  [ADR-0026](0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md) §4–§5 and
  [ADR-0027](0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md) §2 (frozen per run)
- Arises from: the Devin UI/UX audit of 2026-10-17

### Context

The goal, in the user's words: *"treat this as an integrated coding assistant"*, running in the
cloud. A UX audit against Devin (app.devin.ai, 2026-10-17) found the console's shell already close
to it, with three things Windkeel deliberately refused:

1. **An interactive workspace.** Devin's session is a chat beside a live workspace (Shell, Files,
   Changes, Tasks, Progress, Browser), and a person can stop the agent and work in the same
   machine. Windkeel shows a run's activity feed and diff, and lets a person *steer* with queued
   guidance (ADR-0023 §8), but never lets them in.
2. **Merging.** Devin merges from its review page. Windkeel's GitHub App "never marks ready,
   approves, or merges" (ADR-0009 §5), the API has no such endpoint (ADR-0023 §4), and the console
   "is not a second GitHub" (console-ux.md, rule 1).
3. **A model picker.** Devin's composer picks a capability tier (Lite / Normal / Ultra / Fusion /
   named models) per session. Windkeel's API already takes a task-level `models` override (ADR-0026
   §4) and the CLI exposes it; the console does not.

The user chose all three, kept the independent verifier as the gate, and asked for docs and a
phased plan before code. What makes this more than a UI change is that each of the three touches
an invariant Windkeel was built on:

- **The maker is assumed hostile** (ADR-0014): "assume the maker is fully compromised, and the
  candidate tree and the maker's `.git/` are hostile". Its VM has passwordless `sudo`, repository
  secrets exist in it during install, and the capture sweep `SIGKILL`s every process of the default
  user before the push token is minted. A person typing into that VM would be working in a hostile
  environment, could read the just-in-time token, and would be killed by the sweep.
- **The verifier trusts one thing from the maker: the candidate commits** (ADR-0004). Anything a
  person adds must reach it the same way.
- **Turns can't overlap** (ADR-0023 §8): two writers in one workspace is a corrupted attempt, and
  there is no mid-turn interrupt (`windkeel say --now` was declined).
- **A run never changes model or harness** (ADR-0011 §2, ADR-0026 §4, ADR-0027 §2), and
  independence is checked once, at intake, on the frozen snapshot.
- **Nothing in a Vercel function holds a socket** past 300–800 s (ADR-0020, ADR-0023). A live
  terminal can't be proxied through the console.
- **Vercel Sandbox ports are public URLs with no auth** (research/vercel-sandbox/findings.md;
  ADR-0014 §3 treats every exposed port as internet-reachable).
- **The GitHub App already holds Contents and Pull requests R/W** (ADR-0009). Merge is blocked by
  policy and by the client having no method, not by a missing grant.

### Decision

**Windkeel becomes a cloud coding assistant you work alongside — watch the agent live, take over in a
workspace of your own, hand back, pick the agent and model per task, and merge from the console as
yourself — while every candidate, whoever wrote it, still reaches the pull request only through
an independent verification in a fresh sandbox.** The positioning moves from *an inbox for
engineering decisions* to *a coding assistant whose every change is independently verified*;
"make agent work easy to trust" stays the differentiator.

#### 1. The run is the session

No new top-level entity. A run already has a conversation (guidance, agent messages, the
`agent_event` feed), a workspace (the maker sandbox) and outcomes. The console presents a run as a
**session**: conversation on the left, workspace tabs on the right. *Steer* becomes the session's
chat; its delivery semantics are unchanged — a message is queued and handed to the agent at the
next turn boundary (ADR-0023 §8), and the chat says so.

Two **session modes**, chosen in the composer and stored on the task as the existing risk level is:

- **Autonomous** (today's behaviour): Windkeel implements, verifies, repairs, and brings back a PR.
- **Pair**: Windkeel stops after its first implementing turn, before verification, and enters
  `HUMAN_EDITING` (§3) with the agent's work captured, so the person looks before anything is
  verified. Everything after is the same.

Mode never changes verification: every mode is verified the same way, as risk level already
promises (console-ux.md).

#### 2. Watching the agent is read-only, and never opens the maker VM

The workspace tabs over a **maker** sandbox show what Windkeel already records, through the API,
never through a port on the maker:

| Tab | Source |
|---|---|
| **Activity** (in the conversation) | the run feed (`transition`, `cost`, `agent`), folded into turns |
| **Terminal** | the agent's commands and output from `agent` events, read-only |
| **Changes** | `GET /v1/runs/{id}/diff`, refreshed per turn |
| **Files** | a new read-only tree and file read over the maker workspace (`getFiles`), between turns |
| **Criteria** | the criteria as a checklist, ticked from the newest verification's `intent` stage |
| **Evidence** | today's evidence panel |
| **Progress** | the transition log as a scrubber |

No exposed port, PTY or editor server ever runs in a maker sandbox. ADR-0027 §5's rejection of
`opencode serve` and `codex app-server` stands.

#### 3. Taking over: a human workspace, seeded through git

*Take over* is a run intent. It never interrupts a turn:

1. The agent finishes its current turn (or, with *Take over now*, the run is held and the turn is
   captured by the capture path in ADR-0023 *§1, for reap and capture*).
2. The maker's work is committed as a candidate exactly as today, through the capture sweep and
   the scoped push (ADR-0014). The maker sandbox is held, not destroyed (amends ADR-0017: held
   while the run is in `HUMAN_EDITING`, under the same spend cap).
3. A **human workspace** is created: a new sandbox that clones the repository at `base_sha` and
   fetches the candidate, through git, as the verifier's does (ADR-0004). Nothing is forked,
   snapshot-restored or copied from the maker.
4. The install command runs **without repository secrets**. ADR-0014 treats the candidate tree as
   hostile and records that an install path it controls (a Python build backend, a lifecycle script)
   can run while secrets are present; in the maker that residual is bounded because nobody reads the
   VM afterwards, but here the person gets root in it next, so anything the install stashed would be
   readable. A repository whose install needs a secret (a private registry) gets a workspace without
   those dependencies installed, and the console says so; the person can install with their own
   credentials. The person gets the workspace only after the install. (Amended after review of #363.)
5. The person works in a terminal, an editor and a browser preview (§4). Network policy in the
   human workspace is the **install allowlist**, not the execution phase's model-domain-only policy:
   the person is a trusted principal, and the agent is not running in this VM. No model key, push
   token or checker credential is ever in it.
6. **Submit for verification** stops the person's processes, commits their changes as one new
   candidate with low-level git (`commit-tree`, the seed candidate as parent, no hooks), authored by
   the person's GitHub identity (never `WINDKEEL_GIT_AUTHOR_EMAIL`, so ADR-0013's
   `human_commits_after_pr` reads them as human), and reads it out as a **git bundle**. **No push
   token ever enters the human workspace:** the API host verifies the bundle (one commit, parent is
   the seed candidate, nothing else), pushes it with a just-in-time scoped token, and revokes the
   token (`DELETE /installation/token`) as soon as the push returns. The push lands only if the
   branch still holds the seed candidate. The run moves to `VERIFYING`. Uncommitted editor state
   never reaches the verifier. (Amended after Spike B, #368: the person has root in the VM, and a
   lasting root change — a replaced `git`, `/etc/ld.so.preload`, an `/etc/hosts` entry with a
   trusted CA — would take a token pushed from inside it; a process sweep can't see those.)
7. **Hand back to Windkeel** commits and pushes the same way, and the maker sandbox fetches the
   person's commit and resumes with a turn that says what changed (`IMPLEMENTING`).

The **state machine** gains one non-terminal state and its transitions (amends ADR-0003):

| From | To | When |
|---|---|---|
| `IMPLEMENTING`, `REPAIRING` | `HUMAN_EDITING` | *Take over*, at a turn boundary; or Pair mode after the first turn |
| `WAITING_FOR_HUMAN` | `HUMAN_EDITING` | *Make changes* on a verified PR |
| `HUMAN_EDITING` | `VERIFYING` | *Submit for verification* |
| `HUMAN_EDITING` | `IMPLEMENTING` | *Hand back to Windkeel* |
| `HUMAN_EDITING` | `BLOCKED`, `CANCELLED` | as any non-terminal state |

`WAITING_FOR_HUMAN → HUMAN_EDITING → VERIFYING → PR_CREATING` is a second cycle beside
`VERIFYING → REPAIRING → VERIFYING`. On a run that already has a pull request, `PR_CREATING`
pushes the new verified candidate to the same branch and the run returns to `PR_READY`.

**Rails** (amends ADR-0011 §2). A person's verification cycles don't spend the repair budget; they
are capped separately (`human_cycles_cap`, default 10) and by the run's spend cap. `HUMAN_EDITING`
is a parking state for the wall-clock cap, but its sandbox time is charged as it accrues. The human
workspace sleeps after 30 idle minutes (Vercel Sandbox persistence: stop snapshots, the next call
resumes) and is deleted when the run leaves `HUMAN_EDITING`, or after 24 h, whichever is first;
the console says *Sleeping — opens again when you type*.

**Provenance.** `AgentRun.role` stays agent-only. A new `human_session` row (run, principal,
started/ended, sandbox, commits) is the actor record ADR-0024 §9's pattern asks for. The package's
author provenance names each candidate commit's author: maker (harness, model) or person
(principal, GitHub login). A candidate with both is *mixed*, and the console says so. The
verifier's independence check is unchanged: it is about the checker's vendor against the maker's,
and a person is neither.

#### 4. Terminal, editor and preview: a server in the human workspace, behind a capability token

A live PTY can't be held by a Vercel function, and Vercel Sandbox ports have no auth. The human
workspace therefore runs its own terminal/editor server (an OpenVSCode-class server and a PTY over
WebSocket) on an exposed port, and **the server itself** refuses any request without a per-session
capability token: 256 random bits, minted by the API for one principal and one human session,
scoped to that sandbox, expiring with the session and revoked on hand-back, submit or cancel. The
console opens the workspace with the token; it is never logged, never put in a URL query that
reaches a proxy log (it travels in a fragment and is exchanged for a cookie on the sandbox's own
origin), and never stored after the session.

What Spike A (#367) settled, before a live run:

- The token is minted outside the VM; the server holds only its SHA-256. It is **single-use**: the
  bootstrap page reads it from the fragment, strips it from the URL, and exchanges it by a
  same-origin POST for a separate `__Host-` session cookie (HttpOnly, Secure, SameSite=Strict).
  Origin is enforced on every POST and WebSocket upgrade. Four routes answer without a session —
  the bootstrap page, its script, the exchange and revoke — and each is static or authenticates
  itself. `vercel.run` is on the Public Suffix List, so another sandbox can't share the cookie.
- The editor's own connection token travels as `?tkn=`, which this section forbids, so the editor
  binds to loopback with its auth off and is reached only through the gate.
- The workspace **opens in its own tab**, never an iframe in the console: `frame-ancestors 'none'`,
  Strict cookies and third-party cookie blocking all rule embedding out.
- Processes don't survive a sleep; every wake restarts the server with a freshly minted token,
  which is also a free revocation.
- The person has root in the VM and can read the server's sessions or take its port. That is their
  own session; it is why no push token or other credential is ever placed in the VM (§3.6).
- Bar for flip condition 1: keystroke echo p50 ≤ 100 ms, p95 ≤ 200 ms from the person's region,
  and Vercel's port proxy carrying WebSocket upgrades with an idle timeout the terminal can live
  with. If it doesn't, this section reopens (the SDK's `openInteractive()` is the first fallback to
  measure).

A preview of the person's running app uses the same token gate. Exposed ports exist only in human
workspaces, never in maker or verifier sandboxes (ADR-0014 §3 amended to say so).

Creating the human workspace needs `VERCEL_TOKEN` in the API, a third bend of ADR-0023 §1 after
reap and capture, justified the same way: there is one deployment (ADR-0020), and the alternative —
a separate always-on relay — buys isolation this topology doesn't have. Not chosen: an always-on
relay service holding PTY sockets (a second deployment, and a host for the same secrets);
attaching to the maker VM (§3's reasons).

#### 5. Merge, as the person, only what was verified

The console gains **Merge pull request**, under these rules (amends ADR-0009 §5, ADR-0023 §4, and
the console's rule 1):

1. **The App still never merges.** `GitHubClient` keeps no merge, approve or ready-for-review
   method. The merge is made with the **signed-in person's GitHub user token** (a GitHub App
   user-to-server token, obtained when the person authorizes merging), so GitHub's branch
   protection, required reviews, required checks and the person's own repository permission all
   apply, and GitHub attributes the merge to them. A person's token does not stop GitHub from
   letting an admin or a ruleset bypass actor skip protection, and the merge API has no flag that
   refuses a bypass (Spike C, #370). A check of `mergeStateStatus` before the `PUT` is not enough on
   its own for someone who *can* bypass: a review can be dismissed or a check fail between the read
   and the merge without moving the head SHA, and GitHub would then merge on their bypass. So Windkeel
   **refuses to merge as anyone GitHub reports can bypass** (`viewerCanMergeAsAdmin`, or a ruleset
   bypass actor): the repository must enforce its protection for admins ("Do not allow bypassing the
   above settings", or an empty ruleset bypass list) before such a person can merge from Windkeel, and
   the card says so. For everyone else it also requires GitHub to report the PR mergeable
   (`mergeStateStatus` `CLEAN`, `HAS_HOOKS` or `UNSTABLE`), refuses `BLOCKED`, checks again after
   marking a draft ready, and never offers an admin override. (Amended after review of #372.)
2. **Only the verified candidate.** The API refuses when the PR's head SHA is not the candidate of
   the verdict of record (a push after verification makes the verdict stale; ADR-0014,
   *PR_CREATING pins the branch to the verified SHA*), when
   there is no verdict of record, or when it is `fail`.
3. **`warn` needs an acknowledgement.** On `warn`, the merge dialog lists what *Needs a look* lists,
   and the person confirms each; the acknowledgement is recorded with the merge.
4. **Draft PRs stay draft until a person says otherwise.** *Mark ready and merge* does both with the
   person's token, in that order.
5. **Who may.** A new permission, `runs.merge` (ADR-0024), held by Admin by default; an organization
   can grant it to Member. Merging is also off per organization until an admin turns on *Allow
   merging from Windkeel*. The GitHub collaborator check (`admin|maintain|write`) applies through the
   person's token. The token's GitHub user must be the signed-in person's linked GitHub account;
   the Supabase sign-in token is not this token and is never used for it.
6. **What's recorded.** A `run_merge` row: principal, PR, merged SHA, verdict of record and its
   digest, acknowledgements. The `pull_request.closed` webhook still drives the run to `COMPLETED`
   (ADR-0009), so a merge on GitHub and a merge from Windkeel end the same way.
7. **Words.** The console still never calls a change *merge-ready*. The card says *Verified —
   review and merge*, and the button appears only when rules 1–5 hold; otherwise the card says which
   one doesn't.
8. **Workflow files are merged on GitHub.** A PR that touches `.github/workflows/*` is refused with
   *Merge this one on GitHub*: a GitHub App user token has no OAuth scopes, and merging it would need
   the App's *Workflows* permission, which this decision does not add (Spike C).

Rule 1 of the console becomes: **The console merges only as you, and only what was verified.**

#### 6. The model picker chooses the task's snapshot, never a running one

The composer gains an **Agent** picker (harness, ADR-0027) and a **Model** picker under it, plus the
session mode (§1) and the existing *how much Windkeel does on its own*. They fill the existing task
override layer (`POST /v1/tasks` `models { maker, checker }`, ADR-0026 §4), resolved into the run's
frozen snapshot at intake as today. So:

- **No switch mid-run.** ADR-0011 §2, ADR-0026 §4 and ADR-0027 §2 stand. *Hand back to Windkeel*
  resumes on the same snapshot.
- **Changing the model is a new run.** *Run again with…* opens the picker and starts a new run of
  the same task (ADR-0003: recovery is a new run).
- **Independence is shown before filing.** The picker reads `GET /v1/model-policy` (`models.read`)
  and disables a maker that would leave no independent checker, with the reason
  (`NoIndependentProviderError`'s words), so the run doesn't fail at intake for a choice the form
  allowed.
- **Names are the organization's, not ours.** Settings → Models may define named presets
  (e.g. *Fast*, *Thorough*) mapping to harness + model; the picker shows presets first and the raw
  choice under *More*. Windkeel ships no tier names of its own, so the picker doesn't churn with
  model releases.
- **The run says what it used.** The session header shows the snapshot (harness, maker model,
  checker model, key source), as the run's Models panel does today.

#### 7. What does not change

- **ADR-0004.** Every candidate reaches the verifier through git and is verified in a fresh
  sandbox, whoever wrote it.
- **The console never computes a verdict** (rule 2) and **every run leads with a decision** (rule 3).
- **Steering changes how, never what** (ADR-0023 §8). A person in the human workspace may change
  anything, but the run is still judged against its approved criteria; changing *what* is still new
  criteria and the approval gate.
- **Verification can't be skipped or weakened** by any mode, preset or permission.

### Consequences

- The console's information architecture changes: the run page becomes a session view (split
  pane), the composer becomes the home page's primary surface, and Settings gains merge and model
  presets. `docs/ui/console-ux.md` is rewritten to match.
- New API surface, all intents or reads under ADR-0023's shape: `POST /runs/{id}/takeover`,
  `POST /runs/{id}/handback`, `POST /runs/{id}/submit`, `GET /runs/{id}/workspace` (tree and
  file reads), `POST /runs/{id}/workspace/session` (mints the capability token),
  `POST /runs/{id}/merge`, `GET /runs/{id}/merge-eligibility`, and model presets under
  `/v1/model-policy`. `docs/control-plane-api.md` lists them as planned.
- New permissions: `runs.takeover` (Admin and Member) and `runs.merge` (Admin; grantable).
- New rows: `human_session`, `run_merge`; `engineering_run.human_cycles` and `human_cycles_cap`.
- The GitHub App gains a user-authorization flow (user-to-server tokens) for merging; its installed
  permissions don't change. User tokens last 8 hours and refresh tokens 6 months (single use); they
  are sealed like model credentials and refreshed under a row lock only when a merge needs one. A PR
  that touches `.github/workflows/*` is merged on GitHub (§5.8). Because `windkeel[bot]` opens the PR,
  the person merging can be its only required approver; organizations that want two people should
  require a review from someone other than the merger in GitHub.
- Cost: a human workspace is a second sandbox per taken-over run, charged to the run. Sleep after
  idle and deletion on exit bound it; the spend cap still stops the run.
- The capability-token server is new attack surface on a public URL. It is the only listener in
  the human workspace, binds the token to one session, and is covered by the security audit before
  the milestone ships.
- Devin-parity items not taken: an Ask mode and codebase wiki, merging without verification, agent
  tiers named by Windkeel, mid-run model switches, and attaching to the maker VM.

### What flips this to Accepted

1. A spike shows a terminal/editor server in a Vercel Sandbox human workspace, gated by the
   capability token, usable from the console with acceptable latency from `iad1`.
2. A spike shows the GitHub App user-to-server token merging a draft PR under branch protection,
   with the merge attributed to the person.
3. The security audit signs off §3's bundle-out push path and §4's token gate, and one live run
   of Spike B's harness confirms the commit and bundle steps in a real sandbox.

### Open questions

- Whether *Take over now* (hold mid-turn and capture) is worth having in the first slice, or only
  turn-boundary takeover.
- Whether Pair mode should also stop after each repair, not just the first turn.
- Whether a human workspace should be offered on terminal runs (`FAILED`,
  `MAX_REPAIR_ATTEMPTS_REACHED`) as a new run seeded from the last candidate, which ADR-0003 would
  need to allow.
