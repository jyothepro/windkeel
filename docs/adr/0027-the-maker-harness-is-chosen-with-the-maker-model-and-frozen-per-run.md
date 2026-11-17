# ADR-0027: The maker harness is chosen with the maker model, per organization and repository, and frozen per run

- Status: Accepted
- Date: 2026-10-16

## Context

The goal, in the user's words: *"Ideally I want someone to configure if they want codex, claude code or open code or eve etc."* An organization — and, for some repositories, the repository — chooses the **maker harness**: the agent program that edits the checkout inside the maker sandbox.

## Decision

- §1 — The harness is part of the maker choice, not a setting of its own.
- §2 — It is frozen into the run snapshot, beside the model.
- §3 — The contract every harness adapter meets.
- §4 — Harness ⇄ provider compatibility, and independence.
- §5 — Egress and security, per harness.
- §6 — Eve is not a maker harness, and OpenHands is deferred.
- §7 — Install and version pinning.
- §8 — Cost accounting.
- §9 — Console and API.
- §10 — Rollout and recommendation.

## Consequences

- **"Which agent" becomes data, like "which model".** A run records the harness and version it ran on; a policy change mid-run changes nothing; two runs on one warm instance can use different harnesses, as they can already use different vendors.
- **The deployment grows one adapter per enabled harness**, and `StageDeps.worker` becomes a registry.
- **ADR-0010 §2's single Anthropic checker default ends.** Operators need checker keys for two vendors to offer both an OpenAI-model maker and an Anthropic-model maker on defaults.
- **Anthropic becomes a maker vendor.** The independence filter already handles it; the console's mirrored vendor table must stay in step.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-16
- Accepted on 2026-10-24 by the maintainer, with rollout steps 1–3 landing in #407 (#395 A–D). The live proof of the Claude Code adapter in a real sandbox (#395 G1) is still open.
- Milestone: 11 (Second worker and routing)
- Amends: [ADR-0006](0006-codex-is-the-first-worker.md) §5,
  [ADR-0010](0010-maker-checker-model-policy-pre-byok.md) §2,
  [ADR-0026](0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md) §4, §7, §10

### Context

The goal, in the user's words: *"Ideally I want someone to configure if they want codex, claude
code or open code or eve etc."* An organization — and, for some repositories, the repository —
chooses the **maker harness**: the agent program that edits the checkout inside the maker sandbox.
This ADR calls it a *harness* to keep it apart from the *model* (what it calls) and the *worker*
(the `WorkerAdapter` that drives it); one adapter drives one harness.

What exists on `main` (0b9daeb):

- **One adapter per deployment.** `StageDeps.worker` is a single `WorkerAdapter`, built in
  `src/factory/stage-wiring.ts` as `new CodexWorkerAdapter(...)`. ADR-0006 made Codex the first
  worker and named OpenHands as the "leading candidate" for the second (§5);
  `research/MILESTONES.md` M11 still says so.
