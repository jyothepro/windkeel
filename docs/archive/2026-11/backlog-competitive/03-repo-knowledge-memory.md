# Repository knowledge & memory: per-repo knowledge notes, codebase digest, learned lessons, injected into the maker prompt with provenance

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why

Devin ("Knowledge", "DeepWiki") and Factory.ai ("org memory", Droids reading codebase context) win repeat customers because the agent gets better at *your* repo over time: it remembers "run `pnpm -w test`, not `npm test`", "never touch `legacy/`", "reviewers here reject PRs without changelog entries". Windkeel's maker today gets only the task title, description and acceptance criteria (`buildMakerPrompt` in `src/factory/workflow/handlers/implementing.ts`). Every run starts from zero, so it repeats mistakes the independent verifier already caught last week. That costs repair cycles (rails, ADR-0011) and money.

Windkeel's edge is the **independent verifier** (ADR-0004, kept as the gate by ADR-0029: *there is no path around verification*). Memory has to stay on the right side of that line: knowledge **shapes what the maker is told**, and **never** changes what the verifier checks, skips, or accepts. Memory only feeds the maker, and every injected note can be traced back to where it came from (provenance), so a bad note can be found and removed.

This is roadmap milestone **M12 — Repository / organization memory** in `research/MILESTONES.md` ("Repo knowledge ingestion, policy extraction, learned preferences, reviewer feedback").

## Background the implementer needs

Repo: TypeScript, Node 22. `npm test` = clean + build + `node --test --test-force-exit test/*.test.js`. Tests import from **`dist/`** (e.g. `../dist/factory/repositories.js`), so always build first.

### Relevant code (all real)
- **Maker prompt**: `src/factory/workflow/handlers/implementing.ts`
  - `export function buildMakerPrompt(task: { title; description; acceptanceCriteria: Array<{id,text}> }): string` (line ~66). Called once: `worker.start({ prompt: buildMakerPrompt(task), sandbox: handle, route })` (line ~284).
  - The handler is created by `createImplementingHandler(deps: StageDeps)`; `StageDeps` lives in `src/factory/workflow/stage-deps.ts`. DB helpers come from `src/factory/repositories.ts` (`getEngineeringTask`, `getEngineeringRun`, `insertAgentRun`, …).
