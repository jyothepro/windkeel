# Give the maker agent browser use while building (run the app, view pages, screenshots), surfaced on the run page

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why
Devin's session ships a live **Browser** pane (see ADR-0029 Context §1, the 2026-10-17 Devin audit); Factory.ai droids likewise run and look at the app they build. Windkeel's maker today can only run shell commands and tests, so UI work is built blind and the first time anyone sees a page is the verifier's browser stage — or the human reviewer. Giving the maker a browser closes a visible feature gap and cuts repair-loop iterations on UI tasks.

Windkeel's edge is the **independent verifier** (ADR-0004: fresh sandbox; ADR-0029: "the verifier stays the gate"). Rule for this work: **no path around verification**. Maker screenshots are *maker-authored, untrusted* artifacts for humans and for the agent's own feedback loop. They are never evidence, never read by the gate, never change a verdict, and never land in the evidence package.

## Background the implementer needs
**Verifier browser QA (reuse this):**
- `packages/verification/src/stages/browser.ts` — `runBrowser(execEnv, id, repo, flows, packageDir)`. Runs each repo-declared `FlowSpec` command (`packages/verification/src/config.ts`: `{ name, command, artifacts? }`, default artifacts dir `test-results`), collects artifacts via `collectArtifacts()` guarded by the private `SAFE_ARTIFACT_PATH` predicate (relative, no `..`, no `\`, no NUL), 5 MB `INLINE_LIMIT`, sha256 per file. Windkeel does not invent flows.
- `test/browser.test.js` — fixtures fake Playwright by having the "flow" command write files into `test-results/`; runs `runCli(["verify", ...])` from `test/helpers.js` (`fixtureRepo`, `tempDir`, `readJson`).
- `test/console-browser.js` — `browserSkip()` (returns a skip reason if `playwright-core`/Chromium unavailable) and `serveApi(deps, auth)` + console `next dev`; used by `test/console-models-browser.test.js`. `playwright-core` is already a dependency (root `package.json`).

**Maker side:**
- `src/factory/workflow/handlers/implementing.ts` — IMPLEMENTING stage; `buildMakerPrompt(task)` renders the worker prompt; session polled via `session-turn.ts` (`pollSession`), events persisted by `src/factory/agent-events.ts` (`recordAgentEvents`, `AGENT_EVENT_TEXT_LIMIT`) into `agent_event` (`migrations/0022_agent_event.sql`, `type` has a CHECK constraint list: started, thinking, command_started, command_finished, test_started, test_finished, file_changed, message, completed, failed).
- `src/worker/adapter.ts` — `WorkerEvent` union, `WorkerSession`; Codex adapter in `src/worker/codex/`; fakes `src/worker/fake.ts`, `src/worker/scripted.ts`.
- Sandbox: `src/sandbox/provider.ts` (`SandboxProvider`, `SandboxHandle extends ExecutionEnvironment`, `SandboxRole = "maker" | "verifier"`, `NetworkPolicy`), `src/sandbox/vercel.ts`, fake `src/sandbox/fake.ts` (`FakeSandboxProvider`, `SandboxCallRecord`). Egress phases: `src/sandbox/network-phase.ts` (`installPhasePolicy`, `executionPhasePolicy` — execution phase allowlist = model API domain + narrow extras). System packages: `src/sandbox/system-tools.ts` (`installDeclaredTools`).
- Candidate capture: `src/factory/workflow/handlers/candidate-capture.ts` (`captureCandidate`, `EMPTY_CHANGE_POLICY`) — what goes into the PR branch.
- Storage: `src/factory/evidence-storage.ts` (`EvidenceStorage`, `S3EvidenceStorage`, presigned file URLs); a non-evidence precedent for storing run files in the same bucket is `src/factory/run-capture.ts` (`captureObjectKey(runId) = captures/<runId>`).
- API: `apps/ingress/src/api/route.ts` (route table, e.g. `GET /v1/runs/:runId/capture/*path` name `runCaptureFile`), `apps/ingress/src/api/router.ts` (switch on `route.name`). Tests: `test/api-endpoints.test.js`, `test/api-run-workspace.test.js`.
- Console: `apps/console/app/(console)/runs/[id]/page.tsx`, components `activity-feed.tsx`, `workspace-files.tsx`, `human-workspace.tsx`, `terminal-log.tsx`.
- Migrations: SQL files in `migrations/`, latest `0036_run_merge_claim.sql` → next is **`0037_`**.

**ADRs (1–2 lines each):**
- ADR-0004: verification runs in a fresh independent sandbox; never trusts maker output.
- ADR-0014: assume maker is fully compromised; brokered keys, scoped tokens, phased egress (install phase wide, execution phase narrow).
- ADR-0016: local dev hermetic by default — everything testable with fakes, no cloud.
- ADR-0020/0021: control plane is Vercel end-to-end; Vercel Workflow backs `WorkflowProvider`; handlers must be idempotent/replay-safe.
- ADR-0028: model calls recorded at boundary Windkeel owns (browser helper must not call models).
- ADR-0029: integrated assistant (Devin parity) but verifier stays the gate.

**Test conventions:** `npm test` = clean + build + `node --test --test-force-exit test/*.test.js` (tests import from `dist/`). Postgres-backed tests follow `test/e2e-github-loop.test.js` / `test/e2e-factory-loop.test.js` (skip when no `DATABASE_URL`), fakes `FakeSandboxProvider`, `FakeGitHubClient`, scripted worker.

## Scope
**In:** a sandbox-local browser helper the maker can invoke; Chromium provisioning in the maker sandbox during install phase; screenshot harvesting after each maker turn; storage outside the evidence package; `agent_event` type `screenshot`; API list/file endpoints; run-page screenshot strip in the activity feed; prompt addendum; opt-in config flag.
**Out:** live interactive browser streaming (VNC/CDP to the human) — later, with ADR-0029 takeover; giving the *verifier* anything new; letting maker screenshots feed the gate or PR body as evidence; browsing the public internet from the maker (execution egress unchanged); multi-harness specifics (see 10-multi-harness).

## Design
1. **Helper `windkeel-browse`** (new file `src/sandbox/maker-browser/windkeel-browse.mjs`, copied into the maker sandbox like other installed tooling). Argv-only CLI, no shell:
   - `windkeel-browse screenshot <url> [--name n] [--full-page] [--wait-for selector] [--viewport 1280x800]` → writes `.windkeel/browser/<seq>-<name>.png` + appends a line to `.windkeel/browser/index.jsonl` `{name,url,title,status,consoleErrors[],at}`; prints path + console errors to stdout (so the agent "sees" the result in its command output).
   - `windkeel-browse serve -- <cmd...>` optional convenience: start dev server in background, wait for port.
   - URL restriction: only `http://localhost|127.0.0.1|0.0.0.0:<port>`; else exit 2 `url_not_local`. Uses `playwright-core` + `chromium-headless-shell`.
2. **Provisioning** (new file `src/sandbox/maker-browser/install.ts`): in maker install phase, when enabled, `npx playwright-core install chromium-headless-shell` (+ OS deps via `installDeclaredTools`-style apt path). Add needed hosts (playwright CDN) to `installPhasePolicy` only when enabled. Failure → non-fatal; record `browser_unavailable` agent message event, continue without browser.
3. **Enablement:** `windkeel.config.json` new optional `"makerBrowser": { "enabled": true, "startCommand"?: string, "port"?: number }` parsed in `packages/verification/src/config.ts` (verifier ignores it); default enabled when `flows` non-empty. Global kill switch env `WINDKEEL_MAKER_BROWSER=off|on` (default `on`) in `src/factory/worker-config.ts`.
4. **Prompt:** `buildMakerPrompt` gains optional `browser?: { startCommand?, port? }` → appends a "## Browser" section explaining `windkeel-browse` usage and that screenshots are for self-checking.
5. **Excluded from PR:** `.windkeel/browser/` must never be committed — enforce in `captureCandidate` (exclude path) and add to sandbox `.git/info/exclude`.
6. **Harvest** (new file `src/factory/maker-screenshots.ts`): after each turn poll / session end, `listFiles('.windkeel/browser')`, filter with exported `isSafeArtifactPath` (move `SAFE_ARTIFACT_PATH` out of `browser.ts` into `packages/verification/src/evidence/package.ts` or a new `paths.ts` and export), only `.png`, ≤ 5 MB each, ≤ 50 per run (`WINDKEEL_MAKER_SCREENSHOT_MAX`), dedupe by sha256. Upload to bucket key `maker-browser/<engineeringRunId>/<sha256>.png` (new helper `makerScreenshotObjectKey`), NOT under evidence keys. Idempotent: key is content hash; DB insert keyed by `(engineering_run_id, sha256)`.
7. **Data model** — `migrations/0037_maker_screenshot.sql`:
   - `create table maker_screenshot (id uuid pk default gen_random_uuid(), engineering_run_id uuid not null references engineering_run(id), agent_run_id uuid references agent_run(id), sha256 text not null, object_key text not null, bytes integer not null, name text, url text, page_title text, console_errors jsonb not null default '[]', captured_at timestamptz not null default now(), unique (engineering_run_id, sha256))`.
   - Alter `agent_event` type check to add `'screenshot'` (payload `{screenshotId,name,url}`), so screenshots appear in the feed ordered by `seq`.
   - Retention: delete with run per ADR-0015 tombstone sweep (`src/factory/evidence-retention.ts` / `sweeps/`) — same tier as captures.
8. **API** (`route.ts` READ): `GET /v1/runs/:runId/screenshots` (`runScreenshots`) → `[{id,name,url,pageTitle,consoleErrors,capturedAt,bytes}]`; `GET /v1/runs/:runId/screenshots/:screenshotId` (`runScreenshotFile`) → 302 to presigned URL (or bytes in local/fake storage). Org-scoped like `runCaptureFile`.
9. **Console:** new `apps/console/components/screenshot-strip.tsx`; `activity-feed.tsx` renders `screenshot` events as thumbnail + caption; run page gets a "Browser" section/tab listing all. Label clearly: **"Maker screenshots — not verification evidence"**. Images served `Content-Type: image/png` only, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`.
10. **Security:** maker is hostile (ADR-0014): validate PNG magic bytes, cap size/count, never render maker-supplied text as HTML (url/title/console errors escaped & capped at `AGENT_EVENT_TEXT_LIMIT`), no new execution-phase egress, Chromium runs as sandbox default user, no credentials in browser env.

## Implementation steps
1. Export `isSafeArtifactPath` from verification package; `browser.ts` uses it (no behavior change). Verify: `test/browser.test.js` green.
2. Config: parse `makerBrowser` + env kill switch; unit tests.
3. Write `windkeel-browse.mjs`; unit test locally against a tiny `node:http` server (skip via `browserSkip()` if no Chromium).
4. Install step + install-phase policy extension; FakeSandboxProvider records the install command.
5. Exclude `.windkeel/browser/` from candidate capture.
6. Prompt addendum in `buildMakerPrompt`.
7. Migration 0037 + repository functions (`insertMakerScreenshot`, `listMakerScreenshots`) in `src/factory/repositories.ts`.
8. Harvest module wired into IMPLEMENTING and REPAIRING turn completion; records `screenshot` agent events.
9. API routes + handlers.
10. Console strip + feed rendering.
11. E2E test; docs: update `docs/ui/console-ux.md` and add note in `research/MILESTONES.md`; optional short ADR-0030 "maker screenshots are not evidence" (new file).

Sub-tasks for PR splitting: **A** (steps 1–6: sandbox browser + prompt, no persistence), **B** (7–9: harvest/storage/API, blocked by A), **C** (10–11: console + e2e, blocked by B). Each has the relevant done items below.

## Done condition
- A maker run on a repo with `flows` (or `makerBrowser.enabled`) has Chromium + `windkeel-browse` available; disabled when `WINDKEEL_MAKER_BROWSER=off`.
- `windkeel-browse` refuses non-local URLs (exit 2) and writes PNG + index entry for local ones.
- `.windkeel/browser/**` never appears in the candidate commit/PR diff.
- Screenshots are stored under `maker-browser/<runId>/`, rows in `maker_screenshot`, `screenshot` events in the run feed; idempotent on replay (no duplicates).
- Unsafe paths, non-PNG, oversized, and over-cap files are dropped and noted, never uploaded.
- `GET /v1/runs/:id/screenshots[/:sid]` work, org-scoped (other org → 404).
- Run page shows thumbnails labeled as not evidence.
- Verifier output (evidence package, `hashes.json`, verdict) is byte-identical with or without maker screenshots.
- Chromium install failure doesn't fail the run.
- `npm test` passes; no new required cloud dependency (ADR-0016).

## How to verify the done condition
- `npm test` (full); focused: `npm run build && node --test test/maker-browser.test.js test/maker-screenshots.test.js test/browser.test.js test/api-run-screenshots.test.js`.
- Postgres e2e: `DATABASE_URL=postgres://... node --test test/e2e-maker-browser.test.js` — expect pass, not skip.
- Browser: `npx playwright-core install chromium-headless-shell && node --test test/console-screenshots-browser.test.js`.
- Migration: run migrate CLI (`src/factory/migrate-cli.ts`, via the repo's npm migrate script) against a fresh DB; `\d maker_screenshot` exists.
- Live (human, optional): run a UI task against a Vercel Sandbox; run page shows a screenshot of the app's localhost page; PR diff has no `.windkeel/`.

## Tests required
**Unit**
- `test/browser.test.js` (existing): still green after `isSafeArtifactPath` extraction; add case importing the exported predicate (`../x`, `/abs`, `a\\b`, `a//b`, `.`, NUL → false; `shots/a.png` → true).
- new `test/maker-browser-config.test.js`: `makerBrowser` parsing (absent, enabled, bad types → rejected entry), default-on with flows, env kill switch.
- new `test/maker-browser.test.js`: `windkeel-browse` URL refusal (https://example.com, file://, `http://169.254.169.254`), local screenshot writes PNG + index.jsonl with console errors captured (skip via `browserSkip()`); `buildMakerPrompt` includes/omits Browser section.
- new `test/maker-screenshots.test.js` (FakeSandboxProvider + in-memory/fake storage): harvest uploads PNGs, dedupes by sha256, drops unsafe path / non-PNG magic / >5 MB / over cap with reasons, idempotent second call, missing dir → no-op.
- `test/sandbox-network-phase.test.js`: install-phase policy gains playwright host only when enabled; execution-phase unchanged.
- candidate-capture test (extend existing file covering `captureCandidate`): `.windkeel/browser/a.png` excluded; a screenshot-only change counts as empty change.
**Integration/e2e**
- new `test/e2e-maker-browser.test.js` modeled on `test/e2e-github-loop.test.js`: real Postgres, `FakeSandboxProvider`, `FakeGitHubClient`, scripted worker whose turn writes `.windkeel/browser/001-home.png`; assert `maker_screenshot` row, `screenshot` agent_event in `/v1/runs/:id/events`, PR files exclude `.windkeel/`, evidence package contains no maker screenshot, verdict same as control run; replay the stage → no duplicates.
- new `test/api-run-screenshots.test.js` (pattern of `test/api-run-workspace.test.js`): list, file, cross-org 404, unknown id 404, headers nosniff/image/png.
**Browser**
- new `test/console-screenshots-browser.test.js` using `serveApi` + console from `test/console-browser.js`: run page renders thumbnail and the "not verification evidence" label; malicious title `<img onerror>` rendered as text.

## Risks & open questions
- Sandbox image may lack Chromium OS libs → install cost/time each run. Default: install only when enabled; later reuse 02-environment-snapshots to bake it in.
- Codex harness may not know to call `windkeel-browse`; default: prompt section + AGENTS-style hint; MCP tool later (10-multi-harness).
- Should screenshots go into PR body? Default **no** (would look like evidence). Human decision.
- Retention tier for screenshots: default same as captures (ADR-0015). Human confirm.
- Add ADR-0030? Default yes, short.
- Default-on for repos with `flows`: costs install time; default on, kill switch available.

## Suggested labels and dependencies
- Labels: `ready-for-agent` (sub-tasks A, B, C); ADR decision bits `ready-for-human`.
- Dependencies: none hard. Soft: 02-environment-snapshots (bake Chromium), 10-multi-harness (tool exposure for non-Codex harnesses), 01-live-proof (live validation).
