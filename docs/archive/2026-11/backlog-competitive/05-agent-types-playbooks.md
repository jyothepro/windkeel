# Agent types & playbooks: reusable task templates (code review, migration, incident fix, test-writing, dependency upgrade) with their own prompts, acceptance criteria and verifier stage config, selectable from console / API / CLI

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

## Why

Devin ships "Playbooks" (reusable prompts with procedures and checks) and Factory.ai ships specialised "Droids" (Code Droid, Review Droid, Reliability Droid). Buyers think in *kinds of work*: "upgrade this dependency", "write tests for this module", "fix this Sentry incident". Today every Windkeel task is generic: a title, a description and acceptance criteria rendered by one prompt (`buildMakerPrompt`), and verified by one fixed pipeline. Users have to rewrite the same instructions every time, and Windkeel can't say "a dependency upgrade gets *these* checks".

Windkeel's edge is the **independent verifier** (ADR-0004; ADR-0029 keeps it as the gate: **there is no path around verification**). Playbooks have to make that edge stronger. A playbook can tell the maker more and ask the verifier to check more. It can **never** skip, weaken or downgrade a verifier stage, approve criteria, or change gate strictness for the worse. Pitch: "Devin has playbooks. Windkeel's playbooks come with a proof obligation."

## Background the implementer needs

Repo: TypeScript, Node 22, monorepo. `npm test` does clean + build + `node --test test/*.test.js`. Tests import compiled code from `dist/` (and `apps/ingress/dist/...`), so build before running a single file: `npm run build && node --test test/<file>.test.js`. Postgres-backed tests skip unless `TEST_DATABASE_URL` is set (pattern: `const skip = dbUrl ? false : "TEST_DATABASE_URL not set";` in `test/model-presets.test.js`). Run `docker compose up -d` (repo-root `docker-compose.yml`) for a local Postgres.

