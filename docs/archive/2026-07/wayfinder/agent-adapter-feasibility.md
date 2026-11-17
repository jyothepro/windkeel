# Agent Adapter Feasibility: Claude Code, OpenAI Codex CLI, OpenHands

**Wayfinder ticket:** jyothepro/windkeel#2
**Researched:** 2026-07-25 (AFK, primary sources)
**Question:** Can each candidate coding agent be embedded headless inside an orchestrated platform behind an `AgentAdapter` interface (`start / send / pause / resume / cancel / events(stream)`)? What does the real capability envelope mean for the adapter design, and which agent should be Windkeel's first adapter?

---

## TL;DR

| Dimension | Claude Code / Agent SDK | OpenAI Codex CLI | OpenHands (Agent SDK) |
|---|---|---|---|
| License | Proprietary binary; use governed by Anthropic Commercial ToS (embedding in your product explicitly permitted) | **Apache-2.0** | **MIT** (app repo's `enterprise/` dir excluded) |
| OSS redistribution of Windkeel | OK if SDK/CLI is a user-installed dependency, not vendored; branding limits | Fully OK, can even vendor/fork | Fully OK, can vendor/fork (avoid `enterprise/`) |
| Integration surface | TypeScript + Python Agent SDK (in-process), headless CLI `-p --output-format stream-json`, ACP adapters, MCP client | `codex exec --json` (JSONL), **app-server JSON-RPC**, `@openai/codex-sdk` (TS), MCP server mode, community ACP adapter | Python SDK (`Conversation` API), remote agent-server (REST/WS, Docker), ACP listed, MCP support |
| Structured events | Typed messages: `system(init)`, `assistant`, `user`, `stream_event` (partials), `result`; hooks (`PreToolUse`, `PostToolUse`, …) | `thread.started`, `turn.started/completed/failed`, `item.started/completed` (agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search); app-server adds token-level deltas | Event-sourced `Action`/`Observation` Pydantic events, replayable log, `PauseEvent`, callbacks |
| Interrupt | `interrupt()` in streaming input mode | `turn/interrupt` (app-server) → `turn/completed` with `status:"interrupted"`; `turn/steer` mid-turn | `conversation.pause()` — **true cooperative pause** |
| Resume | `resume: sessionId`, `forkSession`, `continue` | `codex exec resume <id>`, `thread/resume`, `thread/fork` | Call `run()` again; event-sourced state gives replay/fork "for free" |
| BYO API key | `ANTHROPIC_API_KEY`, Bedrock, Vertex, Foundry. **Anthropic models only. Claude.ai (Pro/Max) login in third-party products is banned** | `OPENAI_API_KEY`/`CODEX_API_KEY`; **any Responses-API-compatible provider** via `model_providers` in config.toml (Azure, OpenRouter, Ollama…) | **Any provider via LiteLLM** — fully model-agnostic |

**Recommendation: Claude Code (via the Claude Agent SDK) first**, Codex CLI (app-server) second, OpenHands third. Details and adapter-interface implications at the end.

---

## 1. Claude Code + Claude Agent SDK

### 1.1 Licensing & ToS

- The Claude Code repo carries no OSS license: "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service." ([LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md))
- The Agent SDK docs state explicitly that use is governed by [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), "**including when you use it to power products and services that you make available to your own customers and end users**" — i.e., embedding in a platform like Windkeel is a contemplated, permitted use. ([Agent SDK overview → License and terms](https://code.claude.com/docs/en/agent-sdk/overview))
- **Redistribution:** Windkeel itself can be open source; the SDK npm/PyPI package (which bundles the proprietary Claude Code binary) must remain a dependency users install under Anthropic's terms — it cannot be forked or re-licensed into Windkeel's tree.
- **Branding:** "Claude Agent" / "Powered by Claude" allowed; the strings "Claude Code" / "Claude Code Agent" and Claude Code-styled UI are **not permitted** in an embedding product. ([Branding guidelines](https://code.claude.com/docs/en/agent-sdk/overview))
- **Auth restriction:** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Enforced since April 2026 (third-party agents blocked from piggybacking on Pro/Max subscriptions). API key / Bedrock / Vertex only. ([overview](https://code.claude.com/docs/en/agent-sdk/overview); [news coverage](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use))

### 1.2 Integration surface

- **Agent SDK** in TypeScript (`@anthropic-ai/claude-agent-sdk`) and Python (`claude-agent-sdk`); both **bundle a native Claude Code binary**, so no separate CLI install. Core primitive: `query(prompt, options)` async iterator. ([overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Headless CLI** for other languages: `claude -p --output-format stream-json` subprocess. ([headless docs](https://code.claude.com/docs/en/headless))
- **ACP:** official-adjacent adapters exist — [`@zed-industries/claude-code-acp`](https://www.npmjs.com/package/@zed-industries/claude-code-acp) and [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) (actively published) — so an ACP-shaped adapter layer is viable too.
- **MCP:** first-class client support (`mcpServers` option) — Windkeel can inject its own tools into the agent. In-process custom tools, hooks, subagents, skills, and plugins are all SDK options.

### 1.3 Structured event streaming

SDK emits typed messages: `system` (subtype `init`, carries `session_id`), `assistant`, `user`, `stream_event` (token-level partials when enabled), and `result` (with subtypes like `success`, `error_max_turns`). Subagent messages carry `parent_tool_use_id`. Lifecycle **hooks** (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, …) and the `canUseTool` permission callback give synchronous, in-process control points. ([overview](https://code.claude.com/docs/en/agent-sdk/overview); [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode))

### 1.4 Pause / resume / interrupt

- **Streaming input mode** (async-generator prompt) is the recommended long-lived-session mode and supports queued messages and **real-time interruption** (`interrupt()` on the query/client); single-message mode does not. ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode))
- **No true "pause"**: the envelope is *interrupt-now, resume-later*. Sessions persist as JSONL; `resume: sessionId`, `continue`, and `forkSession` restore full context. ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions))
- Permission callbacks/hooks act as natural pause points: the agent blocks awaiting an approval decision.

### 1.5 BYO API key

`ANTHROPIC_API_KEY`, Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Google Vertex (`CLAUDE_CODE_USE_VERTEX=1`), Microsoft Foundry, Claude-on-AWS. Anthropic models only; consumer-subscription auth prohibited (see 1.1). ([overview → Set your API key](https://code.claude.com/docs/en/agent-sdk/overview))

---

## 2. OpenAI Codex CLI

### 2.1 Licensing & ToS

- **Apache-2.0** ([openai/codex LICENSE](https://github.com/openai/codex/blob/main/LICENSE)). Embedding, redistribution, and even forking inside an open-source Windkeel are unambiguous. Model usage is governed by OpenAI's usage policies/API terms, not the CLI license.
- One embedding-specific note: app-server `clientInfo.name` identifies the client for the "OpenAI Compliance Logs Platform"; enterprise-targeted integrations are asked to register with OpenAI. ([app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))
- ChatGPT-plan login for automation is documented as an "advanced" path (seeding `~/.codex/auth.json`), but for an embedded multi-user platform, API-key auth is the recommended, safe path. ([non-interactive docs](https://developers.openai.com/codex/noninteractive))

### 2.2 Integration surface

Four viable surfaces, in increasing richness:

1. **`codex exec --json`** — headless one-shot subprocess emitting JSONL; `--output-schema` for JSON-Schema-validated final output; `--ephemeral`, sandbox flags. ([non-interactive mode](https://developers.openai.com/codex/noninteractive))
2. **`@openai/codex-sdk`** (TypeScript) — wraps the CLI, exchanges JSONL over stdio; `startThread()`, `resumeThread(id)`, `run()` / `runStreamed()` (async generator of structured events). ([Codex SDK docs](https://developers.openai.com/codex/sdk), [npm](https://www.npmjs.com/package/@openai/codex-sdk))
3. **`codex app-server`** — a stateful long-lived JSON-RPC 2.0 process over stdio/WebSocket/Unix socket. This is what the Codex IDE extension itself uses, and it is essentially a superset of Windkeel's `AgentAdapter`: `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer` (inject input mid-turn), `turn/interrupt`, approvals flowing **bidirectionally** (server requests approval, execution pauses until the client responds), plus `command/exec`, fs APIs, config APIs. `codex app-server generate-ts` emits matching TypeScript types. ([app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md); [OpenAI blog: Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/))
4. **`codex mcp-server`** — run Codex as an MCP server; community ACP adapters also exist ([beyond5959/acp-adapter](https://github.com/beyond5959/acp-adapter)).

### 2.3 Structured event streaming

- `exec --json`: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`/`item.completed` with item types `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `error`. ([non-interactive mode](https://developers.openai.com/codex/noninteractive))
- app-server adds streaming deltas (`item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/toolUse/delta`), `thread/status/changed`, token usage on `turn/completed`, and backpressure semantics (JSON-RPC `-32001` overload error). ([app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))

### 2.4 Pause / resume / interrupt

- **Interrupt:** `turn/interrupt` cancels an in-flight turn; the turn completes with `status: "interrupted"`. `turn/steer` appends guidance to a running turn without starting a new one — richer than plain cancel.
- **Resume:** `codex exec resume --last` / `resume <SESSION_ID>`; app-server `thread/resume` and `thread/fork`. Sessions persist in `~/.codex/sessions`.
- **No true pause/freeze** of a running turn; the envelope is interrupt + resume, same as Claude.

### 2.5 BYO API key

`OPENAI_API_KEY` / `CODEX_API_KEY`, or **any custom provider** speaking the Responses API via `[model_providers.*]` in `config.toml` (`base_url`, `env_key`, `wire_api`) — Azure, OpenRouter, Ollama, local models. Project-local config cannot override provider auth (a sane security boundary for embedding). ([Advanced configuration](https://developers.openai.com/codex/config-advanced))

---

## 3. OpenHands (+ OpenHands Software Agent SDK)

### 3.1 Licensing & ToS

- App repo [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands): **MIT**, except the `enterprise/` directory (separate proprietary license). ([LICENSE](https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE))
- The newer [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) ("the engine behind the OpenHands CLI and OpenHands Cloud"): **MIT**. No ToS beyond the LLM provider's own terms — it is a pure framework, not a hosted model product.
- Redistribution inside an OSS Windkeel: unrestricted (steer clear of `enterprise/`).

### 3.2 Integration surface

- **Python SDK:** `Agent(llm=..., tools=[...])` + `Conversation(agent=..., workspace=...)`; `conversation.run()` executes until `FinishAction`, stuck detection, budget exhaustion, or explicit pause. Local and remote (`agent-server` via Docker, REST/WebSocket) conversation implementations. ([SDK repo](https://github.com/OpenHands/software-agent-sdk); [docs](https://docs.openhands.dev/sdk))
- Listed among ACP-supporting agents ([agentclientprotocol.com/get-started/agents](https://agentclientprotocol.com/get-started/agents)); MCP tool support in the SDK.
- Python-only SDK (a TypeScript client exists for the agent-server REST API).

### 3.3 Structured event streaming

Event-sourced architecture: all state lives in a `ConversationState`; the conversation is a typed stream of immutable, replayable `Action`/`Observation` Pydantic events with registered callbacks, including a `PauseEvent`. Replay, fork, and full audit trails are inherent to the design. ([conversation state source](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py))

### 3.4 Pause / resume / interrupt

**The only candidate with true first-class pause.** `conversation.pause()` can be called from another thread; the agent halts cooperatively (finishing the in-flight action); calling `run()` again resumes exactly where it left off, and event-sourced state makes resume-after-process-restart and forking natural. ([Pause and Resume guide](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume))

### 3.5 BYO API key

Fully model-agnostic via **LiteLLM**: any provider/model string plus `LLM_API_KEY` (Anthropic, OpenAI, Bedrock, Ollama, etc.). No auth restrictions of its own. ([SDK repo](https://github.com/OpenHands/software-agent-sdk))

---

## 4. Recommendation

### First adapter: **Claude Code via the Claude Agent SDK**

Reasoning:

1. **Best-in-class embedding surface for a TS/Python platform**: in-process typed message stream, hooks, `canUseTool` permission callback, MCP tool injection, session resume/fork — no subprocess protocol to maintain, and the binary ships inside the SDK package.
2. **Strongest agent capability + the ecosystem Windkeel's builder already lives in**; workflows translate 1:1 between the CLI used interactively and the SDK used in production.
3. **Licensing is workable**: embedding is explicitly permitted under the Commercial ToS; Windkeel stays OSS by depending on (not vendoring) the SDK. Constraints to encode now: BYO API key only (never claude.ai OAuth), and no "Claude Code" branding in Windkeel's UI.
4. Codex's app-server is arguably the *cleanest protocol* (it nearly IS `AgentAdapter`), and its Apache-2.0 license is the safest — which is exactly why it should be **adapter #2**, proving the interface generalizes. OpenHands (**#3**) is the only true-pause, fully-MIT, any-model option and a good long-term hedge, but its Python-only SDK and heavier runtime make it a worse first target for a solo builder.

### What this means for the `AgentAdapter` interface

| Method | Verdict | Design note |
|---|---|---|
| `start(task, config)` | **Realistic** (all 3) | Config must carry: provider/auth (env-style key injection), tool allowlist, permission mode, workspace path. |
| `send(input)` | **Realistic** (all 3) | Requires long-lived session mode (SDK streaming input / app-server `turn/start`+`turn/steer` / `Conversation`). Design for mid-turn steering (Codex `turn/steer`; Claude queued messages) as an optional capability. |
| `events(stream)` | **Realistic** (all 3) | Normalize to three layers: **lifecycle** (session-started w/ session-id, turn-started, turn-completed w/ usage, error), **items** (agent_message, reasoning, tool/command execution with optional deltas, file_change), **control** (approval-requested). All three map cleanly onto this. |
| `cancel()` | **Realistic** (all 3) | Claude `interrupt()`, Codex `turn/interrupt`, OpenHands `pause()`+discard; plus SIGTERM as the fallback of last resort. |
| `pause()` / `resume()` | **Aspirational as "freeze"; realistic as "checkpoint"** | Only OpenHands truly pauses a live run. Define `pause` = interrupt current turn + persist session/thread id; `resume` = new turn against the resumed session (`resume: sessionId` / `thread/resume` / `run()`). Do **not** promise mid-tool-call freeze in the interface contract; expose a `capabilities.truePause` flag adapters can advertise. |
| *(add)* `onApprovalRequest(cb)` | **Should be first-class** | All three have bidirectional approval flows (Claude `canUseTool`/hooks, Codex app-server approval requests that block the turn, OpenHands confirmation mode). Windkeel's orchestration layer needs this to route approvals to humans — it is effectively the built-in pause point on every agent. |
| *(add)* `fork(sessionId)` | Cheap win | Claude `forkSession`, Codex `thread/fork`, OpenHands event replay — useful for Windkeel's speculative/parallel runs later. |

---

## Sources

- https://code.claude.com/docs/en/agent-sdk/overview (SDK capabilities, auth, branding, license terms)
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode (streaming input, interruption)
- https://github.com/anthropics/claude-code/blob/main/LICENSE.md (proprietary notice)
- https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use (subscription-auth ban)
- https://github.com/openai/codex/blob/main/LICENSE (Apache-2.0)
- https://developers.openai.com/codex/noninteractive (`codex exec --json` events, resume, structured output, auth)
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (JSON-RPC protocol: thread/turn lifecycle, `turn/interrupt`, `turn/steer`, approvals, deltas)
- https://openai.com/index/unlocking-the-codex-harness/ (app-server rationale)
- https://developers.openai.com/codex/sdk and https://www.npmjs.com/package/@openai/codex-sdk (TS SDK: `runStreamed`, `resumeThread`)
- https://developers.openai.com/codex/config-advanced (custom `model_providers`, BYOK)
- https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE (MIT + enterprise carve-out)
- https://github.com/OpenHands/software-agent-sdk (MIT SDK, Conversation API, LiteLLM)
- https://docs.openhands.dev/sdk/guides/convo-pause-and-resume (true pause/resume)
- https://agentclientprotocol.com/get-started/agents and https://github.com/agentclientprotocol/claude-agent-acp, https://www.npmjs.com/package/@zed-industries/claude-code-acp, https://github.com/beyond5959/acp-adapter (ACP ecosystem)
