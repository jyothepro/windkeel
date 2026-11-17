# ADR-0006: Codex is the first worker; OpenHands returns as the second-worker candidate

- Status: Accepted
- Date: 2026-08-14

## Context

Plan §9 / Milestone 3 requires choosing which coding agent the first `WorkerAdapter` drives: OpenAI Codex CLI or OpenHands.

## Decision

**The first `WorkerAdapter` (Milestone 3) drives OpenAI Codex CLI (`codex exec --json`).**

- §1 — Sessions run headless in the maker sandbox: `codex exec --json` with API-key auth (`CODEX_API_KEY`), prompt over argv/stdin, resumable via `codex exec resume` for repair turns.
- §2 — Codex's own Landlock/seccomp sandbox is redundant inside the Firecracker microVM, where Windkeel's sandbox is authoritative; the adapter runs it with the sandbox mode that lets Windkeel's network policy be the enforcement layer.
- §3 — The orchestrator — not the worker — enforces wall-clock timeouts and kills the process; Codex's known non-TTY/SIGINT rough edges are handled in the adapter (stdin closed explicitly, kill-then-reap on timeout).
- §4 — The adapter normalizes the `thread.*`/`turn.*`/`item.*` JSONL events onto Windkeel's event vocabulary, including the command-classification shim for `test_started`/`test_finished`.
- §5 — Model freedom is deferred, not dropped: OpenHands is the leading candidate for the second-worker milestone, which restores model-agnostic execution and is where the `WorkerAdapter` interface proves it hides worker topology.

## Consequences

- Milestone 3 has no provisioning step for the worker binary and no Python runtime in the maker sandbox — clone, set `CODEX_API_KEY` (or broker it at the egress proxy), run.
- v1 maker inference is effectively tied to OpenAI models; #63 (maker/checker model policy) inherits that constraint for the maker side.
- The adapter carries the churn risk of Codex's fast alpha release cadence; the versioned JSONL schema is the stability contract, and the adapter pins a known-good CLI version per run rather than tracking latest.
- Budget/stuck enforcement lands in the orchestrator where it belongs, and is therefore already in place when the second worker arrives.

**Later changes** (full text in Background):

- Amendment, 2026-09-23 — this ADR names milestones instead of numbering them

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-14
- Resolves: [#59 — Choose the first worker: Codex or OpenHands](https://github.com/jyothepro/orqon/issues/59) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §9 / Milestone 3 requires choosing which coding agent the first `WorkerAdapter` drives: OpenAI Codex CLI or OpenHands. The [worker-adapter comparison](../../research/worker-adapters/findings.md) found both viable headless: JSONL event streams that map cleanly onto Windkeel's normalized events, diffs via `git diff` of the workspace either way, and neither emitting native test events — the command-classification shim is needed regardless of choice. The decision therefore rests on the differentiators, weighed against the criteria in #59:

- **Runs well in the chosen sandbox:** Codex CLI ships preinstalled in Vercel Sandbox's default `universal` image ([vercel-sandbox findings](../../research/vercel-sandbox/findings.md) §7) — zero provisioning per run. OpenHands is not preinstalled and wants a pip/uv install plus its Docker-runtime or SDK topology inside the microVM.
- **Integration surface:** Codex's event schema is flat, explicitly versioned for automation, and has a first-party **TypeScript** SDK — Windkeel is a TS/Node codebase, and the raw `codex exec --json` JSONL stream needs no language bridge. OpenHands' richer event-sourced stream lives behind a **Python** SDK or a REST/WebSocket Agent Server: a language seam and an extra long-running process per run.
- **Model flexibility:** OpenHands wins outright (any LiteLLM provider, model-agnostic by design); Codex supports OpenAI-compatible third-party endpoints but its harness is tuned for OpenAI models. This is Codex's real cost.
- **Safety rails:** OpenHands ships iteration caps, budget limits, and stuck detection; Codex exec has none and has had SIGINT/non-TTY rough edges. Mitigating fact: Windkeel's orchestrator must own wall-clock, iteration, and repair caps anyway (§14, #64) — the factory cannot delegate its budget enforcement to a worker's internals, so the rails Windkeel builds are needed under either choice.
- **Licensing and cost:** no separator — Apache-2.0 vs MIT core, both tokens-only self-hosted; Codex adds optional subscription-quota economics.

### Decision

**The first `WorkerAdapter` (Milestone 3) drives OpenAI Codex CLI (`codex exec --json`).**

Shape of the adapter this implies:

1. Sessions run headless in the maker sandbox: `codex exec --json` with API-key auth (`CODEX_API_KEY`), prompt over argv/stdin, resumable via `codex exec resume` for repair turns.
2. Codex's own Landlock/seccomp sandbox is redundant inside the Firecracker microVM, where Windkeel's sandbox is authoritative; the adapter runs it with the sandbox mode that lets Windkeel's network policy be the enforcement layer.
3. The orchestrator — not the worker — enforces wall-clock timeouts and kills the process; Codex's known non-TTY/SIGINT rough edges are handled in the adapter (stdin closed explicitly, kill-then-reap on timeout).
4. The adapter normalizes the `thread.*`/`turn.*`/`item.*` JSONL events onto Windkeel's event vocabulary, including the command-classification shim for `test_started`/`test_finished`.
5. **Model freedom is deferred, not dropped:** OpenHands is the leading candidate for the second-worker milestone, which restores model-agnostic execution and is where the `WorkerAdapter` interface proves it hides worker topology.

### Consequences

- Milestone 3 has no provisioning step for the worker binary and no Python runtime in the maker sandbox — clone, set `CODEX_API_KEY` (or broker it at the egress proxy), run.
- v1 maker inference is effectively tied to OpenAI models; #63 (maker/checker model policy) inherits that constraint for the maker side. Checker-side models are unaffected.
- The adapter carries the churn risk of Codex's fast alpha release cadence; the versioned JSONL schema is the stability contract, and the adapter pins a known-good CLI version per run rather than tracking latest.
- Budget/stuck enforcement lands in the orchestrator where it belongs, and is therefore already in place when the second worker arrives.
- If Codex's third-party-model quality or its CI rough edges become blocking before that milestone, the recorded fallback is OpenHands under the same `WorkerAdapter` — the comparison research stays the map for that move.

### Amendment, 2026-09-23 — this ADR names milestones instead of numbering them

The roadmap's M7–M15 were reordered (`research/MILESTONES.md`, *The 2026-09-23 reordering*). No
decision here changes: the deliverables moved position, not content. Every milestone *number* in
this record was replaced with the milestone's *name*, because a number written into a decision
record becomes wrong the first time the roadmap resequences, and a wrong number is worse than no
number. The mapping table in `MILESTONES.md` decodes the old numbers still visible in git history.

The second-worker milestone is now **M11**.
