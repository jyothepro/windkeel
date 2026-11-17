# Multiple maker harnesses, proven live: Claude Code (then OpenCode) alongside Codex

> ADR and migration numbers below are placeholders: use the next free number in `docs/adr/` and `migrations/` when implementing.

> Epic. Too big for one PR, so it is split into sub-tasks **A–G** below, one PR each. Each has
> its own done condition and tests. Implement in order unless the dependency notes say otherwise.

## Why

Devin AI and Factory.ai each ship one agent loop of their own. Customers increasingly want to
**pick the coding agent**: "codex, claude code or open code" (user's words, ADR-0027 Context), and
BYOK customers already hold Anthropic keys they cannot use for Windkeel's maker today. Windkeel can be
the agent-neutral factory: any maker harness, every change judged by the **same independent
verifier**. That is Windkeel's edge, and ADR-0029's rule stands: **there is no path around
verification**. A new harness is just another maker. Its output goes through the same
CRITERIA → VERIFYING → merge-eligibility gates, and the checker stays a different vendor from the
maker's model (ADR-0010 §3, ADR-0026 §5).

## Background the implementer needs

### Current architecture (real paths on `main`)

- **Worker seam**: `src/worker/adapter.ts` defines `WorkerAdapter`, `WorkerEvent`, `WorkerUsage`,
  `WorkerModelRoute`, `WorkerStartInput`, `WorkerSession`, `WorkerResult`, `WorkerDiff`,
  `WorkerPoll`, `WorkerAdapterCapabilities`, `WorkerSessionRef`, and the errors
  `WorkerNotReattachableError`, `WorkerSessionGoneError`, `WorkerRouteChangedError`.
- **Only adapter**: `src/worker/codex/adapter.ts` (`CodexWorkerAdapter`, `PINNED_CODEX_VERSION =
  "0.154.0"`, `DEFAULT_MODEL_API_DOMAIN`, `CODEX_PROVIDER_ENV_KEY = "CODEX_API_KEY"`,
  `codexModelArgs`, `CodexAdapterOptions`, `CodexSessionState`, `turnPaths`). The event normaliser
  is in `src/worker/codex/events.ts`, and result/diff extraction (`extractDiff`) is in
  `src/worker/codex/result.ts`.
- **Shared helpers**: `src/worker/command-classification.ts` (`classifyCommand` → test_started/
  test_finished) and `src/worker/watermark.ts` (`WatermarkedLineReader`, `readWatermarkedLines`).
- **Fakes**: `src/worker/fake.ts` (`FakeWorkerAdapter`, replays a recorded event stream) and
  `src/worker/scripted.ts` (`ScriptedWorkerAdapter`, `ScriptedTurn`). Sandbox fakes are in
  `src/sandbox/fake.ts`. The GitHub fake is used by `test/e2e-github-loop.test.js`.
- **Wiring**: `src/factory/stage-wiring.ts` builds a single `new CodexWorkerAdapter(...)` into
  `StageDeps.worker` (an override `worker?: WorkerAdapter` exists for tests). It also has
  `codexAdapterOptions(config)` and `assertCodexAvailableLocally`. `deps.worker` is referenced in
  about 14 places under `src/`.
- **Harness list**: `src/factory/harnesses.ts` holds `HARNESS_SHAPE`, `HarnessInfo`, and
  `enabledHarnesses(env)`, which reads `WINDKEEL_MAKER_HARNESSES` (default `codex`) and
  `WINDKEEL_DEFAULT_MAKER_HARNESS`. Its labels are `codex`, `claude-code` → "Claude (Anthropic)", and
  `opencode`.
- **Config**: `src/factory/worker-config.ts` (`WorkerConfig`, about 390 lines; it already has a
  `vendor: "anthropic"` branch around line 259).
- **Model policy**: `src/factory/model-policy.ts` parses `harness` on maker entries (lines
  ~181–193) and **refuses any harness other than the deployed one at intake** with
  `harness_unavailable` (lines ~539–547). The snapshot is written at ~574 as `maker: {...,
  worker}`. The table is `migrations/0030_model_policy.sql`, which has **no `harness` column
  yet**. Presets (`migrations/0033_model_preset.sql`) already have a `harness` column.
- **Maker route**: `src/factory/workflow/maker-route.ts:101` throws `MakerRouteError` for
  `provider === "anthropic"`. That is the blanket refusal ADR-0027 §4 narrows to Codex only.
- **Stage handlers that use the worker**: `src/factory/workflow/handlers/{provisioning,implementing,repairing,human-editing}.ts`.
- **Credential broker**: `src/sandbox/credential-broker.ts` (`CODEX_API_KEY_PLACEHOLDER =
  "brokered-do-not-use-directly"`). `src/sandbox/vercel.ts:541` injects `CODEX_API_KEY`. Network
  phases are in `src/sandbox/network-phase.ts` (`executionPhasePolicy` = `[modelApiDomain]`
  only). Provider auth headers are in `src/factory/model-credential-providers.ts` (`anthropic`:
  `x-api-key` plus `anthropic-version`).
- **Catalog**: `packages/verification/src/providers/catalog.ts` holds provider protocols and
  pricing (`ModelPricing`).
- **Transcript capture**: `src/factory/run-capture.ts` (`captureObjectKey`, `MAX_ARTEFACT_BYTES`;
  `POST /v1/runs/{id}/capture`, `windkeel capture`). It currently says "Only the Codex adapter keeps
  one" (line ~162). Related: `src/factory/workflow/session-binding.ts` and
  `test/transcript-binding.test.js`.
- **Data**: `agent_run.worker_type` (`migrations/0001_factory_schema.sql`) and
  `worker_session_binding.worker_type` (`migrations/0014_worker_session_binding.sql`).
- **API docs**: `docs/control-plane-api.md` (model policy section, `harnesses` on `GET
  /v1/model-policy`, `422 harness_unavailable`).
- **Console**: `apps/console` (Next.js). Browser tests follow `test/console-browser.js`
  (playwright-core).

### ADRs (read them; 1–2-line summaries)

- **ADR-0004**: the verifier is independent; the diff comes from the workspace, never from the
  agent's self-report.
- **ADR-0006**: Codex was the first worker; the orchestrator owns timeouts; the CLI version is
  pinned. §5 (OpenHands next) is amended by ADR-0027.
- **ADR-0016**: hermetic local dev. CI never touches real external services; live checks are
  opt-in, manual/env-gated.
- **ADR-0020 / 0021**: Vercel Workflow orchestration. Steps carry serialisable refs only and have
  an event ceiling (0021 §5), so adapters must be reattachable and pollable across invocations.
- **ADR-0027 (Accepted 2026-10-24)**: **the source of truth for this epic.** The harness is part of the maker
  choice (§1) and is frozen into the run snapshot as `maker.harness {id, version}` (§2). §3 has
  11 conformance obligations plus a capability matrix. §4 is the harness⇄provider table and
  independence. §5 covers egress/telemetry switches per harness. §7 is per-harness version
  descriptors. §8 is usage normalisation (cache writes). §9 is API/console. §10 is rollout order.
  "Accepted only after" lists the live checks.
- **ADR-0029**: Windkeel is an integrated assistant, but the verifier stays the gate. No harness gets
  a bypass.
- Also relevant: ADR-0010 (maker/checker policy), ADR-0011 §2 (repair resumes the same session),
  ADR-0014 (no keys in the sandbox; one egress host), ADR-0017 §3, and ADR-0026 (BYOK snapshot;
  #318 is the live spike).

### Conventions

- Tests are `node --test` over `test/*.test.js` and import from `../dist/...`. `npm test` cleans,
  builds and runs everything. To run one file: `npm run build && node --test test/<file>.test.js`.
- Postgres-backed tests are gated on `TEST_DATABASE_URL` (see `test/e2e-github-loop.test.js:57`)
  and skip without it.
- Fixtures are in `test/fixtures/<harness>/*.jsonl` (the existing Codex ones are hand-authored:
  `successful-session`, `failed-turn`, `resumed-turn`, `malformed-and-unknown`).
- Migrations are `migrations/NNNN_name.sql`. Latest on main is `0036_run_merge_claim.sql`. Other
  backlog items also plan `0037_*`, so **take the next free number when you open the PR**.
- Report and docs style: concise. Update `docs/control-plane-api.md` and `research/MILESTONES.md`
  M11 when behaviour changes.

## Scope

**In:** ADR-0027 rollout steps 1–6: selection plumbing; the conformance suite; a Claude Code
adapter; API and console; an OpenCode adapter; cross-harness e2e; per-harness transcript capture;
a live proof per harness.

**Out of scope:** Eve (#339/#340), OpenHands, Bedrock/Vertex, harness routing or fallback mid-run,
a harness for the checker, AI Gateway as a provider (ADR-0026 §8), and sandbox snapshots per
harness (item 02-environment-snapshots).

## Design

### Data model

- New migration `NNNN_model_policy_harness.sql`: `alter table model_policy add column harness
  text check (harness is null or harness ~ '^[a-z][a-z0-9-]{0,31}$')`, plus a check that
  `harness is null or role = 'maker'`. Null means the operator default.
- No new column on `agent_run`: `worker_type` already holds the harness id. The snapshot
  `RunModelConfig.maker` gains `harness?: { id: string; version: string }`. A missing value is
  read as `{ id: "codex", version: <deployment pin> }`.
- Optional (decide in sub-task D): record `harnessReportedCostUsd` in the agent run's metadata
  for comparison only (§8). Never feed it to the ledger.

### Interfaces

- New file `src/worker/registry.ts`: `WorkerRegistry = ReadonlyMap<string, WorkerAdapter>` and
  `workerFor(deps, snapshot): WorkerAdapter`. If the harness is missing, it throws a named error
  that the stage maps to `stop_reason = 'model_policy'`.
- `StageDeps.worker` becomes `StageDeps.workers` (keep a test override, `workers?:` /
  `worker?:` wrapped into a single-entry map).
- New file `src/worker/descriptor.ts`: `HarnessDescriptor { id, binary, pinnedVersion,
  versionEnvVar, allowDriftEnvVar, installSpec, protocols: ("openai-responses" |
  "anthropic-messages")[], keyEnvVars: string[] }`. Codex's descriptor is built from its existing
  constants.
- `WorkerAdapterCapabilities` gains `pollable`, `reportsUsage`, `reportsFileChanges` and
  `providers` (ADR-0027 §3 table).
- `WorkerUsage` gains `cacheWriteInputTokens?`. `ModelPricing` gains
  `usdPerCacheWriteInputToken?`.
- The catalog provider gains `authHeader` (`authorization` | `x-api-key`). The broker reads it.
- New files `src/worker/detached.ts` (the setsid/background/JSONL-to-scratch launcher, extracted
  from Codex) and `src/worker/diff.ts` (`extractDiff` moved from `codex/result.ts` and re-exported
  there for compatibility).
- New directories `src/worker/claude-code/{adapter,events,result}.ts` and
  `src/worker/opencode/{adapter,events,result}.ts`.

### API

- `PUT /v1/model-policy` accepts `harness` on maker rows. It returns `422 harness_unavailable` if
  the harness is not enabled, and `422`/`ModelPolicyError` if the pair is incompatible.
- New: `GET /v1/harnesses` (`models.read`) → `{ items: [{ id, label, default, version,
  protocols, providers }] }`.
- `POST /v1/tasks` `models.maker.harness` already parses. Intake now accepts any registered
  harness.

### Console

Settings → Models maker section: an **Agent** select above the model, showing only enabled
harnesses (others disabled, "not enabled on this deployment"). The provider and credential lists
filter by compatibility. The independence warning is extended. The run's Models panel shows
"<label> <version>". Use descriptive plain-text labels only; keep "Claude (Anthropic)" until the
branding check (Risks).

### Config / env

- `WINDKEEL_MAKER_HARNESSES` and `WINDKEEL_DEFAULT_MAKER_HARNESS` already exist.
- New: `WINDKEEL_CLAUDE_CODE_VERSION`, `WINDKEEL_ALLOW_CLAUDE_CODE_VERSION_DRIFT`,
  `WINDKEEL_OPENCODE_VERSION`, `WINDKEEL_ALLOW_OPENCODE_VERSION_DRIFT`, `WINDKEEL_HARNESS_INSTALL=pinned`
  (optional install-phase `npm i -g`), and `WINDKEEL_MAKER_KEY_ENV_VAR_<PROVIDER>` (falls back to
  today's single variable).
- Operator checker defaults become an ordered list across ≥2 vendors (ADR-0027 §4).

### Security (non-negotiable)

- One egress host in the execution phase.
- The key placeholder only (`CODEX_API_KEY_PLACEHOLDER` value under the harness's variable).
- An isolated config home in scratch (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, OpenCode `HOME`/XDG).
- Claude Code: `--bare`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY`,
  `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `skipWebFetchPreflight`, and
  WebFetch/WebSearch/MCP disallowed. The permission mode bypasses prompts inside the microVM.
  Refuse a turn whose `system/init` reports a non-API-key auth source.
- OpenCode: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, plus the
  §5 list; `run --format json`, never `serve`.
- Resume only by explicit session id, never `--continue`/`--last`.
- The diff always comes from the workspace.

## Implementation steps (overview, see sub-tasks for detail)

1. A: selection plumbing (codex only).
2. B: shared launcher, diff, and conformance suite against Codex and the fakes.
3. C: Claude Code adapter plus fixtures, passing conformance.
4. D: provider compatibility, broker header, usage/cost, and checker default list.
5. E: API and console.
6. F: transcript capture per harness, cross-harness e2e, doctor.
7. G: live proof per harness (human-run), then the OpenCode adapter (G2).

---

### Sub-task A — Harness selection plumbing, codex only (ready-for-agent)

Steps:

1. Add migration `NNNN_model_policy_harness.sql` (above). Persist and read `harness` in
   `model-policy.ts` load/save.
2. Add `harness: {id, version}` to `RunModelConfig.maker` at intake (CLASSIFYING). Keep
   `maker.worker === harness.id`.
3. Add `src/worker/registry.ts` and `src/worker/descriptor.ts`. Convert `StageDeps.worker` →
   `workers` in `stage-wiring.ts`, and make all `deps.worker` uses go through `workerFor`.
4. Replace the "only the deployed harness" refusal (~line 539) with "must be registered and
   enabled". A harness that was disabled later causes an intake failure with `model_policy`.
5. Make the in-sandbox version check compare against the snapshot `version`.

**Done:** every existing test passes unchanged in behaviour. A policy row with
`harness='claude-code'` on a codex-only deployment is refused `harness_unavailable`. A snapshot
without `harness` runs Codex. `grep -rn "deps\.worker\b" src` returns nothing.

**Tests:**
- New `test/worker-registry.test.js`: lookup, a missing harness raises the named error, the
  legacy-snapshot default.
- Extend the model-policy tests (find them with `grep -l model-policy test/`): a harness on a
  checker row is refused; harness null inherits; a layer setting only a model inherits the
  harness.
- PG-gated: the migration applies, the check constraint rejects a checker harness and a bad shape.
- `test/e2e-factory-loop.test.js` still green.

### Sub-task B — Shared launcher, diff, and conformance suite (ready-for-agent)

Steps:

1. Extract `src/worker/detached.ts` and `src/worker/diff.ts` from the Codex adapter with no
   behaviour change.
2. Add the new capability flags. Codex declares them all true and `providers:
   ["openai","openrouter","openai-compatible"]`.
3. Create a conformance suite as new test files `test/worker-conformance-*.test.js` (the runner
   globs `test/*.test.js`, so ADR-0027's `test/worker-conformance/` directory would not run: put
   shared helpers in `test/worker-conformance/suite.js` and a thin `*.test.js` per adapter). It
   takes `(name, makeAdapter, fixtures, fakeBinary)` and asserts obligations §3.1–3.11:
   - detached launch, stdout to scratch outside the checkout;
   - `poll()` idempotent with no new output;
   - exactly one terminal event per turn;
   - `started.sessionId` set;
   - `reference()`/`attach()` round-trip in a "new process" (fresh adapter instance), and attach
     with the wrong `workerType` → error;
   - resume uses an explicit session id (assert argv contains the id and none of
     `--continue`/`--last`);
   - diff from the workspace even when the harness self-reports differently;
   - `useRoute()` with a changed model → `WorkerRouteChangedError`;
   - the env contains no broker-resolved secret, only the placeholder;
   - an isolated config home inside scratch;
   - a hostile checkout (`.claude/settings.json`, `.mcp.json`, `opencode.json`, `.opencode/`,
     `.codex/`, `.agents/skills/`, `AGENTS.md`) → the required ignore flags are present in
     argv/env;
   - `cancel()` kills the process group;
   - a version mismatch → named failure, unless the drift env var is set;
   - a `reportsUsage` adapter with a usage-less `completed` fails the turn.
4. The fake harness binary is a small Node script (new file `test/fixtures/fake-harness.mjs`)
   that replays a fixture JSONL to stdout and records its argv/env to a file. Run it with
   `FakeSandboxProvider` from `src/sandbox/fake.ts`.

**Done:** the suite passes for Codex. The fakes are run through the suite with production-only
obligations marked as expected-ineligible (they declare `reattachedSessionsAcceptNewTurns:
false`). All existing `worker-codex-*.test.js` tests are green.

**Verify:** `npm run build && node --test test/worker-conformance-codex.test.js`.

### Sub-task C — Claude Code adapter (ready-for-agent; blocked by B)

Steps:

1. Add `src/worker/claude-code/adapter.ts`. Launch: `claude -p --bare --output-format
   stream-json --verbose --model <model> [--resume <session_id>]`. Pass the prompt on stdin.
   Disallow WebFetch/WebSearch/MCP. Set the env from Security above, with `ANTHROPIC_API_KEY` =
   placeholder, `ANTHROPIC_BASE_URL` only when the route has a base URL, and `CLAUDE_CONFIG_DIR`
   in scratch.
2. Add `events.ts`, which maps `system/init` → `started` (and checks the auth source),
   `assistant` text → `message`/`thinking`, Bash tool_use/tool_result → `command_started`/
   `command_finished` through `classifyCommand`, Edit/Write tool_use → `file_changed`, `result`
   success → `completed` with usage, and error/`is_error` → `failed`. `system/api_retry` and
   `permission_denied` → `failed` or diagnostic, never passthrough. Unknown types are ignored
   (like Codex's malformed fixture).
3. Usage: `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`,
   `cachedInputTokens = cache_read`, `cacheWriteInputTokens = cache_creation`, `outputTokens`.
   Keep `total_cost_usd` aside for comparison only.
4. Add a descriptor with a pinned version (the `stable` npm version on the day you implement;
   ADR-0027 read 2.1.292). The check is `claude --version`.
5. Register it in `stage-wiring.ts` when `enabledHarnesses()` includes `claude-code`.
6. Add hand-authored fixtures in `test/fixtures/claude-code/`: `successful-session.jsonl`,
   `failed-turn.jsonl`, `resumed-turn.jsonl`, `malformed-and-unknown.jsonl`,
   `oauth-auth-source.jsonl`. Mark them hand-authored until G replaces them.

**Done:** `test/worker-conformance-claude-code.test.js` passes. The default deployment
(`WINDKEEL_MAKER_HARNESSES` unset) registers only codex.

**Tests:**
- New `test/worker-claude-code-events.test.js`: every mapping above; a stream truncated mid-line
  (watermark); two `result` lines → only one terminal event; the OAuth source → refused.
- New `test/worker-claude-code-usage.test.js`: the cache add-back arithmetic and zero/absent
  fields.
- New `test/worker-claude-code-adapter.test.js`: the argv contains `--bare` and `--resume <id>`
  on turn 2; the env has no real key; repo hooks are ignored.

### Sub-task D — Provider compatibility, broker header, cost (ready-for-agent; blocked by A)

Steps:

1. Make `maker-route.ts`'s anthropic refusal apply only to the codex harness. Add the compat check
   (harness `providers` ⇄ catalog protocol) at policy write and at intake (`ModelPolicyError`).
2. Add `authHeader` to catalog providers. `credential-broker.ts` uses it (Anthropic → `x-api-key`
   plus `anthropic-version` as in `model-credential-providers.ts`). The placeholder env var name
   comes from the descriptor `keyEnvVars`.
3. Pricing: add `usdPerCacheWriteInputToken` for Anthropic models. `modelCostUsd` charges cache
   writes at that rate, never below the base rate.
4. The operator checker default becomes an ordered list. Intake takes the first independent one.
   `windkeel doctor` warns when no independent checker exists for an enabled harness.
5. Per-provider operator maker key: `WINDKEEL_MAKER_KEY_ENV_VAR_<PROVIDER>`.

**Done:**
- claude-code + anthropic is accepted.
- codex + anthropic is refused.
- claude-code + openai is refused.
- An Anthropic maker with an Anthropic-only checker list → `NoIndependentProviderError`; with an
  `[anthropic, openai]` list it picks openai.
- The broker test proves `x-api-key` is injected for the anthropic host and nothing else.

**Tests:**
- Extend `test/sandbox-credential-broker.test.js`: one case per protocol, and a non-Authorization
  header value passed verbatim.
- New `test/harness-provider-compat.test.js`: a table-driven test over §4.
- Cost: add cases in the existing cost-ledger test file (`grep -l modelCostUsd test/`) for cache
  writes.
- Independence: a case in the model-policy tests.

### Sub-task E — API + console (ready-for-agent; blocked by A, D)

Steps:

1. Add `GET /v1/harnesses` next to the existing model-policy routes (grep `model-policy` in
   `apps/ingress` and `src/` for the router). `PUT /v1/model-policy` gets `harness` with
   validation. Update `docs/control-plane-api.md`.
2. Console: add the Agent select in Settings → Models (org and repo override) with filtered
   provider/credential lists and the independence warning. Show "<label> <version>" in the run's
   Models panel. Hide the picker when only one harness is enabled (current behaviour).

**Done:** the API contract matches the docs. The console shows the picker only with ≥2 harnesses,
and saving claude-code + an openai model shows an error.

**Tests:**
- An API test for `GET /v1/harnesses` (scope `models.read` required; a 403 without it) and
  `PUT` 422 cases.
- Browser: extend the `test/console-browser.js` patterns. With
  `WINDKEEL_MAKER_HARNESSES=codex,claude-code`, select Claude, check that the provider list contains
  only Anthropic, save, reload, and confirm it persisted. With a single harness, the picker is
  absent.

### Sub-task F — Transcript capture per harness + cross-harness e2e (ready-for-agent; blocked by C)

Steps:

1. Generalise `src/factory/run-capture.ts` so the adapter exposes its scratch paths (add an
   optional `transcriptPaths(ref)` on the adapter or the descriptor). Capture JSONL, stderr, exit
   status and diff for any harness. The manifest records `harness.id`/`version`. Remove the "Only
   the Codex adapter keeps one" text.
2. New `test/e2e-multi-harness.test.js`: one task per registered harness (codex, claude-code)
   using fake binaries plus `FakeSandboxProvider` plus `FakeGitHubClient`, real stages, through
   IMPLEMENTING → a forced verifier failure → REPAIRING (resume by id) → VERIFYING → PR. Assert
   `agent_run.worker_type`, the snapshot harness, the same verifier path (ADR-0029: no bypass),
   cost recorded > 0, and that changing the org policy mid-run does not change the run's harness.
   Use the PG-gated pattern from `test/e2e-github-loop.test.js`.
3. `windkeel doctor` runs `--version` for every enabled harness.

**Done:** `windkeel capture` on a claude-code run yields its stream-json transcript. The e2e passes
locally with `TEST_DATABASE_URL`.

**Tests:**
- Extend `test/run-capture.test.js` (a claude-code ref and an artefact over the cap).
- Extend `test/transcript-binding.test.js` if binding changes.
- Add the new e2e file.

### Sub-task G — Live proof per harness (ready-for-human), then G2 OpenCode (ready-for-agent)

G1 (human/operator, following ADR-0016: manual, never in CI):

1. On a staging deployment with `WINDKEEL_MAKER_HARNESSES=codex,claude-code` and an Anthropic BYOK
   credential, submit a trivial task to the scratch repo (the same one 01-live-proof uses) per
   harness.
2. For Claude Code, force a repair turn resumed from a different invocation, and kill a turn
   mid-way and measure resume (as #340 does for Codex).
3. Run `windkeel capture <run-id>`. Record the egress log showing only `api.anthropic.com` (and
   which paths), the key brokered as `x-api-key`, and the placeholder in env.
4. Commit the real transcripts as `test/fixtures/claude-code/live-*.jsonl` (redacted; run-capture
   never contains keys) and make the normaliser tests pass on them.
5. Write `research/spikes/multi-harness-live/findings.md` (new) and update ADR-0027 status and
   `research/MILESTONES.md` M11.

G2: the OpenCode adapter, the same as C, using `opencode run --format json --model provider/model
--session <id>`, summing `step_finish` tokens, with config passed via `OPENCODE_CONFIG_CONTENT`
and the hostile-checkout flags. Before enabling it, run a live check that a hostile checkout
loads nothing and runs no `npm install`.

**Done:** each harness has ≥1 live run that produced a verified PR (or a correctly
verifier-rejected candidate), with a captured transcript committed as a fixture and a findings
doc. Conformance is green for codex, claude-code and opencode.

## Done condition (epic)

- Sub-tasks A–G merged; `npm test` green.
- Conformance suite passes for codex, claude-code and opencode. The fakes are marked ineligible.
- Default deployment behaviour is unchanged (codex only, picker hidden).
- With `WINDKEEL_MAKER_HARNESSES=codex,claude-code`, an org can pick Claude Code. The run snapshot
  freezes `{id, version}`, and a repair resumes the same harness, session and version.
- Every harness's output goes through the same verifier gates. Independence is enforced on the
  model vendor.
- No sandbox env contains a real key. Execution egress is one host.
- Live findings doc plus real transcript fixtures per harness. ADR-0027 moved to Accepted (if
  ADR-0026/#318 is also accepted).

## How to verify the done condition

- `npm test`: everything passes. With PG: `TEST_DATABASE_URL=postgres://... npm test` (the e2e
  and migration tests run instead of skip).
- Focused:
  `npm run build && node --test test/worker-conformance-*.test.js test/worker-claude-code-*.test.js test/harness-provider-compat.test.js test/e2e-multi-harness.test.js`.
- `grep -rn "deps\.worker\b" src` → empty.
- `grep -n anthropic src/factory/workflow/maker-route.ts` → the refusal is conditioned on codex.
- Browser: run the `test/console-browser.js` flow with two harnesses enabled.
- Live (human): the findings doc lists run ids, the egress host list, the resume-from-another-
  process result, and the crash-resume measurement.

## Tests required (summary)

- **Unit:** `worker-registry`, `worker-conformance-{codex,claude-code,opencode}`,
  `worker-claude-code-{events,usage,adapter}`, `worker-opencode-{events,usage,adapter}`,
  `harness-provider-compat`, broker per-protocol cases, cost cache-write cases, model-policy
  harness layering and independence, and `run-capture` per harness.
  - Edge cases: torn last line, duplicate terminal events, unknown event types, usage-less
    completion, OAuth auth source, version drift with and without the override, attach with a
    mismatched workerType, a hostile checkout, a harness disabled mid-run.
- **Integration/e2e:** `test/e2e-multi-harness.test.js` (PG-gated, fakes) and the PG migration
  test. The existing `e2e-factory-loop`, `e2e-repair-loop`, `e2e-github-loop` and `e2e-m9-byok`
  must stay green.
- **Browser:** Agent picker visibility, filtering, persistence, and the Models panel label.

## Risks & open questions

1. **Branding**: may we label it "Anthropic's Claude Code CLI"? Default: keep "Claude
   (Anthropic)" until a human checks Anthropic's terms (needs human).
2. **Telemetry to `api.anthropic.com`** on customer keys: can config fully disable it? Default:
   ship disabled, behind `WINDKEEL_MAKER_HARNESSES`, until G1 records the paths.
3. **Pinned versions**: which Claude Code/OpenCode version? Default: npm `stable` on the
   implementation day, refusing drift.
4. **Checker default list** changes ADR-0010 §2 behaviour for operators. Default: `[anthropic,
   openai]`, with doctor warnings.
5. **Migration number collisions** with other backlog items. Default: the next free number at PR
   time.
6. **ADR-0026 still Proposed (#318)**: G's acceptance depends on it. Do not block A–F.
7. Cache-write pricing values need a human to confirm against current Anthropic pricing.

## Suggested labels and dependencies

- Epic: `ready-for-agent` (A–F, G2). G1 live proof: `ready-for-human`.
- Order: A → B → C → (D in parallel after A) → E → F → G1 → G2.
- **Blocked by:** `01-live-proof` (G1 reuses its scratch repo, capture procedure and Codex live
  fixtures). Soft: `08-enterprise-readiness` (audit of policy changes, if it lands first). Related:
  `02-environment-snapshots` (§7.3 snapshot per harness version, deferred), `06-parallel-and-batch`
  (comparison runs across harnesses), `05-agent-types-playbooks` (playbooks may pin a harness).
- Upstream issues: #365 (G15 harness selection), #318 (BYOK live), #339/#340 (Eve; out of scope),
  #116/#196/#197 (Codex transcript, reattach, poll).