- **Repair turns**: `src/factory/workflow/handlers/repairing.ts` — deliberately has *no second prompt renderer*; the adapter renders the repair packet with `repair_constraints` marked binding. Do **not** add knowledge to repair turns in this item (would be a second untested prompt; see header comment of that file).
- **Worker seam**: `src/worker/adapter.ts` (`WorkerStartInput.prompt: string`, `WorkerAdapter`). Fake: `src/worker/fake.ts` (`FakeWorker`-style adapter recording `calls: [{type:"start", prompt, workdir}]`) — use it to assert the prompt contents.
- **Precedent for "a person's text reaches the maker, recorded with attribution"**: run guidance — `src/factory/run-guidance.ts`, migration `migrations/0018_run_guidance.sql` (+`0019`), tests `test/run-guidance.test.js` ("the rendered turn carries the constraint and attributes every message"). Copy its style: append-only/attributed rows, `actor text`, explicit render function tested in isolation.
- **Verifier's own repo context (reviewer side, NOT to be mixed with this)**: `packages/verification/src/stages/repo-context.ts` (`collectRepositoryContext`, `renderRepositoryContext`), tested in `test/repo-context.test.js` (#241). It reads the repo for the *reviewer*. Knowledge from this item must **never** be passed into `packages/verification` (enforced by `test/verification-boundary.test.js` / `test/gate-isolation.test.js` patterns — add an assertion).
- **Repository entity**: `src/factory/repository-entity.ts`, migration `0005_repository.sql`; per-repo secrets precedent `src/factory/repository-secrets.ts`, `0020_repository_secret.sql`, API routes in `apps/ingress/src/api/route.ts` (`/v1/repositories/:repositoryId/secrets`).
- **Tenancy**: `src/factory/tenancy.ts` — `PERMISSIONS` const (`runs.read`, `repositories.manage`, …). Organization-scoped tables reference `organization (id)` (`migrations/0021_tenancy.sql`); repository access is via `repository_grant`. New permissions are added to built-in roles by a migration (example: `0034_human_editing.sql` lines ~108 `update access_role set permissions = permissions || array['runs.takeover'] …`).
- **API**: routes declared in `apps/ingress/src/api/route.ts` (`ROUTES`, scope consts `READ`, `GRANTS`, …), dispatched in `apps/ingress/src/api/router.ts` (`handleApiRequest`) to `apps/ingress/src/api/handlers.ts`. Writes are "intents" (ADR-0023). Tests: `test/api-endpoints.test.js`, `test/api-routing.test.js`, `test/api-tenancy.test.js`.
- **Console**: Next.js in `apps/console`. Repo page `apps/console/app/(console)/repositories/[id]/page.tsx`; settings sections `apps/console/app/(settings)/settings/{sections.tsx,nav.ts,actions.ts}`. Browser test harness `test/console-browser.js` (`browserSkip()`, real router over HTTP + `next dev`); example `test/console-models-browser.test.js`.
- **Run report / evidence**: `src/factory/run-report.ts` — where a run explains itself; provenance of injected knowledge should appear here.
- **Review feedback source**: PR events `src/factory/pull-request-events.ts`, GitHub webhooks `src/github/app-deliveries.ts`; verifier findings are stored as stage results (`src/factory/stage-results.ts`).
- **Migrations**: plain SQL, `migrations/NNNN_name.sql`, latest is `0036_run_merge_claim.sql`; runner `src/factory/migrate.ts`; tested by `test/migrate.test.js`.

### ADRs (read them)
- **ADR-0004** verification runs in a fresh independent sandbox — the gate. Knowledge must not reach it.
- **ADR-0014** the maker is assumed hostile — so the maker must not be able to *write* knowledge directly (no "agent saves its own memory" without human approval).
- **ADR-0016** local dev hermetic by default — no network/LLM in tests; use fakes (`FakeSandboxProvider`, `FakeGitHubClient` in `src/github/fake.ts`, fake worker).
- **ADR-0020/0021** control plane is Vercel end-to-end; Vercel Workflow backs `WorkflowProvider` — any background job (lesson extraction) is a workflow step / sweep, not a long-lived process.
- **ADR-0027** maker harness frozen per run — likewise, the **knowledge snapshot is frozen per run** (record exactly what was injected).
- **ADR-0029** integrated assistant; verifier stays the gate.

### Test conventions
- DB tests: `const dbUrl = process.env.TEST_DATABASE_URL; const skip = dbUrl ? false : "TEST_DATABASE_URL not set";` then `test("…", { skip }, …)`, each in a throwaway schema via `runMigrations` (see `test/run-guidance.test.js` `withSchema`). Local Postgres: `docker-compose.yml`.
- E2E: `test/e2e-github-loop.test.js`, `test/factory-stack.js`, `test/start-task.js` build the full stack on fakes.
- Test names are sentences describing behaviour.

## Scope (in)
1. **Knowledge notes**: org-wide and repo-scoped notes (title, body markdown, optional path globs trigger, enabled flag), CRUD via API + console, attributed (`created_by`, history).
2. **Codebase digest**: deterministic, non-LLM summary generated from the repo at provisioning (files the repo already ships: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, README "Development/Testing" sections, `package.json` scripts / detected test command, top-level directory tree). Stored per repo + commit SHA, viewable in console.
3. **Learned lessons (suggested)**: after a run ends, derive candidate notes from (a) verifier findings that caused repair cycles, (b) human PR review comments / change-requests on Windkeel PRs. They land as `status='suggested'` and are **never injected until a human accepts** them.
4. **Injection**: maker prompt gets a bounded `## Repository knowledge` section; per-run snapshot of which notes (id + version + source) were injected; shown in run report and console run page.
5. Console UI: view/edit notes per repo + org, accept/reject suggestions, view digest.

