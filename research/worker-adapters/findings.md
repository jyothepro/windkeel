# Worker Adapter Comparison: OpenAI Codex CLI vs OpenHands

**Wayfinder ticket:** [#51](https://github.com/jyothepro/orqon/issues/51)
**Date:** 2026-08-14
**Question:** What are the facts needed to choose between OpenAI Codex (`codex` CLI / `codex exec` headless mode) and OpenHands (formerly OpenDevin) as the first WorkerAdapter — the coding agent Windkeel drives inside a sandbox to implement code changes?

This document collects facts only. The choice itself is a separate human decision ticket.

---

## Comparison table

| Dimension | OpenAI Codex CLI (`codex exec`) | OpenHands (CLI headless + Agent SDK) |
|---|---|---|
| Headless mode | `codex exec "<task>"` — single run to completion, exits when done; `--json` for JSONL event stream | `openhands --headless -t "<task>"` (or `-f task.txt`); `--json` for JSONL; also a Python Agent SDK (`Conversation.run()`) and a REST/WebSocket Agent Server |
| SDK | TypeScript SDK `@openai/codex-sdk` (wraps the CLI, exchanges JSONL over stdio); Rust core | Python SDK (`openhands.sdk`: Agent, Conversation, LLM, Tool) + REST/WebSocket Agent Server; MIT |
| Event stream | JSONL: `thread.started`, `turn.started/completed/failed`, `item.started/updated/completed` (items: `assistant_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`), `error` | Event-sourced: `ActionEvent` / `ObservationEvent` / `MessageEvent` pairs (bash, file_editor, task_tracker tools), full persisted event log; JSONL in headless `--json` mode |
| Non-vendor models | Yes, with caveats: custom `model_providers` in `config.toml` (OpenAI-compatible `base_url` + `env_key`); OpenRouter works; local via `--oss` (Ollama/LM Studio/MLX). Harness is tuned for OpenAI models | Yes, first-class: any LiteLLM slug (`anthropic/...`, `openrouter/...`, `ollama/...`, `openai/...`, local `base_url`). "Bring your own model" is the design center |
| Auth | ChatGPT sign-in (plan quota) or `CODEX_API_KEY`/API key (recommended for automation); custom provider keys via env vars | Plain API key env/config per provider; no vendor account required for self-hosted OSS |
| Diff extraction | Agent mutates the workspace; `file_change` items name touched files; final answer via `-o/--output-last-message` and `--output-schema` (JSON Schema-constrained output); diff = `git diff` of workspace | Agent mutates the workspace (local dir, `DockerWorkspace`, or `RemoteWorkspace`); file-edit observations in event log; diff = `git diff` of workspace; Agent Server exposes conversation events + workspace files over REST |
| Cancellation/limits | Process exits on completion; kill process / SIGINT to cancel (historical rough edges: SIGINT exit-code, non-TTY hangs); no built-in wall-clock/iteration budget — orchestrator must enforce | `max_iteration_per_run` (default 500), stuck detector (5 patterns, on by default), budget controls; SDK `conversation.pause()`; run ends at FinishAction/limits |
| Sandboxing (own) | Built-in OS sandbox: Landlock + seccomp on Linux (`--sandbox read-only\|workspace-write\|danger-full-access`) | Runs actions in a Docker runtime container (or local/remote workspace); isolation is container-level |
| License | Apache-2.0 (CLI/harness); backend model service is proprietary OpenAI | MIT (core app + SDK); `enterprise/` dir is PolyForm Free Trial (not open source); self-hosting the MIT core is unrestricted |
| Maturity | ~106k stars; extremely fast cadence (multiple alpha releases per day, 0.14x line); backed by OpenAI | ~84k stars; SDK at v1.42.x, releases every few days; backed by All Hands AI; SWE-bench research pedigree; peer-reviewed SDK paper (arXiv 2511.03690) |
| Cost per task | Tokens only (API key) or included in ChatGPT Plus/Pro/Business plan quotas; no platform fee for CLI | Self-hosted: tokens only, $0 platform fee; OpenHands Cloud optional (BYO key or pay-as-you-go at cost; free MiniMax tier; Enterprise custom) |

---

## 1. Headless / non-interactive operation

### Codex CLI
- `codex exec "<task>"` runs a single non-interactive session to completion and exits when the agent decides the task is done. Progress goes to stderr; only the final message goes to stdout (pipe-friendly). ([OpenAI non-interactive docs](https://developers.openai.com/codex/noninteractive), [DeepWiki: headless execution mode](https://deepwiki.com/openai/codex/4.2-headless-execution-mode-(codex-exec)))
- Key flags: `--json` (JSONL event stream on stdout), `-o/--output-last-message <path>`, `--output-schema <path>` (JSON-Schema-constrained final output), `--ephemeral`, `--ignore-user-config`, `--skip-git-repo-check`, `--sandbox <read-only|workspace-write|danger-full-access>`. `--full-auto` is deprecated in favor of explicit `--sandbox workspace-write`.
- Sessions can be resumed: `codex exec resume --last` or `codex exec resume <SESSION_ID>`.
- Prompt can arrive via argument or stdin (`cat prompt.txt | codex exec -`).
- Own OS-level sandbox on Linux: Landlock (filesystem: read everywhere, write only to writable roots) + seccomp (blocks network syscalls); requires kernel 5.13+. This nests inside whatever container Windkeel provides, or can be bypassed with `danger-full-access` when Windkeel's sandbox is authoritative. ([Codex sandboxing docs](https://developers.openai.com/codex/agent-approvals-security), [platform implementation writeup](https://codex.danielvaughan.com/2026/04/08/codex-sandbox-platform-implementation/))
- Known operational rough edges in CI contexts: hangs when stdin is a non-TTY pipe with no writer ([#20919](https://github.com/openai/codex/issues/20919)), orphaned children on shell-wrapped command timeouts ([#4337](https://github.com/openai/codex/issues/4337)).

### OpenHands
- `openhands --headless -t "task"` / `-f task.txt`; `--json` streams JSONL events. In headless mode all actions auto-approve (no confirmation path at all). ([Headless mode docs](https://docs.openhands.dev/openhands/usage/how-to/headless-mode))
- The Python SDK is arguably the real integration surface: `Conversation(agent=agent, workspace=...)`, `conversation.send_message(...)`, `conversation.run()` — runs until FinishAction, stuck detection, budget exhaustion, or explicit pause. ([SDK README](https://github.com/OpenHands/software-agent-sdk/blob/main/README.md), [SDK docs](https://docs.openhands.dev/sdk))
- Deployment models: standalone SDK on the host, `DockerWorkspace` (containerized execution), or `RemoteWorkspace` against the OpenHands Agent Server — a REST + WebSocket server storing conversations, events, and workspace files. ([Agent Server](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server))
- Headless mode is what powers the OpenHands GitHub Resolver (issue to code to PR autonomously), i.e. it is a supported production path, not an afterthought.

## 2. Auth and model configuration

### Codex CLI
- Two auth modes: ChatGPT sign-in (Plus/Pro/Business/Edu/Enterprise plan; OAuth flow — awkward inside a headless sandbox, requires copying credentials) or an API key; for automation OpenAI documents `CODEX_API_KEY=<key> codex exec ...`. ([Non-interactive docs](https://developers.openai.com/codex/noninteractive))
- Non-OpenAI models: supported via `config.toml` `[model_providers.<id>]` with an OpenAI-compatible `base_url`, `env_key`, and `wire_api = "responses"|"chat"`. OpenRouter documents this pattern ([cookbook](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli), [blog](https://openrouter.ai/blog/tutorials/codex-cli-openrouter/)). Local models via `--oss` (Ollama, LM Studio, MLX). Provider IDs `openai`, `ollama`, `lmstudio` are reserved.
- Caveat: only OpenAI-compatible APIs work; Anthropic models are reachable only through a compatibility endpoint or OpenRouter, and the Codex harness/prompts are tuned for OpenAI models — community reports of degraded quality on third-party models are common. ChatGPT-plan auth is only valid against OpenAI's own backend.

### OpenHands
- Model config is a LiteLLM slug + API key + optional `base_url`: `anthropic/claude-...`, `openrouter/<vendor>/<model>`, `ollama/<model>`, any OpenAI-compatible endpoint. Env overrides `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` (note: applied via `--override-with-envs`, otherwise `~/.openhands/settings.json` wins). ([Docs index](https://github.com/OpenHands/docs/blob/main/llms.txt), [provider guide](https://dev.to/lynkr/run-openhands-on-any-model-you-want-1mnd))
- No vendor account or plan needed; model-agnostic by design ("works with any LLM — Claude, OpenAI, Qwen, Devstral"). ([SDK docs](https://docs.openhands.dev/sdk))

## 3. Event/progress stream and mapping to Windkeel's normalized events

### Codex `--json` JSONL schema
Events: `thread.started`, `turn.started`, `turn.completed` (includes token usage), `turn.failed`, `item.started` / `item.updated` / `item.completed`, `error`. Item types: `assistant_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`. The TypeScript SDK exposes the same stream as an async generator via `thread.runStreamed()`. ([Non-interactive docs](https://developers.openai.com/codex/noninteractive), [TS SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md))

| Windkeel normalized event | Codex source |
|---|---|
| `started` | `thread.started` + `turn.started` |
| `thinking` | `item.*` with `reasoning` item |
| `command_started` / `command_finished` | `item.started` / `item.completed` with `command_execution` item (exit code in payload) |
| `file_changed` | `item.completed` with `file_change` item |
| `test_started` / `test_finished` | **no native type** — adapter must classify `command_execution` items by command text (`pytest`, `npm test`, ...) |
| `message` | `assistant_message` item |
| `completed` | `turn.completed` |
| `failed` | `turn.failed` / `error` |

### OpenHands event stream
Event-sourced state: every step is an `ActionEvent` (with the model's thought/reasoning attached) followed by an `ObservationEvent` (result), plus `MessageEvent` for agent/user messages; the whole log is persisted and replayable. Headless `--json` emits these as JSONL; the SDK delivers them via conversation callbacks; the Agent Server pushes them over WebSocket. ([SDK paper, arXiv 2511.03690](https://arxiv.org/html/2511.03690v1), [SDK README](https://github.com/OpenHands/software-agent-sdk/blob/main/README.md))

| Windkeel normalized event | OpenHands source |
|---|---|
| `started` | conversation/run start event |
| `thinking` | thought field on `ActionEvent` / reasoning content |
| `command_started` / `command_finished` | terminal-tool `ActionEvent` / its `ObservationEvent` |
| `file_changed` | file_editor `ActionEvent`/`ObservationEvent` |
| `test_started` / `test_finished` | **no native type** — classify terminal actions by command text |
| `message` | `MessageEvent` |
| `completed` | FinishAction / final agent state |
| `failed` | error events / stuck-detector or budget termination state |

Both map well; neither has native test events, so Windkeel's adapter needs the same command-classification shim either way. Codex's schema is flatter and explicitly versioned for automation; OpenHands' is richer (full event sourcing, replay) but Python-side.

## 4. Diff / artifact extraction

- **Both** operate by mutating a working directory; the canonical diff is `git diff` (or `git status --porcelain` + patch) of the sandbox workspace after exit. This fits Windkeel's model of an independent verification engine inspecting the workspace itself rather than trusting agent-reported artifacts.
- Codex extras: `file_change` items enumerate touched files during the run; `-o` captures the final message; `--output-schema` can force a machine-readable summary (e.g. `{files_changed, tests_run, notes}`) as a structured artifact. ([Non-interactive docs](https://developers.openai.com/codex/noninteractive))
- OpenHands extras: persisted event log doubles as a complete audit artifact; Agent Server exposes conversation events and workspace files via REST, so a remote-sandbox adapter can pull both without shelling in. ([Agent Server](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server))

## 5. Cancellation / timeout

- **Codex:** no built-in iteration or wall-clock budget in exec mode — the orchestrator must wrap it (`timeout`, process kill). SIGINT handling in exec mode has had gaps (non-zero exit code on Ctrl+C was a feature request, [#4721](https://github.com/openai/codex/issues/4721); non-TTY Ctrl-C handling landed later, [#26734](https://github.com/openai/codex/pull/26734)). Internal tool-call timeouts have had orphaned-child issues ([#4337](https://github.com/openai/codex/issues/4337)). Exit code is non-zero on failed turns, enabling CI-style pass/fail.
- **OpenHands:** built-in guards — `max_iteration_per_run` (default 500), stuck detector on by default (repeating action/observation cycles, repeated errors, monologue, alternating patterns, context-window errors), spend/budget limits; SDK offers explicit `pause()`; run terminates cleanly at FinishAction or any limit. ([Stuck detector docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector), [local_conversation.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py))

## 6. Licensing / self-hosting

- **Codex CLI:** Apache-2.0 ([repo](https://github.com/openai/codex)). The harness is freely self-hostable; but its default value depends on OpenAI's proprietary model service, and ChatGPT-plan auth is governed by OpenAI ToS. With a custom provider it is fully self-contained Apache-2.0 software.
- **OpenHands:** MIT for the core app and the entire Software Agent SDK ([LICENSE](https://github.com/OpenHands/OpenHands/blob/main/LICENSE), [SDK README](https://github.com/OpenHands/software-agent-sdk/blob/main/README.md)). Carve-out: the `enterprise/` directory (SSO, RBAC, audit logs, budgeting, guardrails) is PolyForm Free Trial 1.0.0 — source-available, not open source. Self-hosting the MIT core (which includes headless mode, SDK, Agent Server, Docker runtime) is unrestricted.

## 7. Maturity, cadence, community

- **Codex:** ~106k stars, ~16k forks; multiple releases per day on the 0.148 alpha line as of 2026-08-14 (automated release train); Rust core; backed and staffed by OpenAI; TypeScript SDK + GitHub Action ecosystem. Very high issue volume (5k+ open) reflecting both popularity and churn. ([repo](https://github.com/openai/codex), [releases](https://github.com/openai/codex/releases))
- **OpenHands:** ~84k stars, ~11k forks; SDK at v1.42.x with releases every few days ([releases](https://github.com/OpenHands/software-agent-sdk/releases)); backed by All Hands AI (commercial cloud + enterprise); strong research lineage (OpenDevin/SWE-bench, peer-reviewed SDK architecture paper [arXiv 2511.03690](https://arxiv.org/html/2511.03690v1)); Slack/Discord community, transparent roadmap.

## 8. Cost model per task

- **Codex:** CLI is free; inference cost is either (a) token-billed via API key — clean per-task attribution, or (b) bundled into a ChatGPT Plus/Pro/Business subscription with rate limits — cheap at low volume but quota-bound and awkward for fleet automation. Third-party providers (OpenRouter/local) are billed by that provider. No platform fee.
- **OpenHands:** self-hosted OSS is $0 platform fee — pure LLM token cost through whichever provider is configured. Optional OpenHands Cloud: BYO key or pay-as-you-go "billed at cost with no markup", free MiniMax-model tier, Enterprise custom pricing — none of which is required for the WorkerAdapter use case. ([pricing](https://www.openhands.dev/pricing))

---

## Decision inputs summary (facts, no verdict)

1. **Both are viable headless workers** with JSONL event streams that map cleanly onto Windkeel's normalized events; neither emits native test events (adapter shim needed either way).
2. **Model freedom:** OpenHands is model-agnostic by design (any LiteLLM provider: Anthropic, OpenRouter, local). Codex supports third-party OpenAI-compatible providers but is tuned for, and best with, OpenAI models; ChatGPT-plan auth doesn't transfer.
3. **Integration language:** Codex's first-party SDK is TypeScript (plus raw JSONL over stdio from any language). OpenHands' SDK is Python, with a REST/WebSocket Agent Server as a language-neutral surface.
4. **Safety rails:** OpenHands ships iteration caps, budget limits, and stuck detection out of the box; Codex exec relies on the orchestrator for wall-clock/iteration limits and has had SIGINT/CI rough edges.
5. **Sandbox interplay:** Codex brings its own Landlock/seccomp sandbox (nests inside Windkeel's container; can be relaxed); OpenHands assumes a Docker-style runtime container — closer to Windkeel's "drive an agent inside a sandbox" architecture, including a remote Agent Server mode.
6. **Licensing:** Apache-2.0 (Codex CLI) vs MIT core with a non-OSS `enterprise/` carve-out (OpenHands). Both allow unrestricted self-hosting of what Windkeel needs.
7. **Cost:** both are tokens-only when self-hosted with your own keys; Codex additionally offers subscription-quota economics; OpenHands additionally offers an optional at-cost cloud.
8. **Churn risk:** Codex releases multiple times per day (alpha-line churn; JSONL schema is the stability contract); OpenHands releases every few days with an event-sourced schema documented in a stable SDK.

## Sources

- https://github.com/openai/codex — repo, license, stats
- https://developers.openai.com/codex/noninteractive — exec flags, JSONL events, auth, resume
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md — TS SDK, `runStreamed()`
- https://developers.openai.com/codex/agent-approvals-security — sandbox modes
- https://openrouter.ai/docs/cookbook/coding-agents/codex-cli — third-party provider config
- https://github.com/openai/codex/issues/4721, /issues/20919, /issues/4337, /pull/26734 — cancellation/CI behavior
- https://github.com/All-Hands-AI/OpenHands — repo, license, stats
- https://docs.openhands.dev/openhands/usage/how-to/headless-mode — headless flags, `--json`
- https://github.com/OpenHands/software-agent-sdk — SDK, Agent Server, MIT license, releases
- https://docs.openhands.dev/sdk — SDK docs, model-agnostic support
- https://docs.openhands.dev/sdk/guides/agent-stuck-detector — stuck detection
- https://arxiv.org/html/2511.03690v1 — SDK architecture paper (event-sourced state)
- https://github.com/OpenHands/OpenHands/blob/main/LICENSE — MIT + enterprise carve-out
- https://www.openhands.dev/pricing — cloud pricing tiers