- **The seam was written for a second harness.** `src/worker/adapter.ts` has no auth field
  (ADR-0014 §1), no budget (ADR-0006 §3), a serialisable `WorkerSessionRef` whose `workerType`
  must match on `attach()` (#196), `poll()` for 800 s Workflow steps (#197), `useRoute()` that
  refuses a different model on a resumed turn (ADR-0011 §2), and a `WorkerDiff` taken from the
  workspace, not the agent (ADR-0004). Capabilities are three flags.
- **The run snapshot already has a slot.** `RunModelConfig.maker.worker`
  (`src/factory/model-policy.ts`) is filled from `deps.worker.name` at intake and read by
  `makerRouteFor`/`makerModelFor` to set `agent_run.worker_type`. The console's run Models panel
  already prints "driven by {worker}".
- **The maker route refuses Anthropic.** `maker-route.ts` throws `MakerRouteError` for
  `provider: "anthropic"` citing ADR-0026 §10: Codex speaks OpenAI's wire formats, and "Claude as
  the maker is M11's second worker". The console's maker legend says the same.
- **The broker injects one header per domain.** `credential-broker.ts` attaches `Authorization:
  Bearer …` (or any named header verbatim) on the model domain; the sandbox holds
  `CODEX_API_KEY_PLACEHOLDER`. Execution-phase egress is `[modelApiDomain]` and nothing else
  (`network-phase.ts` `executionPhasePolicy`).
- **The sandbox image already ships three harnesses.** Vercel Sandbox's default `universal`
  image preinstalls Codex CLI, Claude Code and OpenCode (`research/vercel-sandbox/findings.md`
  §5, §7). Codex is version-*checked*, not installed: `PINNED_CODEX_VERSION = "0.154.0"`,
  overridable by `WINDKEEL_CODEX_VERSION`, drift refused unless `WINDKEEL_ALLOW_CODEX_VERSION_DRIFT`.
- **Usage is OpenAI-shaped.** `WorkerUsage` has `inputTokens` (total, cached included),
  `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`; `modelCostUsd` prices it from the
  catalog (ADR-0026 §9). Anthropic reports cache reads and cache writes *separately from*
  `input_tokens`, and prices cache writes above base input.

Two open issues touch the same ground. **#339** is a spike on Vercel **Eve** as a
*conversational front door* (Slack, console chat) that reaches Windkeel only through `/v1`. **#340**
measures maker crash durability and weighs replacing the maker with an Eve/AI SDK tool-call loop
(its option 3). Both will write ADRs; this one decides only which harness makes a change and how
it is chosen.

#### The candidates, checked 2026-10-16

Versions are from the npm, PyPI and GitHub release registries on 2026-10-16. Each is the version
these facts were read against, not a pin; §7 pins.

- **Codex CLI** (`@openai/codex` 0.163.0, 2026-10-15; the adapter pins 0.154.0). `codex exec
  --json` emits `thread.started`, `turn.started|completed|failed`, `item.started|completed`;
  usage is on `turn.completed` (`input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`); `codex exec resume <SESSION_ID>`; `CODEX_API_KEY` for automation;
  a custom provider via `model_providers.<id>` with `wire_api = "responses"`, the only value
  supported. Update checks (`check_for_update_on_startup`), analytics (`analytics.enabled`),
  feedback and an OTEL metrics exporter that defaults to `statsig` are all configurable off. An
  `app-server` (JSON-RPC over stdio) exists; the adapter does not need it. Sources:
  [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [config reference](https://learn.chatgpt.com/docs/config-file/config-reference),
  [app-server](https://learn.chatgpt.com/docs/app-server),
  [releases](https://github.com/openai/codex/releases). OpenAI publishes no egress list;
  `api.openai.com` with an API key is inferred.
- **Claude Code** (`@anthropic-ai/claude-code` 2.1.301 `latest`, 2.1.292 `stable`, 2026-10-15; the
  npm package now delivers a native binary through per-platform optional dependencies).
  `claude -p --output-format stream-json --verbose` emits `system/init` (model, tools, MCP
  servers), `assistant` and `user` messages, `system/api_retry`, `permission_denied`, and a
  final `result` with `session_id`, `usage` and `total_cost_usd` (a client-side estimate).
  `--resume <session_id>` resumes by id; `--continue` resumes the most recent. **`--bare` is
  recommended for scripted runs** and skips hooks, plugins, `.mcp.json` and `CLAUDE.md`; without
  it, `-p` runs a repository's hooks and MCP servers with no trust prompt. `ANTHROPIC_API_KEY` is
  sent as `X-Api-Key`; `ANTHROPIC_BASE_URL` overrides the host; Bedrock and Vertex are env-selected.
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off updates, telemetry, error reports, feedback,
  release notes and feature flags. Telemetry and error reports go to Datadog hosts; **feature
  flags, telemetry events and the WebFetch domain-safety preflight go to `api.anthropic.com`
  itself** (`skipWebFetchPreflight: true` turns the preflight off). Sources:
  [headless](https://code.claude.com/docs/en/headless),
  [env vars](https://code.claude.com/docs/en/env-vars),
  [network config](https://code.claude.com/docs/en/network-config),
  [data usage](https://code.claude.com/docs/en/data-usage).
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` 0.3.301, bundling Claude Code 2.1.301).
  `query()` spawns the same Claude Code binary as a subprocess and inherits its environment;
  sessions resume by id; transcripts live in `~/.claude/projects/<cwd>/*.jsonl` on the machine
  that ran them. It is governed by Anthropic's
  [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), including in products
  offered to others; third parties may not offer claude.ai login or its rate limits, and the
  [overview](https://code.claude.com/docs/en/agent-sdk/overview) does not permit "Claude Code"
  naming or look-alike visuals for a product built on it ("Powered by Claude" is allowed);
  [sessions](https://code.claude.com/docs/en/agent-sdk/sessions).
- **OpenCode** (`opencode-ai` 1.19.3, 2026-10-16; the repository moved to
  [anomalyco/opencode](https://github.com/anomalyco/opencode)). `opencode run --format json
  --model provider/model --session <id>` emits `step_start`, `text`, `reasoning`, `tool_use`,
  `step_finish` (with `tokens` and `cost`) and `error`
  ([source](https://github.com/anomalyco/opencode/blob/main/packages/cli/src/run/noninteractive.ts)).
  `opencode serve` exposes an HTTP API with SSE (`@opencode-ai/sdk` 1.19.3). Providers are
  configured per id with a `baseURL`, so any vendor is reachable. Configuration can be passed
  whole in `OPENCODE_CONFIG_CONTENT`; `share: "disabled"`, `update: "disable"` (`autoupdate` is
  deprecated), `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH`,
  `OPENCODE_DISABLE_LSP_DOWNLOAD` and `OPENCODE_DISABLE_CLAUDE_CODE*` (it otherwise reads Claude
  Code's project files) switch off the rest. **Inline configuration does not replace project
  configuration.** The 1.19.3 loader
  ([`config.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/config.ts),
  [`paths.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/paths.ts))
  walks up from the working directory for `opencode.json(c)` and `.opencode/` directories — the
  latter's `opencode.json`, commands, agents, modes and plugins, with an `npm install` of
  `@opencode-ai/plugin` in each — and merges `OPENCODE_CONFIG_CONTENT` *after* them, so it cannot
  remove what they added (plugin arrays concatenate). `OPENCODE_DISABLE_PROJECT_CONFIG` gates
  both walks and the project `AGENTS.md`/`CLAUDE.md` lookup
  ([`instruction.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/instruction.ts)).
  It does not gate skills: project `.claude/skills` and `.agents/skills` are scanned unless
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`
  ([`skill/index.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/skill/index.ts);
  `OPENCODE_DISABLE_CLAUDE_CODE` drops only the `.claude` one). `~/.opencode` is also read, from
  `$HOME`. No telemetry setting is documented; the models
  catalog defaults to `models.opencode.ai` (unverified at runtime). Sources:
  [CLI](https://opencode.ai/docs/cli/), [server](https://opencode.ai/docs/server/),
  [config schema](https://opencode.ai/config.json).
- **Eve** (`eve` 0.80.1, 2026-10-16, public beta under Vercel's beta terms;
  [vercel/eve](https://github.com/vercel/eve), [eve.dev](https://eve.dev)). A filesystem-first
  framework for durable agents (`instructions.md`, `tools/`, `skills/`, `channels/`). **The agent
  loop runs on the host — Vercel Functions on Vercel Workflow, one Workflow run per session —
  and its tools run in a sandbox rooted at `/workspace`**
  ([deployment](https://github.com/vercel/eve/blob/main/docs/guides/deployment/overview.md),
  [sandbox](https://github.com/vercel/eve/blob/main/docs/sandbox/index.mdx)). Models go through
  AI Gateway. Its `eve` CLI scaffolds and deploys; it is not a coding agent to run in a sandbox.
  #339 records the rest. Related and separate: Vercel's
  [`durable-harness`](https://vercel.com/docs/agent-harnesses) (0.0.1-beta.5) runs Claude Code and
  Codex (both marked experimental) inside Vercel Sandbox on Queues and a Workflow log.
- **OpenHands** ([OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) v1.27.1,
  2026-10-12; [`openhands-sdk`](https://github.com/OpenHands/software-agent-sdk) 1.55.1). The
  [headless CLI](https://docs.openhands.dev/openhands/usage/cli/headless) (`openhands --headless
  --json`) lives in a repository marked **no longer actively maintained**; the supported path is
  the Python SDK, LiteLLM for any provider, with a local or Docker workspace. Its event schema and
  resume flags were not verified.
- **Vercel AI Gateway** serves Anthropic Messages (`/v1/messages`) and OpenAI Chat/Responses, and
  documents Claude Code (`ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh/claude-code`), Codex
  and OpenCode against it ([coding agents](https://vercel.com/docs/ai-gateway/coding-agents),
  [Anthropic API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api)).
  ADR-0026 §8 did not adopt it; nothing here changes that (§4).

### Decision

#### 1. The harness is part of the maker choice, not a setting of its own

A harness and a model are one decision: Claude Code cannot call `gpt-5-codex`, Codex cannot call
Anthropic's Messages API. Storing them in different places would let an organization default name
one and a repository override name the other, and the combination would be discovered in a
sandbox. So:

- **`model_policy` gains a nullable `harness` column**, meaningful only on `role = 'maker'` rows
  (a check constraint enforces that). Null means *the operator's default harness*.
- **Layers are as ADR-0026 §4:** organization default → repository override → task override
  (`engineering_task.model_override.maker.harness`). The most specific layer that names a maker
  names the *pair*. A layer that sets only a model inherits the harness from below it, and the
  pair is checked (§4); an incompatible pair is a `ModelPolicyError` at write time, and again at
  intake.
- **Per organization, with a per-repository override**, because both exist already and a
  harness is a property of how a repository is best worked on (a monorepo that needs Claude
  Code's subagents; a Python service an organization standardises on OpenCode for). The task
  override exists for symmetry with models and for comparison runs; the console does not expose
  it at first (§9).
- **The operator decides what is available.** `WINDKEEL_MAKER_HARNESSES` (default `codex`) lists the
  harnesses this deployment will drive; `WINDKEEL_DEFAULT_MAKER_HARNESS` (default `codex`) is the
  bottom layer. A policy naming a harness the deployment does not enable is refused on write
  (`422 harness_unavailable`) and, if the operator later disables it, at intake with
  `stop_reason = 'model_policy'`. No silent substitution, the same rule as ADR-0026 §6.

#### 2. It is frozen into the run snapshot, beside the model

`RunModelConfig.maker` gains `harness: { id, version }`, resolved at intake in the same
CLASSIFYING handler that resolves models (ADR-0026 As built). `maker.worker` stays and equals
`harness.id`, so `agent_run.worker_type`, `worker_session_binding.worker_type` and the console
read what they read today. `version` is the pinned version the deployment's descriptor named at
intake (§7). A snapshot without `harness` — every run before this lands — is Codex at the
deployment's pinned version, which is today's behaviour exactly.

**A run never changes harness.** Every stage picks its adapter by the snapshot's harness, never
by a deployment default: `StageDeps.worker` becomes `StageDeps.workers`, a registry keyed by
harness id, and `workerFor(snapshot)` is the only way a stage obtains one. `attach()` already
refuses a `WorkerSessionRef` whose `workerType` differs; a repair turn resumes on the same
harness *and* the same version, or it fails with the existing named error (ADR-0011 §2,
ADR-0017 §3). The in-sandbox version check compares against the snapshot's `version`, not the
deployment's current pin, so a deploy that bumps a pin mid-run does not fail runs already on the
old binary. A deployment that no longer registers the run's harness fails the run at the next
maker stage with `stop_reason = 'model_policy'` rather than cold-starting another harness on the
same workspace.

#### 3. The contract every harness adapter meets

The `WorkerAdapter` interface is unchanged in shape. What changes is that its obligations become
a **shared conformance suite** (`test/worker-conformance/`), run against every registered
adapter with a fake harness binary replaying recorded fixtures, so "a second worker plugs in" is
a test, not a comment. A harness is eligible as a production maker only if it passes. The
obligations:

1. **Detached launch, file-backed output.** The harness runs under `setsid`, backgrounded, stdout
   to a JSONL file in a `mkdtemp` scratch directory outside the checkout, through
   `runInExecutionPhase` only. This is the Codex launcher, extracted to a shared helper
   (`src/worker/detached.ts`); it is what makes a session reattachable without a provider
   streaming API (#196) and what #340's measurements are about.
2. **`poll()` is required.** Non-blocking, watermarked, idempotent with no new output (#197).
3. **Events normalise onto `WorkerEvent`**, with no passthrough. `started.sessionId` carries the
   harness's own session id; `completed.usage` carries normalised usage (§8); a turn ends in
   exactly one `completed` or `failed`. Commands go through `command-classification.ts` so
   `test_started`/`test_finished` mean the same thing for every harness.
4. **Session reference and attach.** `reference()` writes the scratch path, turn number,
   watermark and harness session id; `attach()` rebuilds from them and the re-acquired sandbox.
5. **Resume for repair turns, by explicit session id.** Never "the most recent session"
   (`--last`, `--continue`), for the reason the Codex adapter gives: under a reattach, "most
   recent" can be another process's.
6. **The diff is the workspace's.** `result().diff` comes from the shared `extractDiff` (moved
   from `codex/result.ts` to `src/worker/diff.ts`) against the base revision. The harness's own
   file list is used only for `selfReportDivergence`.
7. **The route is bound, not configured.** `useRoute()` is implemented; the model, provider and
   base URL reach the harness on its command line or in a config file written to the scratch
   directory, and its key variable holds a placeholder. No harness reads a key, a user config
   file or a login from the sandbox's home directory: each adapter starts the harness with an
   isolated config home in the scratch directory (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, OpenCode's
   config passed whole in `OPENCODE_CONFIG_CONTENT` with `HOME` and its XDG directories in
   scratch). An isolated home keeps out the *user's* configuration only; the repository's is
   obligation 9.
8. **The harness's own permission prompts and sandbox are off**, for ADR-0006 §2's reasons: the
   microVM and the egress policy are the boundary, and a prompt in a headless run is a hang.
9. **The repository does not configure the harness.** A checkout is untrusted input. A harness
   that would execute hooks, start MCP servers, load plugins or read agent settings from the
   repository (`.claude/settings.json`, `.mcp.json`, `opencode.json`, `.codex/`) is started in
   the mode that ignores them. For Claude Code that is `--bare`, which its documentation
   recommends for scripted runs; without it, `-p` runs a repository's hooks with no trust prompt.
   For OpenCode it is `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`
   (see *Context*: inline configuration is merged after project configuration, not instead of
   it). The suite proves this per adapter with a hostile fixture checkout — for OpenCode an
   `opencode.json` and a `.opencode/` declaring a plugin, a command and an MCP server, an
   `.agents/skills/` skill, an `AGENTS.md` — and asserts the harness's environment carries the
   flags; the live check (*Accepted only after*) asserts none of them loaded in the pinned
   version. A version bump re-runs both, since the flags are the harness's and can change.
   Instruction files (`AGENTS.md`, `CLAUDE.md`) are prose, not code; an organization may opt in to
   them per repository later, and they are off by default because `--bare` turns them off.
10. **`cancel()` kills the process group promptly.** No adapter owns a timeout (ADR-0006 §3).
11. **The version is checked in the sandbox before the first turn**, against the snapshot's
    `version` (§7).

**Capability matrix.** The three existing flags stay; four join them, declared per adapter and
read by the stages:

| Capability | Meaning | When a harness lacks it |
|---|---|---|
| `resumableSessions` | `send()` continues the session | **Not eligible as a maker.** ADR-0011 §2 requires a repair to resume the same session. |
| `reattachableSessions` | `attach()` works in another process | **Not eligible.** Stages are separate invocations (#196). |
| `reattachedSessionsAcceptNewTurns` | a reattached session takes `send()` | **Not eligible.** REPAIRING runs in another invocation, so a repair turn is `send()` on a reattached session; without it ADR-0011 §2's same-session repair cannot happen. `resolveRepairSession` does not read this flag today, and its refusals end in `FAILED` — a refusal path is how a run dies, not how it repairs. The fakes keep `false` and are not production makers. |
| `pollable` (new) | implements `poll()` | **Not eligible** for a live harness (#197). |
| `reportsUsage` (new) | `completed.usage` is present, with token counts | **Not eligible.** The spend rail needs tokens: `modelCostUsd(undefined, …)` is `0` (the scripted-worker case), and `unpricedSpendEstimate` prices a `usd`-null row by its `tokens_in`/`tokens_out`, so a usage-less turn advances no cap. Considered and rejected: a flat per-turn charge — a turn's tokens have no bound to charge against. A production maker whose `completed` lacks usage fails the turn rather than record zero. |
| `reportsFileChanges` (new) | emits `file_changed` | Eligible; `selfReportDivergence` is absent. |
| `providers` (new) | catalog providers the harness can call, by wire protocol | Policy writes and intake refuse pairs outside it (§4). |

#### 4. Harness ⇄ provider compatibility, and independence

Each harness declares the wire protocols it speaks; the catalog already records each provider's
protocol (`packages/verification/src/providers/catalog.ts`). The pair is valid when they meet:

| Harness | Protocols | Catalog providers it may use |
|---|---|---|
| `codex` | OpenAI Responses | `openai`, `openrouter`, `openai-compatible` (unchanged) |
| `claude-code` | Anthropic Messages | `anthropic` only; a custom Anthropic-compatible endpoint (a gateway, a proxy) only once the catalog gains an `anthropic-compatible` provider with a declared vendor |
| `opencode` | both, via its own provider layer | `openai`, `anthropic`, `openrouter`, `openai-compatible` |

`maker-route.ts`'s blanket refusal of `provider: "anthropic"` becomes this table's refusal for
`codex` only. AI Gateway would let Claude Code call other vendors' models through its Anthropic
endpoint; that is ADR-0026 §8's deferred decision and stays deferred. When the catalog gains a
gateway provider, the vendor is still derived from the model (ADR-0026 §5) and this table gains a
row; nothing else changes.

**Independence is unchanged in kind and still checked on the model's vendor** (ADR-0010 §3,
ADR-0026 §5): `claude-code` running `claude-sonnet-4-5` is an `anthropic` maker, and the checker
must be another vendor. The harness is recorded for provenance but is not a vendor: two harnesses
running the same model are the same maker for independence, and one harness running two vendors'
models is two makers. Considered and rejected: treating the harness's *publisher* as a vendor
(OpenAI for Codex, Anthropic for Claude Code). It would forbid OpenCode-on-Claude with an Anthropic
checker for no reason the verdict depends on, while the system prompt it is protecting against
is not what independence measures.

**This bends ADR-0010 §2.** The checker default is Anthropic. A Claude Code maker on operator
defaults therefore has no independent checker, and intake fails it with
`NoIndependentProviderError` — correct, but a poor first experience. So:

- The operator's checker defaults become a **list in preference order across at least two
  vendors** (e.g. Anthropic, then OpenAI), and intake takes the first independent one, which is
  how a task's checker list already works. `windkeel doctor` warns when an enabled harness can be
  paired with operator defaults that leave no independent checker.
- The console warns at policy-write time when the chosen maker leaves the organization's
  checker dependent, using the vendor table it already mirrors.

**BYOK** (ADR-0026) is unchanged: a maker row names a credential or Windkeel-managed; the
credential's provider must be one the harness may use. Windkeel-managed keys for a harness exist only
if the operator configured a key for that provider's host (ADR-0026 §6: the operator's maker key
is for one host). The operator's maker key configuration therefore becomes per provider
(`WINDKEEL_MAKER_KEY_ENV_VAR_<PROVIDER>`, falling back to today's single variable for the
`WINDKEEL_MODEL_API_DOMAIN` provider).

**Bedrock and Vertex are out of scope.** Their auth is request signing (SigV4, Google OAuth),
which a static header at the egress proxy cannot produce; supporting them would put a cloud
credential in the sandbox, which ADR-0014 §1 forbids.

#### 5. Egress and security, per harness

The execution phase stays **one host**: the resolved provider's (ADR-0014 §3, ADR-0026 §7). No
harness gets a second domain for telemetry, update checks, model catalogs, error reporting, or
its vendor's web services; each is switched off by configuration *and* is blocked anyway.
Switching off matters even though egress blocks it, because a harness that retries a blocked
call can stall, or log noise that looks like a model failure.

**Egress cannot be the only control for Claude Code**, because its feature flags, telemetry
events and WebFetch preflight go to `api.anthropic.com`, the host the maker must reach. On a
customer key those calls would be made with the customer's key. Configuration is therefore
load-bearing there, and the live check in *Accepted only after* records what reaches that host.

| Harness | Key placeholder | Header the broker injects | Switched off by the adapter |
|---|---|---|---|
| `codex` | `CODEX_API_KEY`, `OPENAI_API_KEY` | `Authorization: Bearer` | `--ignore-user-config` (today); `-c check_for_update_on_startup=false`, `analytics.enabled=false`, `feedback.enabled=false`, and an explicit OTEL exporter of none (it defaults to `statsig`) |
| `claude-code` | `ANTHROPIC_API_KEY` (sent as `X-Api-Key`) | `x-api-key` | `--bare`; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` plus `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`; `skipWebFetchPreflight`; `WebFetch`, `WebSearch` and MCP tools disallowed |
| `opencode` | the provider's variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) | per provider protocol | `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` (§3.9); `share: "disabled"`, `update: "disable"`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH` (the model is declared in the written config), `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_CLAUDE_CODE*`; web and MCP tools disabled |

**OpenCode runs as `opencode run --format json`, not `opencode serve`.** A server in the sandbox
would be reached through an exposed port, which ADR-0014 §3 treats as internet-reachable; the
file-backed launcher (§3.1) needs no port. The same reasoning keeps Codex on `exec`, not
`app-server`.

The broker's header becomes **a property of the provider**, not of the harness: the catalog gains
`authHeader` (`Authorization` for OpenAI-protocol providers, `x-api-key` for `anthropic`), and
`makerModelKeyRule`/`resolvedModelKeyRule` take it from there. `headerValue` already passes a
non-`Authorization` secret verbatim.

Every adapter's placeholder is the existing `CODEX_API_KEY_PLACEHOLDER` value under the name the
harness reads; a test asserts no adapter's environment contains any value the broker resolves.
Tools that reach the network on the agent's behalf (web fetch, web search, MCP) are disabled by
configuration in every harness; they could only reach the model host anyway, but a harness that
offers a tool that cannot work wastes turns.

**Claude Code is authenticated with an API key only**, never a claude.ai login or OAuth token.
Anthropic's terms do not let a third party offer claude.ai login or its rate limits, and `--bare`
requires an API key anyway. The adapter refuses a turn whose `system/init` reports any other
auth source.

**The CLI, not the Claude Agent SDK.** The SDK spawns the same binary as a subprocess of whatever
process calls `query()`. Called from a stage, that process is the Vercel function: the agent and
its tools run outside the sandbox, with the key in reach (ADR-0014 §1). Called inside the
sandbox, it is a Node script of ours wrapping the CLI, with the same transcripts and nothing the
stream-JSON output lacks. The SDK is worth adopting only if a capability the conformance suite
needs turns out to be SDK-only.

#### 6. Eve is not a maker harness, and OpenHands is deferred

**Eve** is an agent *framework* that runs in Vercel Functions, one Vercel Workflow run per
session, with tools as code; its sandbox is something its tools call into, not something that
runs inside ours. A maker harness in this ADR is a program inside the maker sandbox behind the
egress proxy. Eve as the maker would move the agent loop out of the sandbox into Windkeel's
deployment, where the model key is in reach of the agent's host process — the opposite of
ADR-0014 §1 — and put every tool call through Workflow step arguments, against ADR-0021 §5's
event ceiling. That is #340's option 3, and the question it asks is durability, not choice. So:

- Eve is **not** offered in the harness selector.
- Eve as a conversational front door is **#339's** decision.
- Eve (or an AI SDK loop) as the maker's *execution model* is **#340's** decision; if #340
  recommends it, it arrives as a harness that meets §3 or as an ADR that supersedes this one,
  not as a fourth row in §4.

Vercel's `durable-harness` beta (Context), which runs Claude Code and Codex inside Vercel Sandbox
on Queues and a Workflow log, is evidence for #340 too. It uses this ADR's topology (the harness
in the sandbox, durability around it), not Eve's.

**OpenHands** was ADR-0006 §5's candidate because it restored model freedom. OpenCode now does
that inside the same sandbox topology Codex uses (a CLI preinstalled in the image, headless JSON
output, sessions by id). OpenHands' headless CLI is no longer maintained, and its supported path
is a Python SDK with its own workspace model. ADR-0006 §5 is amended: the second worker is Claude Code, the third
OpenCode, and OpenHands is revisited only if OpenCode cannot meet §3.

#### 7. Install and version pinning

Each harness has a descriptor beside its adapter:
`{ id, binary, pinnedVersion, versionEnvVar, allowDriftEnvVar, installSpec }`, the Codex pattern
generalised: `WINDKEEL_CODEX_VERSION`, `WINDKEEL_CLAUDE_CODE_VERSION`, `WINDKEEL_OPENCODE_VERSION`, each
with an `WINDKEEL_ALLOW_<ID>_VERSION_DRIFT` escape hatch that records a diagnostic.

1. **Verify the preinstalled binary** (today's Codex behaviour). The `universal` image moves
   under us: the adapter pins Codex 0.154.0 while npm's `latest` is 0.163.0. The snapshot's
   `version` is what was promised. Claude Code's npm package now ships a per-platform native
   binary; the pin is the npm version, and `claude --version` is what is checked.
2. **On a mismatch, install the pinned version in the install phase**, when the operator sets
   `WINDKEEL_HARNESS_INSTALL=pinned`: `npm install -g <package>@<version>` while
   `registry.npmjs.org` is still allowed, before egress narrows. Without that setting a mismatch
   fails the run by name, as Codex's does.
3. **Later, a sandbox snapshot per harness-version set** (`Sandbox.create({ source: { type:
   'snapshot' } })`), built by a job and named in `WINDKEEL_SANDBOX_SNAPSHOT_ID`, removes the
   install from every run's critical path. Deferred until install time is measured to matter.

`windkeel doctor`'s sandbox check runs `--version` for every enabled harness, not only Codex.

#### 8. Cost accounting

Every harness's usage is normalised into `WorkerUsage` by its adapter:

- `inputTokens` remains **total input including cache reads and writes**, so `modelCostUsd`'s
  "subtract the cached portion" stays correct for every vendor.
- `WorkerUsage` gains `cacheWriteInputTokens`, and the catalog's `ModelPricing` gains
  `usdPerCacheWriteInputToken`; Anthropic bills a cache write above base input, and leaving it at
  the base rate would under-count — the one direction ADR-0026 §9 and #263 say a spend rail must
  never err in.
- Per harness: Codex's `turn.completed` usage maps as today. Claude Code's `result.usage` reports
  `input_tokens` *excluding* `cache_read_input_tokens` and `cache_creation_input_tokens`, so the
  adapter adds them back into `inputTokens` and fills `cachedInputTokens` and
  `cacheWriteInputTokens`. OpenCode reports tokens on each `step_finish`; the adapter sums a
  turn's steps.
- A harness's **own cost figure** (Claude Code's `total_cost_usd`, OpenCode's per-message cost) is
  recorded on the agent run for comparison and never used for the ledger: it is the harness's
  list price, not the price the catalog or the customer's contract says.
- `agent_run.worker_type` already records the harness, and the cost report groups by it, so
  harnesses can be compared per task; no new `cost_event` column is needed.

#### 9. Console and API

- **`PUT /v1/model-policy`** accepts `harness` on a maker entry (`models.manage`, as today).
  **`GET /v1/harnesses`** (`models.read`) lists the deployment's enabled harnesses with their
  pinned versions, protocols and compatible providers, so a client can offer only valid pairs.
  `POST /v1/tasks` accepts `models.maker.harness`.
- **Settings → Models**, maker section: an **Agent** select (Codex, Claude Code, OpenCode — only
  those the deployment enables; others shown disabled with "not enabled on this deployment")
  *above* the model; the provider and credential lists filter to what the agent can call; the
  existing independence warning gains "the checker would be the same vendor as this agent's
  model". The repository override offers the same control. The legend "Codex speaks OpenAI's
  formats" becomes per-agent.
- **The run's Models panel** shows the harness and version ("Claude Code 2.x.y") where it
  shows "driven by codex" today.
- **Naming.** The UI describes a harness by what it is ("Anthropic's Claude Code CLI", "OpenAI's
  Codex CLI", "OpenCode"), in plain text, with no vendor logos or look-alike visuals, and never
  names Windkeel or any part of it after a harness. Anthropic's Agent SDK terms restrict "Claude
  Code" branding for products built on the SDK. Whether a descriptive label for the CLI is
  acceptable is confirmed before the console ships (*Accepted only after*); the fallback label is
  "Claude (Anthropic)".

#### 10. Rollout and recommendation

1. **Selection without a new harness.** Column, snapshot field, registry, `GET /v1/harnesses`,
   policy validation — with only `codex` registered. Every run is unchanged, and the plumbing is
   proved on the harness that already works.
2. **Conformance suite** against the Codex adapter and the fakes, with the shared launcher and
   diff extracted.
3. **Claude Code**, behind `WINDKEEL_MAKER_HARNESSES`. Recommended second because it is the most
   requested, preinstalled in the image, has a documented stream-JSON event schema and explicit
   session resume, and it unlocks Anthropic models as the maker — which BYOK customers already
   hold keys for.
4. **Console and API** to choose it.
5. **OpenCode**, which makes the maker provider-neutral and retires OpenHands' reason to exist
   here.
6. **Cross-harness e2e**: one task, each harness, stub binaries, real stages.

Eve: no adapter; tracked by #339/#340. OpenHands: not scheduled.

#### Accepted only after

- The live check (step 3) runs Claude Code in a real Vercel Sandbox with the execution-phase
  policy narrowed to `api.anthropic.com`, the key brokered as `x-api-key`, a placeholder in the
  environment, `--bare`, and a repair turn resumed by session id from a different process. It
  records which paths on `api.anthropic.com` were called and that no other host was attempted.
- Resuming a Claude Code session whose process was killed mid-turn is measured, as #340 does for
  Codex, so both harnesses' crash behaviour is known rather than assumed.
- The console label for Claude Code is checked against Anthropic's current branding terms.
- The conformance suite passes for Codex and Claude Code.
- Before OpenCode is enabled: run in a real sandbox against §3.9's hostile checkout, the pinned
  OpenCode loads none of its project config, plugins, commands, agents, skills or instruction
  files, and attempts no `npm install`.
- ADR-0026 is Accepted (#318), since this builds on its snapshot.

### Consequences

- **"Which agent" becomes data, like "which model".** A run records the harness and version it
  ran on; a policy change mid-run changes nothing; two runs on one warm instance can use different
  harnesses, as they can already use different vendors.
- **The deployment grows one adapter per enabled harness**, and `StageDeps.worker` becomes a
  registry. Every stage that touched `deps.worker` changes once, mechanically.
- **ADR-0010 §2's single Anthropic checker default ends.** Operators need checker keys for two
  vendors to offer both an OpenAI-model maker and an Anthropic-model maker on defaults.
- **Anthropic becomes a maker vendor.** The independence filter already handles it; the console's
  mirrored vendor table must stay in step.
- **More upstream churn to track.** Each harness ships often; the descriptor pin and `doctor`
  are the defence, and a drifted image is a named failure, not a silent upgrade.
- **The broker header moves to the catalog**, a small change to a security-relevant path, covered
  by the existing broker tests plus one per protocol.
- **`research/MILESTONES.md` M11** is rewritten from "OpenHands" to this ordering.
- **Durability is shared.** Whatever #340 finds about Codex crash windows applies to every harness
  that uses the shared launcher; fixes land once.
- **What this does not do:** routing by risk or fallback between harnesses mid-run (M10/M11
  routing), Eve, OpenHands, Bedrock/Vertex, or a harness choice for the checker (the checker is
  not an agent; it stays the `fetch`-based `ModelGateway`, ADR-0026 §8).