## Out of scope
- Embeddings/vector search, LLM-generated wiki (DeepWiki-style). Follow-up; keep a `KnowledgeSelector` seam so it can be added.
- Injecting knowledge into the verifier/reviewer or the criteria gate (forbidden, not just deferred).
- Knowledge in repair turns (follow-up; requires changing the adapter's packet renderer).
- Cross-org sharing, import from Devin/Cursor rules beyond reading in-repo files.
- Intake integrations (item 04), playbooks/agent types (05 — will consume notes).

## Design

### Data model — new file `migrations/0037_knowledge.sql`
(Use the next free number at implementation time; if another backlog item took 0037, renumber.)
```sql
create table knowledge_note (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id) on delete cascade,
  repository_id    uuid references repository (id) on delete cascade, -- null = org-wide
  title            text not null check (length(title) between 1 and 200),
  body             text not null check (length(body) between 1 and 8000),
  path_globs       text[] not null default '{}',   -- empty = always applies
  status           text not null check (status in ('active','suggested','rejected','archived')),
  source_kind      text not null check (source_kind in ('human','repo_file','verifier_finding','pr_review')),
  source_ref       jsonb not null default '{}',     -- e.g. {"runId":..,"finding":..} or {"pr":12,"commentId":..}
  version          integer not null default 1,
  created_by       text not null,                   -- actor, same convention as run_guidance.actor
  updated_by       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index knowledge_note_scope_idx on knowledge_note (organization_id, repository_id, status);

create table knowledge_note_revision (           -- append-only history for audit/rollback
  note_id uuid not null references knowledge_note (id) on delete cascade,
  version integer not null, title text not null, body text not null, path_globs text[] not null,
  status text not null, actor text not null, at timestamptz not null default now(),
  primary key (note_id, version)
);

create table repository_digest (
  repository_id uuid not null references repository (id) on delete cascade,
  commit_sha    text not null,
  body          text not null,       -- rendered markdown, capped
  sources       jsonb not null,      -- [{path, bytes, sha256}]
  generated_at  timestamptz not null default now(),
  primary key (repository_id, commit_sha)
);

create table run_knowledge (       -- frozen per-run snapshot (provenance, ADR-0027 style)
  engineering_run_id uuid not null references engineering_run (id),
  note_id uuid, note_version integer, digest_sha text,
  source_kind text not null, title text not null, chars integer not null,
  primary key (engineering_run_id, coalesce(note_id::text, 'digest'))  -- or a surrogate id; pick one that compiles
);
-- permissions
update access_role set permissions = permissions || array['knowledge.manage'], updated_at = now()
 where key in ('admin','member') and account_id is null and not ('knowledge.manage' = any (permissions));
```
(Postgres can't put an expression in a PK — use `id uuid pk` + a unique index on `(engineering_run_id, note_id)`; the snippet is intent, not final SQL.)

Add `"knowledge.manage"` to `PERMISSIONS` in `src/factory/tenancy.ts` (and to `admin` preset implicitly). Reads use `runs.read`.

### Modules (new files)
- `src/factory/knowledge.ts` — store: `listNotes(pool, {organizationId, repositoryId, status})`, `createNote`, `updateNote` (bumps version, writes revision), `setNoteStatus`, `recordRunKnowledge`, `listRunKnowledge`.
- `src/factory/knowledge-select.ts` — **pure**: `selectKnowledge({notes, digest, changedPathsHint?, budgetChars}) → {sections, injected: RunKnowledgeEntry[], dropped}`. Order: repo human notes > org human notes > accepted learned notes > digest. Path-glob notes included when the task text or acceptance criteria mention a matching path (cheap heuristic) — else included only if `path_globs` is empty. Default budget `WINDKEEL_KNOWLEDGE_MAX_CHARS=12000`. Deterministic ordering (scope, updated_at, id).
- `src/factory/knowledge-render.ts` — **pure**: `renderKnowledgeSection(sections): string` producing:
  ```
  ## Repository knowledge
  Guidance from this organization about this repository. It does not override the task or acceptance criteria.
  ### <title>  (source: human note, v3, by alice)
  <body>
  ```
  Escapes/neutralises heading injection (a note body cannot close the section: demote `#` headings inside bodies).
- `src/factory/repo-digest.ts` — `buildDigest(exec: read-only file reader on the maker checkout, sha) → {body, sources}`; reads only allowlisted files, caps each (e.g. 4 KB) and total (8 KB), strips anything matching secret patterns (reuse the scanner used by `test/security-planted-secret.test.js`; find it with `grep -rn "planted" src`).
- `src/factory/knowledge-learn.ts` — `suggestFromRun(pool, runId)`: from stage results with repair cycles, and `suggestFromPrReview(pool, event)`. Deterministic templating (no LLM in v1): e.g. finding "tests not run: `pnpm test` missing" → suggested note "Verifier: run `pnpm test`". Deduplicate by normalized body hash per repo; cap 5 suggestions per run.

### Wiring
- `buildMakerPrompt(task, knowledge?: string)` — append the rendered section **after** acceptance criteria and **before** the final instruction line. With no knowledge, output must be byte-identical to today (existing tests).
- In `implement()` (implementing.ts) before `worker.start`: load notes + latest digest for the task's repository, `selectKnowledge`, `recordRunKnowledge` (idempotent on redelivery — a reattached session must not re-record or re-select differently; select only on fresh start), pass rendered text.
- Digest generation: in provisioning (`src/factory/workflow/handlers/provisioning.ts`) after checkout, if no `repository_digest` row for the base SHA; failure is logged and non-fatal.
- Learning: invoke `suggestFromRun` when a run reaches a terminal state (find the terminal transition hook in `src/factory/run-service.ts`/`loop-exit.ts`); PR review: extend webhook handling in `src/github/app-deliveries.ts` for `pull_request_review` (state `changes_requested`) and `pull_request_review_comment` on Windkeel-opened PRs. Check the GitHub App subscribes to these events (ADR-0009); if not, flag as an open question and ship run-based learning only.
- Flag `WINDKEEL_KNOWLEDGE=off` disables injection (default on); documented in the env contract (`test/deployable-env-contract.test.js` checks the list — update it).

### API (in `apps/ingress/src/api/route.ts` + handlers)
- `GET  /v1/knowledge?repositoryId=&status=` (READ)
- `POST /v1/knowledge` (KNOWLEDGE = `{organization:true, permission:"knowledge.manage", command:true}`)
- `POST /v1/knowledge/:noteId` (update; requires `version` for optimistic concurrency → 409 on mismatch)
- `POST /v1/knowledge/:noteId/status` (`accept`→active, `reject`, `archive`)
- `GET  /v1/knowledge/:noteId/revisions` (READ)
- `GET  /v1/repositories/:repositoryId/digest` (READ)
- `GET  /v1/runs/:runId/knowledge` (READ) — provenance
Repository must be one the caller's org has a `repository_grant` for; otherwise 404 (same rule as router line ~452).

### Console
- `apps/console/app/(console)/repositories/[id]/page.tsx`: new "Knowledge" section — list notes (repo + inherited org), edit/create form, suggestions tab with Accept/Reject showing source link (run id / PR comment), digest viewer.
- Settings: new section "Knowledge" (org-wide notes) in `apps/console/app/(settings)/settings/nav.ts` + `sections.tsx`, server actions in `actions.ts`.
- Run page (`apps/console/app/(console)/runs/...`): "Knowledge used" panel from `/v1/runs/:runId/knowledge`.

### Security
- Maker cannot write notes (no API token in sandbox has `knowledge.manage`; the learning path writes only `suggested`).
- Notes are prompt input from people → prompt-injection risk is equal to task description; accepted, but notes are org-scoped and audited.
- Digest strips secrets; never read `.env*`, files >4 KB, or binary.
- No knowledge in `packages/verification` — boundary test.
- Repo-file note content is untrusted repo text; label it "from repository file X".

## Implementation steps
Split into 4 PRs (sub-tasks). Each must pass `npm test`.

### 3a — Store + injection (core)
1. Add migration `0037_knowledge.sql` (tables + permission). Run `test/migrate.test.js`.
2. Add `knowledge.manage` to `PERMISSIONS`.
3. Write `knowledge.ts`, `knowledge-select.ts`, `knowledge-render.ts` + unit tests.
4. Extend `buildMakerPrompt` with optional knowledge; wire into `implement()`; record `run_knowledge`.
5. Add `WINDKEEL_KNOWLEDGE` flag + env contract.
6. Add run-report line ("Knowledge injected: N notes (ids…)") in `run-report.ts`.
**Done**: a human-note row for a repo appears in the fake worker's start prompt with provenance; `run_knowledge` rows exist; no knowledge → prompt unchanged; verifier package never imports knowledge modules.

### 3b — API + console CRUD
1. Routes/handlers above; optimistic concurrency; tenancy 404s.
2. Console repo Knowledge section, settings org section, run "Knowledge used" panel.
**Done**: create/edit/archive via API and UI; Member can manage, read-only token cannot (403); other-org repo → 404.

### 3c — Codebase digest
1. `repo-digest.ts`; call in provisioning; store; API + console viewer; injected as lowest priority.
**Done**: fixture repo with AGENTS.md + package.json scripts produces digest containing the test command; planted secret never appears.

### 3d — Learned suggestions
1. `knowledge-learn.ts` from verifier findings on terminal runs; PR review events if subscribed.
2. Console suggestions accept/reject.
**Done**: a run with a repair cycle produces ≤5 `suggested` notes with `source_ref.runId`; they are NOT injected until accepted; after accept, next run's prompt includes them.

## Done condition
- Migration applies cleanly on empty DB and on a DB at 0036 (`test/migrate.test.js` green).
- `buildMakerPrompt` without knowledge is byte-identical to the current output.
- With active notes, the maker start prompt contains `## Repository knowledge`, each note title, and a `source:` provenance line; total section ≤ `WINDKEEL_KNOWLEDGE_MAX_CHARS`.
- `suggested`/`rejected`/`archived` notes are never injected.
- Every run that injected knowledge has `run_knowledge` rows; `GET /v1/runs/:id/knowledge` returns them; run report mentions them.
- Redelivery/reattach of IMPLEMENTING does not duplicate `run_knowledge` rows or change the snapshot.
- No module under `packages/verification` imports or receives knowledge (test).
- API enforces `knowledge.manage`, tenancy 404, version 409.
- Console shows/edit notes, suggestions, digest, run "Knowledge used" (browser test passes where Chromium available).
- `WINDKEEL_KNOWLEDGE=off` → no section injected, no rows recorded.
- `npm test` green; no network needed (ADR-0016).

## How to verify the done condition
```bash
docker compose up -d postgres            # see docker-compose.yml for service name
export TEST_DATABASE_URL=postgres://...  # as used by other DB tests
npm test                                  # full suite, must be green
npm run build && node --test test/knowledge-render.test.js test/knowledge-select.test.js \
  test/knowledge-store.test.js test/knowledge-injection.test.js test/api-knowledge.test.js \
  test/repo-digest.test.js test/knowledge-learn.test.js test/e2e-knowledge-loop.test.js \
  test/console-knowledge-browser.test.js test/verification-boundary.test.js test/migrate.test.js
```
Proof: DB tests report "pass" not "skipped" (`TEST_DATABASE_URL` set); browser test not skipped (`npx playwright-core install chromium-headless-shell`).
Manual (optional, live): create a note via `POST /v1/knowledge` on a deployed env, start a task on that repo, open the run page → "Knowledge used" lists the note; the Codex transcript's first prompt contains it.

## Tests required

### Unit (new files, no DB)
- `test/knowledge-render.test.js`: renders title/body/provenance; demotes `#` headings in body; empty input → empty string; stable output.
- `test/knowledge-select.test.js`: priority order; budget truncation drops lowest priority first and reports `dropped`; whole notes only (never cut mid-note) except a single oversized note truncated with marker; path-glob note included only when task mentions matching path; non-active statuses excluded; deterministic for equal timestamps.
- `test/maker-prompt.test.js` (or extend existing implementing tests in `test/workflow-stages-implement.test.js`): no-knowledge byte-identical; knowledge placed after criteria and before final instruction.
- `test/repo-digest.test.js`: uses `fixtureRepo` from `test/helpers.js`; includes AGENTS.md and scripts; caps size; skips `.env`, binaries; planted secret removed.
- `test/knowledge-learn.test.js`: finding → suggestion template; dedupe by hash; cap 5; non-Windkeel PR ignored.

### DB / integration (skip without `TEST_DATABASE_URL`)
- `test/knowledge-store.test.js`: CRUD; version bump writes revision; status transitions; org isolation; cascade on repo delete.
- `test/knowledge-injection.test.js`: run IMPLEMENTING with fake worker (pattern from `test/workflow-stages-implement.test.js`), assert `calls[0].prompt` contents and `run_knowledge` rows; redelivery no duplicates; `WINDKEEL_KNOWLEDGE=off`; DB error loading notes → run proceeds without knowledge and logs (non-fatal) — decide & assert.
- `test/api-knowledge.test.js`: routes via `handleApiRequest` (pattern `test/api-endpoints.test.js`, `test/api-tenancy.test.js`): 200/403/404/409, validation (empty title, body >8000 → 400).
- Extend `test/verification-boundary.test.js` (or `test/gate-isolation.test.js`): `packages/verification/src` contains no import of `knowledge`; verifier stage inputs unchanged when notes exist.
- Extend `test/deployable-env-contract.test.js` for new env vars; `test/adr.test.js` if you add an ADR.
- `test/e2e-knowledge-loop.test.js`: on `test/factory-stack.js` + `FakeGitHubClient`: run 1 fails verification once → suggestion created → accept via API → run 2 prompt contains it → verification still runs and gates run 2 (assert VERIFYING stage executed).

### Browser
- `test/console-knowledge-browser.test.js` using `test/console-browser.js` (`browserSkip()`), modelled on `test/console-models-browser.test.js`: create note on repo page, see it listed; accept a seeded suggestion; run page shows "Knowledge used".

## Risks & open questions
- **New ADR?** Memory touches ADR-0014/0004 boundaries. Default: add `docs/adr/0030-repository-knowledge-shapes-the-maker-never-the-verifier.md` (Proposed) in 3a; check `test/adr.test.js` format rules.
- **Auto-accept learned notes?** Default: no — human accept required (maker hostile, ADR-0014). Human decision.
- **Who can manage knowledge?** Default Admin+Member. Human decision.
- **GitHub App review events** may not be subscribed (ADR-0009 scope). Default: ship run-based learning; PR-review learning behind subscription change → ready-for-human.
- **Should verifier see repo AGENTS.md?** It already may via `repo-context.ts`; unchanged here.
- **Prompt budget vs. model context**: default 12k chars; revisit with item 10 (multi-harness).
- **Migration number collisions** with other backlog items — take next free at merge time.
- **Failure policy** when knowledge load fails: default non-fatal (run continues, report says "knowledge unavailable").

## Suggested labels and dependencies
- Labels: `ready-for-agent` for 3a, 3b, 3c; `ready-for-human` for 3d's PR-review half (GitHub App event scope decision) and the ADR acceptance.
- Dependencies: none hard. Soft: 05-agent-types-playbooks consumes notes (should come after 3a); 08-enterprise-readiness (audit log) may reuse `knowledge_note_revision`; 10-multi-harness must keep using `buildMakerPrompt` output. 01-live-proof recommended before claiming learning efficacy in marketing.