### Relevant code (real paths)
- **Task creation (single seam)**: `src/factory/task-creation.ts`. Has `TaskSpec` (`repositoryId, sourceType, sourceReference, title, description, criteria: Criterion[], riskLevel, rails?, modelOverride?, organizationId?, createdByPrincipalId?`) and `createTaskAndRun(db, spec)`. All intakes go through `src/intake/create-task.ts` (`createTaskFromIntake`, `IntakeTaskInput`).
- **API**: `apps/ingress/src/api/route.ts` (route table; `POST /v1/tasks` → `createTask`, `GET /v1/tasks`), `apps/ingress/src/api/router.ts`, `apps/ingress/src/api/handlers.ts` (`createTask` ~line 1220: validates `riskLevel`, `mode`, `models`, idempotency key; criteria are **extracted from the description server-side**. There is deliberately no way to pass criteria pre-approved, per ADR-0012 §4). Model presets (`apps/ingress/src/api/model-policy.ts`, `src/factory/model-presets.ts`, migration `0033_model_preset.sql`) are the **closest precedent** for an org-scoped, named, validated-on-save template that is *copied* into the task at creation. Follow that pattern.
- **Criteria gate**: `src/factory/criteria-gate.ts` (`needsGeneration`, `assertProvisionable`, approval comment). Provenance columns come from `migrations/0007_criteria_provenance.sql` (`criteria_provenance in ('extracted','generated')`, `criteria_generated_by`, approval).
- **Maker prompt**: `src/factory/workflow/handlers/implementing.ts` has `export function buildMakerPrompt(task: {title, description, acceptanceCriteria})`, used once in `worker.start({ prompt: buildMakerPrompt(task), ... })`. Repair turns (`handlers/repairing.ts`) deliberately have no second prompt renderer. Leave them alone.
- **Verifier**: `packages/verification/src/engine/engine.ts` (`PIPELINE = ["checks","review","intent","security","browser"]`). `verify(request)` takes `request.policy ?? loadTrustedConfig(base_sha) ?? loadConfig`. `packages/verification/src/engine/types.ts` holds `VerificationRequest` (`criteria?`, `policy?: VerificationPolicy` = `WindkeelConfig`). `packages/verification/src/config.ts` holds `WindkeelConfig` (`checks: CheckSpec[]`, `checksRequired`, `flows: FlowSpec[]`, `tools`, `rejectedTools`, …). `packages/verification/src/evidence/gate.ts` holds `GateLevel`/`DEFAULT_GATE_LEVEL = "fail"`. Stage implementations live in `packages/verification/src/stages/*.ts` (`review.ts`, `security.ts`, `browser.ts`, `checks.ts`, `mapping.ts`, `intent.ts`).
- **Factory → verifier call**: `src/factory/workflow/handlers/verifying.ts` (~line 300) builds `request` with `criteria: task.acceptanceCriteria` and **no `policy`**, so the repo's *base-revision* `windkeel.config.json` is trusted. `POLICY_VERSION_PREFIX = "windkeel-engine"` is recorded on every VerificationRun.
- **DB helpers**: `src/factory/repositories.ts` (`EngineeringTask`, `insertEngineeringTask`, `getEngineeringTask`). Read mapping: `src/factory/api-queries.ts`.
- **CLI**: `packages/cli/src/commands/remote.ts` (`submitCommand(api, io, spec: SubmitSpec)` → `POST /v1/tasks`; `SubmitSpec.models`). Client: `packages/cli/src/client/`. Usage text lives in `packages/cli/src/cli.ts`.
- **Console**: Next.js app in `apps/console`. Composer: `apps/console/app/(console)/tasks/new/{form.tsx,actions.ts,page.tsx}`, `apps/console/components/composer.tsx`, `model-picker.tsx`. Settings: `apps/console/app/(settings)/settings/{nav.ts,sections.tsx,model-sections.tsx}`. API client/types: `apps/console/lib/{api.ts,types.ts,fixtures.ts}`. Lib unit tests are colocated (`apps/console/lib/*.test.ts`). Browser tests use `test/console-browser.js` (`browserSkip()`, real router over HTTP plus `next dev`); example: `test/console-models-browser.test.js`.
- **Tests to copy patterns from**: `test/model-presets.test.js` (preset CRUD + route permission checks), `test/api-endpoints.test.js`, `test/criteria-gate.test.js`, `test/e2e-github-loop.test.js` / `test/e2e-factory-loop.test.js` (full loop with `FakeSandboxProvider`, `FakeGitHubClient`, fake worker; helpers in `test/factory-stack.js`, `test/start-task.js`, `test/helpers.js`), `test/verify.test.js` (engine), `test/adr.test.js` (ADR index/format lint).

### ADRs (summaries)
- **ADR-0004**: verification runs in a fresh, independent sandbox. The verifier trusts only the candidate commits.
- **ADR-0012**: criteria are extract-first, generate-fallback. Generated criteria need human approval before provisioning. No API flag skips the gate.
- **ADR-0011**: rails (spend/wall-clock caps). A run's choices are frozen per run.
- **ADR-0016**: local dev is hermetic by default. No network or real vendor calls in tests; use fakes.
- **ADR-0020/0021**: control plane is Vercel end-to-end. Orchestration runs on Vercel Workflow behind `WorkflowProvider` (fake in tests: `src/factory/workflow/fake.ts`).
- **ADR-0024**: tenancy is organization/principal with permissions. Every new table is org-scoped. No schema-qualified objects (§11).
- **ADR-0026/0027**: per-run model/harness snapshot, frozen at intake. Presets are copied, not referenced.
- **ADR-0029**: integrated assistant. The verifier stays the gate. No path around verification.

## Scope

### In
1. A `playbook` entity (org-scoped, versioned) with: name, kind, maker instructions, default/extra acceptance criteria, verifier requirements (strengthen-only), optional default risk level and default model preset.
2. Five **built-in** playbooks shipped as code (read-only, overridable by copying): `code-review`, `migration`, `incident-fix`, `test-writing`, `dependency-upgrade`.
3. Snapshot of the chosen playbook on the task at creation (the preset pattern: later edits don't change existing tasks or runs).
4. The maker prompt includes the playbook's instructions. Verification includes the playbook's extra criteria and extra/strengthened stage requirements, recorded in evidence.
5. API CRUD + `playbook` on `POST /v1/tasks`. CLI `--playbook`. `windkeel playbook list|show`. Console composer picker + settings page.

### Out of scope
- Marketplace or cross-org sharing. Playbook-specific repair prompts. Auto-selecting a playbook from issue text (later: M10 planner). Intake-label mapping (e.g. GitHub label `windkeel:dependency-upgrade` → playbook) is a sub-task 5 stretch goal, and is deferred if it complicates things. Item 04-intake owns Slack/Linear/Jira wiring. Multi-step or parallel playbooks (06). A "code-review" playbook that reviews *someone else's* PR without a maker: it's listed below only as a maker-side "address review feedback / review-and-fix" template; a pure-review mode is the `windkeel verify` / Action path and out of scope.

## Design

### Core invariant (enforce in code and test it)
`applyPlaybookToPolicy(base: WindkeelConfig, req: PlaybookVerifierRequirements): WindkeelConfig` is **monotonic**:
- It can add `checks` (appended, names prefixed `playbook:`), set `checksRequired` to `true` (never to `false`), add `flows`, and add `tools` (subject to the existing `TOOL_NAME`/`MAX_TOOLS` validation in `config.ts`).
- It can mark stages **required** (e.g. `browser` must run, so "skipped: no flows" becomes a blocking finding).
- It can never remove checks, flip `checksRequired` to false, skip a `PIPELINE` stage, or lower the gate level. Those fields simply don't exist in the type. Unknown keys in stored JSON are rejected on save.
- Playbook criteria are **added** to the task's extracted criteria with provenance. They never replace them, and never mark generated criteria approved.

### Data model: new migration `migrations/0037_playbook.sql`
(0036 is the latest today. If a sibling backlog item lands a 0037 first, take the next free number.)
```sql
create table playbook (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organization (id),
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  name text not null check (char_length(name) between 1 and 60),
  kind text not null check (kind in ('code-review','migration','incident-fix','test-writing','dependency-upgrade','custom')),
  version integer not null default 1,
  maker_instructions text not null check (char_length(maker_instructions) <= 8000),
  criteria jsonb not null default '[]' check (jsonb_typeof(criteria) = 'array'),   -- [{text}]
  verifier jsonb not null default '{}' check (jsonb_typeof(verifier) = 'object'),  -- PlaybookVerifierRequirements
  default_risk_level text check (default_risk_level in ('low','medium','high')),
  model_preset_id uuid references model_preset (id) on delete set null,
  archived_at timestamptz,
  created_by_principal_id uuid references principal (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index playbook_slug_idx on playbook (organization_id, slug) where archived_at is null;
alter table engineering_task add column playbook jsonb;  -- frozen snapshot {id|null, slug, version, kind, makerInstructions, criteria, verifier, builtin}
```
Header comment in the house style (see `0033_model_preset.sql`): why, the snapshot rule, no schema qualification. Built-ins are **not** rows. They live in code (`src/factory/playbooks-builtin.ts`, new file), so a deploy can improve them, and their snapshot records `builtin: true` plus the code version.

### Types (new file `src/factory/playbooks.ts`)
```ts
export type PlaybookKind = "code-review"|"migration"|"incident-fix"|"test-writing"|"dependency-upgrade"|"custom";
export interface PlaybookVerifierRequirements {
  extraChecks?: CheckSpec[];          // appended; name ^[a-z0-9][a-z0-9._-]{0,63}$, command <= 1000 chars
  checksRequired?: true;              // literal true only
  requireStages?: Array<"browser"|"security">; // stage must run, not skip
  extraFlows?: FlowSpec[];
  extraTools?: SystemToolSpec[];
}
export interface Playbook { id: string|null; slug; name; kind; version; makerInstructions; criteria: Array<{text:string}>; verifier: PlaybookVerifierRequirements; defaultRiskLevel: RiskLevel|null; modelPresetId: string|null; builtin: boolean }
export type PlaybookSnapshot = Omit<Playbook,"name"|"defaultRiskLevel"|"modelPresetId">;
export class PlaybookError extends Error { constructor(public status: number, public code: string, message: string) }
export function parsePlaybookInput(raw: unknown): ... // strict; rejects unknown keys
export async function listPlaybooks(db, orgId)  // built-ins + org rows (org slug shadows built-in)
export async function getPlaybook(db, orgId, slugOrId)
export async function createPlaybook / updatePlaybook (version++) / archivePlaybook
export function snapshotPlaybook(p: Playbook): PlaybookSnapshot
```
In `packages/verification/src/` add (new file) `playbook-policy.ts` exporting `applyPlaybookToPolicy` and the `PlaybookVerifierRequirements` type, so the verifier package owns the monotonic merge and the factory imports it.

### Built-ins (`src/factory/playbooks-builtin.ts`, new file)
| slug | maker instructions (gist) | extra criteria | verifier |
|---|---|---|---|
| `dependency-upgrade` | Upgrade only the named package(s). Update the lockfile. Fix breakages. No unrelated changes. Read the changelog for breaking changes. | "Lockfile is updated consistently with the manifest"; "Existing test suite passes" | `checksRequired: true`; `requireStages: ["security"]` |
| `test-writing` | Add tests only. Don't change production code unless a test reveals a bug (then say so). Cover edge cases. | "New tests exercise the described behaviour"; "No production-code change unless justified in the PR body" | `checksRequired: true` |
| `incident-fix` | Reproduce first (a failing test). Minimal fix. Note root cause. | "A regression test reproduces the incident and passes after the fix" | `checksRequired: true` |
| `migration` | Mechanical, incremental change. Keep behaviour identical. Update all call sites. | "No behaviour change: existing tests pass unchanged" | `checksRequired: true` |
| `code-review` | Address review feedback / review-and-fix the named area. Keep the diff focused. | "Each review point named in the description is addressed or explicitly declined" | none beyond the default |

### Flow
1. `POST /v1/tasks` accepts `playbook: "<slug or id>"` (optional). The handler resolves it (`getPlaybook`), and 404s `{code:"unknown_playbook"}` on a miss or an archived playbook. If the body has no `riskLevel`, the playbook's default applies. If the body has no `models` and the playbook has `modelPresetId`, the preset's choices are copied (reuse the existing preset→`models` code path). `TaskSpec` / `IntakeTaskInput` gain `playbook?: PlaybookSnapshot`, and `insertEngineeringTask` writes `engineering_task.playbook`.
2. **Criteria**: after extraction from the description, append the playbook criteria as `Criterion` with ids continuing the sequence (e.g. `pb-1`) and a `source: "playbook:<slug>@<version>"` field if `Criterion` allows extra fields (check `packages/verification/src/evidence/format.ts`). If it doesn't, keep the provenance in the task snapshot and record it in the report. Decision: playbook criteria **do not count** toward `needsGeneration`, so a description with zero criteria still goes through generation plus human approval (ADR-0012 is not bypassed by a template). Add a test for this.
3. **Maker**: `buildMakerPrompt` gains an optional `playbook?: {name|slug, makerInstructions}` and renders a `## Playbook: <slug> (v<n>)` section *before* "## Acceptance criteria". Output with no playbook stays byte-identical (existing tests must pass unchanged).
4. **Verifier**: in `verifying.ts`, when `task.playbook?.verifier` is non-empty, load the trusted base config the way the engine would (export a helper from the engine or `config.ts`: `resolveTrustedPolicy(execEnv, repo, subject)`) and pass `policy: applyPlaybookToPolicy(base, task.playbook.verifier)`. With no playbook, behaviour is unchanged (no `policy`). `requireStages`: the engine turns a skipped required stage into a blocking finding. Implement this as a policy field `requiredStages?: Stage[]` on `WindkeelConfig` (optional, default empty), checked where `browser`/`security` record "skipped".
5. **Evidence**: the manifest/report records `playbook: {slug, version, builtin}` and lists the checks and criteria the playbook added (`src/factory/run-report.ts`; the PR summary is in `src/github/`). This is so a reviewer can see the run was held to *more*, never less.

### API endpoints (add to `route.ts` with the existing READ/WRITE permission helpers; new permissions `playbooks.read`, `playbooks.manage` added wherever presets added `models.read/manage`. Search `models.manage` in `src/factory/tenancy.ts` and `apps/ingress/src/api/`)
- `GET /v1/playbooks` → `{ items: Playbook[] }` (built-ins first, `builtin: true`)
- `GET /v1/playbooks/:idOrSlug`
- `POST /v1/playbooks` (custom, or copy a built-in via `{ from: "dependency-upgrade", ... }`)
- `PATCH /v1/playbooks/:id` (version++; 409 `builtin_readonly` for built-ins)
- `DELETE /v1/playbooks/:id` (archive)
- `POST /v1/tasks` gains `playbook`. `GET /v1/tasks/:id` returns `playbook` (snapshot) in the task view (`api-queries.ts`).
- Errors: 400 `invalid_playbook` (with message naming the field), 404 `unknown_playbook`, 409 `builtin_readonly`, 409 `playbook_slug_taken`.

### CLI (`packages/cli`)
- `windkeel submit ... --playbook <slug>` (and the `task create` alias) → `SubmitSpec.playbook`.
- New `packages/cli/src/commands/playbook.ts`: `windkeel playbook list` (table: slug, kind, version, builtin) and `windkeel playbook show <slug>` (instructions, criteria, verifier additions). Register in `cli.ts` usage.
- MCP (`packages/cli/src/mcp/`): if a task-submit tool exists, add an optional `playbook` arg.

### Console
- Composer (`tasks/new/form.tsx`, `components/composer.tsx`): "Playbook" select (None + list from `GET /v1/playbooks`). Selecting one shows its added criteria and "Verifier will also: …" lines, read-only. Submitted as `playbook` in `actions.ts`.
- Settings: new section `playbooks` in `settings/nav.ts` + `sections.tsx` (new `playbook-sections.tsx`): list, create/edit custom, "Duplicate" built-in, archive. Gated on `playbooks.manage` (`lib/permissions.ts`).
- Run/task page: a badge "Playbook: dependency-upgrade v1" next to the source badge (`components/source-badge.tsx` pattern).
- `lib/types.ts` / `lib/api.ts` / `lib/fixtures.ts`: types, client calls, fixture data.

### Config / env
None required. Optional `WINDKEEL_PLAYBOOKS_BUILTIN=0` disables built-ins (default on). Hermetic: no network.

### Security
- Maker instructions are org-authored text sent to the maker. That's the same trust level as a task description. Cap the length and render it as data (never interpolate it into a shell).
- `extraChecks` commands run in the **verifier** sandbox. They're authored by an org admin with `playbooks.manage` (trusted, same trust as an operator policy). They are *not* from the repo head, so ADR-0004's "the head can't choose its own checks" still holds. Validate names with the existing check-name rules (`config.ts` refuses `../` names) and run them argv-style like repo checks.
- The type system plus a strict parser prevent any weakening field. Add a test that a stored row with `{"checksRequired": false}` or `{"skipStages": [...]}` is rejected on save and ignored or failed on read.
- Tenancy: every query filters on `organization_id`. A playbook id from another org → 404.

## Implementation steps
1. Add `migrations/0037_playbook.sql`. Run `test/migrate.test.js` (and update any migration list/count assertions there).
2. Add `packages/verification/src/playbook-policy.ts` (`applyPlaybookToPolicy`, `parsePlaybookVerifier`) plus `requiredStages` support in `config.ts`/`engine.ts`. Write unit tests (step 2's tests are below).
3. Add `src/factory/playbooks-builtin.ts` and `src/factory/playbooks.ts` (parse, CRUD, list merge, snapshot). Add an `EngineeringTask.playbook` field plus insert/read in `repositories.ts` and `api-queries.ts`.
4. Thread `playbook` through `TaskSpec` (`task-creation.ts`) and `IntakeTaskInput` (`src/intake/create-task.ts`). Append criteria with the `needsGeneration` rule from Design.
5. API: routes, handlers (new `apps/ingress/src/api/playbooks.ts`, modelled on `model-policy.ts`), `createTask` accepts `playbook`, permissions.
6. Maker prompt: extend `buildMakerPrompt` and the call site in `implementing.ts`.
7. Verifier wiring in `verifying.ts`. Evidence/report fields in `run-report.ts` and the PR summary.
8. CLI flag + `playbook` command + usage text.
9. Console: types/api/fixtures, composer picker, settings section, badge, lib tests, browser test.
10. Docs: a short `docs/playbooks.md` (new file) and a new ADR `docs/adr/0030-playbooks-shape-the-maker-and-only-strengthen-the-verifier.md` (Status: Proposed) stating the monotonic rule. Make sure `test/adr.test.js` passes (index/format).

### Suggested PR split (each independently mergeable, in order)
- **5a — Model + verifier merge (steps 1–4, 6–7)**: no UI. Done when the unit + e2e tests below pass via a test-only `TaskSpec.playbook`.
- **5b — API + CLI (steps 5, 8)**: done when the API/CLI tests pass.
- **5c — Console (step 9) + docs/ADR (step 10)**: done when the console lib + browser tests pass.

## Done condition
- Migration `0037_playbook.sql` (or next free number) applies cleanly on an empty DB and on one that already has 0001–0036.
- `GET /v1/playbooks` returns the 5 built-ins with `builtin: true` for a fresh org. Custom CRUD works, and is org-isolated and permission-gated.
- `POST /v1/tasks {playbook:"dependency-upgrade"}` stores a frozen snapshot on `engineering_task.playbook`. Editing the playbook afterwards doesn't change that task's snapshot.
- The maker prompt for a playbook task contains the `## Playbook:` section. A task without a playbook gets byte-identical prompt output to today.
- A playbook task's verification uses base config + playbook additions: an extra check runs and appears in the evidence, and a failing extra check fails the gate.
- No playbook can weaken verification: a test proves `applyPlaybookToPolicy(base, anything)` keeps every base check, never sets `checksRequired` false, and never removes stages. Weakening input is rejected with 400 `invalid_playbook`.
- A description with zero criteria plus a playbook still goes through generation and approval (`assertProvisionable` blocks until approved).
- `windkeel submit --playbook <slug>` and `windkeel playbook list|show` work against the API.
- The console composer can pick a playbook, and the settings page can create/duplicate/archive one.
- `npm test` is green, with `TEST_DATABASE_URL` set and unset (DB tests skip cleanly).

## How to verify the done condition
```bash
docker compose up -d                     # local Postgres
export TEST_DATABASE_URL=postgres://...  # as in docker-compose.yml / test/helpers.js
npm test                                 # full suite: must be all pass (skips only for browser if no Chromium)
npm run build && node --test test/playbook-policy.test.js test/playbooks.test.js \
  test/api-playbooks.test.js test/e2e-playbook-loop.test.js test/maker-prompt-playbook.test.js test/cli-playbook.test.js
npx playwright-core install chromium-headless-shell && npm run build && node --test test/console-playbooks-browser.test.js
(cd apps/console && npm test)            # colocated lib tests (check apps/console/package.json for the exact script)
```
Proof: every new test file reports `# fail 0`. The e2e test asserts that the evidence package lists `playbook:` checks and that the manifest records `playbook.slug`/`version`.

Manual (optional, local console): `node apps/console/scripts/local-api.mjs` + console dev server, create a task with the "Dependency upgrade" playbook, and confirm the badge plus the "Verifier will also" lines.

## Tests required

### Unit
- `test/playbook-policy.test.js` (new): extraChecks are appended and prefixed. `checksRequired:true` sets it, and absent leaves the base unchanged. Base checks are always preserved (property-style loop over a few bases × requirements). `checksRequired:false` / unknown keys (`skipStages`, `gateLevel`) are rejected by the parser. Check name `../x` is refused (reuse config rejection). Tools are capped at MAX_TOOLS. `requireStages:["browser"]` with no flows produces a blocking finding (engine-level, using the `test/verify.test.js` pattern).
- `test/playbooks.test.js` (new, DB-gated parts with `skip`): built-ins list (5, stable slugs). Org slug shadows a built-in. Create/update bumps the version. Archived playbooks are hidden and their slug is reusable. Cross-org get → null. Snapshot is decoupled (update after the task is created and assert the task is unchanged). Length caps.
- `test/maker-prompt-playbook.test.js` (new) or extend the existing implementing-handler tests (`test/workflow-stages-implement.test.js`): no-playbook output is identical to a golden string. The playbook section renders before the criteria. Instructions are rendered as plain text.
- Criteria: extend `test/criteria-gate.test.js`/`test/issue-intake.test.js`: playbook criteria are appended with provenance. Zero extracted + playbook → `needsGeneration` true and provisioning is blocked until approved.
- `test/api-playbooks.test.js` (new, pattern from `test/model-presets.test.js` / `test/api-endpoints.test.js`): routes are present with the right permissions (`playbooks.read`/`manage`). 400/404/409 codes. `POST /v1/tasks` with an unknown playbook → 404. Default risk + preset copy applied only when the body omits them. Idempotency key behaviour unchanged.
- `test/cli-playbook.test.js` (new, pattern from `test/cli-remote.test.js` / `test/cli-models.test.js` with a fake `WindkeelApi`): `--playbook` is sent, list/show formatting, and an unknown playbook prints the refusal with exit 1.
- Console: `apps/console/lib/playbooks.test.ts` (new): mapping API → picker options, "Verifier will also" line rendering, permission gating.

### Integration / e2e
- `test/e2e-playbook-loop.test.js` (new): copy the `test/e2e-github-loop.test.js` / `test/e2e-factory-loop.test.js` setup (`test/factory-stack.js`, `FakeSandboxProvider`, `FakeGitHubClient`, fake worker, real Postgres, gated on `TEST_DATABASE_URL`). Cases:
  1. A custom playbook with `extraChecks:[{name:"lint-strict",command:"exit 0"}]` → run reaches PR_READY. The evidence has a `playbook:lint-strict` check. The manifest has `playbook.slug`. The fake worker received a prompt containing `## Playbook:`.
  2. Same, with `command:"exit 1"` → the gate fails and the run goes to repair/fails exactly as for a failing repo check (no special path).
  3. A repo whose base `windkeel.config.json` has a check, plus a playbook → both checks run (base preserved).
  4. The playbook is edited mid-run → the run still uses its snapshot.
- Verification boundary: extend `test/verification-boundary.test.js` or `test/gate-isolation.test.js` to assert that the playbook verifier config can't come from the candidate head (it is passed as `policy` built from base + DB snapshot only).

### Browser
- `test/console-playbooks-browser.test.js` (new, pattern from `test/console-models-browser.test.js` with `browserSkip()` from `test/console-browser.js`): open the composer, pick "Dependency upgrade", see the added criteria and verifier lines, submit, and confirm the API received `playbook`. Settings → Playbooks → duplicate a built-in, edit the instructions, save, and see the new version number.

## Risks & open questions
1. **Do playbook criteria count as "extracted" (author) criteria?** Default: **no**. They are added, but zero author criteria still triggers generation plus approval. Needs a human to confirm. The alternative (count them) would let a template skip ADR-0012 approval.
2. **Can org admins add arbitrary `extraChecks` commands?** Default: yes, with `playbooks.manage` only, run in the verifier sandbox argv-style. Flag for a security review: it's operator-trusted code in the verifier.
3. **Built-ins in code vs seeded rows.** Default: code (improvable by deploy, snapshotted with version). Org copies are rows.
4. **Built-in prompt wording** needs product/human review. Ship as v1 and iterate.
5. **Migration number collision** with sibling items (02, 03, 08 may also add migrations). Take the next free number at merge time.
6. **Criterion shape**: if `Criterion` in `evidence/format.ts` can't carry `source`, the provenance lives only in the task snapshot and report. Don't change the evidence format version without an ADR.
7. **Pure "code review" without a maker** (review a human PR) is a different product mode, and is out of scope here. Default: the built-in is "review-and-fix".

## Suggested labels and dependencies
- Labels: `ready-for-agent` for 5a and 5b. `ready-for-human` for open questions 1–2 (a quick sign-off before 5a merges; defaults above let the agent proceed). Also `enhancement`.
- Blocked-by: none hard. Soft relations: **03-repo-knowledge-memory** (both edit `buildMakerPrompt`; whichever lands second rebases, and the order of sections is knowledge → playbook → criteria). **04-intake-slack-linear-jira-sentry** (later maps an intake label or Sentry alert → the `incident-fix` playbook). **06-parallel-and-batch** (a batch can apply one playbook to N repos). **10-multi-harness** (a playbook's preset may name a harness, using the existing ADR-0027 checks).
