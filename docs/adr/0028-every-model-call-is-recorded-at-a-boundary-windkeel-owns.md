# ADR-0028: Every model call is recorded, whole, at a boundary Windkeel owns

- Status: Proposed
- Date: 2026-10-16

## Context

Nothing recorded every model call whole — maker traffic was invisible inside the harness — so runs could be neither evaluated nor audited after the fact.

## Decision

- §1 — Every model call produces one `ModelCallRecord`, maker and checker alike: The record is the unit of evaluation and of audit.
- §2 — The maker's model traffic goes through a Windkeel-owned model proxy: Each harness is pointed at it through its own base-URL setting (Codex `model_providers.*.base_url`, Claude Code `ANTHROPIC_BASE_URL`, OpenCode's provider `baseURL`), which is what makes the capture harness-neutral.
- §3 — The checker records in-process: `ModelGateway` writes the same record around each call.
- §4 — The harness's native session log is collected as an artifact: at the end of every turn and by the reaper before a sandbox is destroyed.
- §5 — Bodies live in object storage; Postgres keeps the index: ADR-0013 §1 keeps per-token detail out of Postgres, and this keeps to it.
- §6 — The record is written before the call is forwarded, and fails closed.
- §7 — Tamper evidence is a per-run hash chain: Each record's `prev_hash` is the previous record's hash in the same run.
- §8 — Secrets are redacted before anything is written: Request headers are never stored.
- §9 — Retention follows ADR-0015's tiers: Records and transcripts behind a verdict of record are kept as long as it is; those of superseded repair cycles go with their packages.
- §10 — Reads are organization-scoped and themselves recorded: Records are readable only through the control-plane API (ADR-0023) by principals of the run's organization, and each read of a body is logged.

## Consequences

- **Cost is recorded per call, at the call.** The proxy sees usage on every response, so `cost_event` can be written as calls happen rather than when a stage completes, and ADR-0011's spend rail can stop a run between calls instead of after a turn.
- **The proxy is on the critical path of every maker turn.** It adds a hop, and an outage stops makers.
- **Long streamed responses meet function duration limits.** If the proxy runs as a Vercel function, a response that streams longer than the function's maximum is cut.
- **Storage grows with every run.** Bodies repeat — each request carries the conversation so far — so content addressing will not deduplicate whole requests.

**Later changes** (full text in Background):

- Open questions

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Proposed
- Date: 2026-10-16
- Tracking: [#357 — Record every model call and agent transcript for eval and governance](https://github.com/jyothepro/orqon/issues/357)
- Amends: [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §1 (where the maker's key is attached), [ADR-0013](0013-v1-observability-cost-ledger-transition-log-sql-views.md) §1 (cost is written per call, at the call)
- Relates: [ADR-0015](0015-evidence-retention-outcome-tiered-with-tombstones.md), [ADR-0026](0026-byok-org-sealed-model-credentials-and-a-per-run-model-snapshot.md), [ADR-0027](0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md)

### Context

Two needs, neither met today:

- **Evaluation.** Comparing harnesses, models and prompt versions (ADR-0027 makes all three
  per-run choices) needs the exact request each model saw and the exact response it gave, joined
  to the run's outcome. Without that, "Claude Code is better on this repository" is anecdote.
- **Governance.** For any change Windkeel pushed, an operator or an organization must be able to
  answer *what the agent was told, what it decided, what it ran, and on whose key* — after the
  sandbox is gone, and without trusting the agent's own account of it.

What exists on `main`:

- **`agent_event` (migrations/0022)** keeps the harness's normalized steps — reasoning item,
  message, command, test, file change — with every text field capped at 4,000 characters. It is
  explicitly "not a transcript". It is what the harness *chose to report*, after normalization.
- **`cost_event`** keeps tokens and dollars, written when a stage completes. **The transition
  log** keeps why the run moved. **The evidence package** keeps the verdict and its criteria.
- **The checker's model calls** (`packages/verification/src/providers`: review, mapping,
  criteria) are made by Windkeel's own `fetch`-based `ModelGateway`. Their prompts and responses are
  not kept anywhere.
- **The maker's model calls** never pass through Windkeel code. The harness in the sandbox talks to
  the provider; the real key is attached by the sandbox provider's egress proxy (ADR-0014 §1,
  `credential-broker.ts`), which Windkeel configures but cannot read traffic from. The three harnesses
  (ADR-0027) each keep a native session log in a different format, inside a sandbox that is reaped.

So the full record of a run's model traffic exists only transiently, in places Windkeel does not own,
written by the software being governed.

Alternatives considered:

- **Harness-native transcripts as the record** (Codex `~/.codex/sessions/*.jsonl`, Claude Code's
  session JSONL, OpenCode's store), copied out at turn end. Rich and cheap, but three formats that
  change with each pinned version, lost if the sandbox dies before the copy, and authored by the
  process under audit. Kept as a secondary source (§4), not the record.
- **The sandbox provider's egress proxy.** Already on the path, but it injects a header; it does
  not expose bodies, and a governance record should not depend on a vendor feature we cannot test.
- **A hosted LLM observability product or Vercel AI Gateway logging.** Sends every prompt —
  including repository source and customer-key traffic — to a further third party, and ADR-0026 §8
  already declined AI Gateway for M9. Revisit only if the proxy in §2 proves costly to operate.
- **Sampling.** An audit trail with gaps answers "usually"; governance needs "always".

### Decision

1. **Every model call produces one `ModelCallRecord`, maker and checker alike.** The record is the
   unit of evaluation and of audit. It holds: `engineering_run_id`, `agent_run_id` or
   `verification_run_id`, role (`maker | checker`), purpose (`implement | repair | review |
   mapping | criteria | …`), harness id and version, provider, model, `base_url`, key source and
   `credential_id` (ADR-0026 §9 — the id, never the value), prompt template id and version where
   Windkeel authored the prompt, request and response body references and their `sha256`, usage,
   latency, status, and `prev_hash`.

2. **The maker's model traffic goes through a Windkeel-owned model proxy.** Each harness is pointed
   at it through its own base-URL setting (Codex `model_providers.*.base_url`, Claude Code
   `ANTHROPIC_BASE_URL`, OpenCode's provider `baseURL`), which is what makes the capture
   harness-neutral. The sandbox holds a **run-scoped proxy token** in place of today's placeholder:
   valid for one agent run, until the run ends, for the snapshot's provider and model only. The
   proxy attaches the real key — so key brokering moves from the sandbox provider's egress proxy
   into code Windkeel owns and tests, and ADR-0014 §1's property (no reusable key in the sandbox)
   holds unchanged. Execution-phase egress narrows to the proxy's host instead of the provider's.
   Honouring a base URL becomes an ADR-0027 §3 conformance obligation; a harness that cannot is not
   eligible as a production maker.

3. **The checker records in-process.** `ModelGateway` writes the same record around each call.
   One record shape, two writers.

4. **The harness's native session log is collected as an artifact**, at the end of every turn and
   by the reaper before a sandbox is destroyed. It is the harness's own structure of the session
   (tool calls, their outputs, its compaction decisions) and is stored beside the records, linked
   by `agent_run_id`. It is evidence of what the harness claims; the proxy record is evidence of
   what the model was actually sent.

5. **Bodies live in object storage; Postgres keeps the index.** ADR-0013 §1 keeps per-token detail
   out of Postgres, and this keeps to it. Bodies are gzip'd and content-addressed by `sha256` in
   Supabase Storage (the evidence package's store, ADR-0008); `model_call` rows hold the metadata in
   §1 and the references. Streamed responses are stored assembled, not as deltas.

6. **The record is written before the call is forwarded, and fails closed.** The request body and
   its index row are committed before the proxy forwards; a call that cannot be recorded is not
   made, and the harness sees a provider-shaped error. The response is teed to storage as it
   streams. A response whose write fails marks the record `response_unrecorded` and flags the run;
   it does not kill it, because the model has already been paid for and the agent has already
   acted on it.

7. **Tamper evidence is a per-run hash chain.** Each record's `prev_hash` is the previous record's
   hash in the same run. The chain head is written into the evidence package when it seals, so the
   verdict of record also attests to the model traffic behind it.

8. **Secrets are redacted before anything is written.** Request headers are never stored. Bodies
   pass through the redactor ADR-0026 §3 already requires, registered with the opened model key,
   the repository's secrets (ADR-0023 §9) and the run's git token. Redaction is recorded on the
   record, so an evaluator knows a body was altered.

9. **Retention follows ADR-0015's tiers.** Records and transcripts behind a verdict of record are
   kept as long as it is; those of superseded repair cycles go with their packages. Pruning removes
   bodies and leaves the index row with its hashes — a tombstone, as ADR-0015 §3. An organization
   may shorten its own retention; Windkeel does not lengthen it without the organization's consent,
   because a customer-key run's traffic is the customer's data.

10. **Reads are organization-scoped and themselves recorded.** Records are readable only through
    the control-plane API (ADR-0023) by principals of the run's organization, and each read of a
    body is logged. Evaluation exports are a read like any other.

### Consequences

- **Cost is recorded per call, at the call.** The proxy sees usage on every response, so
  `cost_event` can be written as calls happen rather than when a stage completes, and ADR-0011's
  spend rail can stop a run between calls instead of after a turn.
- **The proxy is on the critical path of every maker turn.** It adds a hop, and an outage stops
  makers. It must be the simplest code in the system: authenticate, record, forward, tee.
- **Long streamed responses meet function duration limits.** If the proxy runs as a Vercel
  function, a response that streams longer than the function's maximum is cut. This must be
  measured against real maker turns before the proxy's host is chosen; a small always-on service
  is the fallback.
- **Storage grows with every run.** Bodies repeat — each request carries the conversation so far —
  so content addressing will not deduplicate whole requests. Measure before optimizing; storing
  per-turn deltas is a later change that does not alter the record's meaning.
- **`agent_event` stays.** It is the live feed a person watches; this is the record an evaluator
  or auditor reads. They answer different questions and are not merged.

### Open questions

- Where the proxy runs (§Consequences, duration limits), and whether it shares the stage
  deployment's environment, given ADR-0026's note that code execution there reads every key.
- Whether all three pinned harness versions honour a base URL for every call they make, including
  sub-agents, title generation and compaction — to be established by the conformance suite.
- Default retention for organizations that set none, and whether evaluation exports need consent
  separate from viewing.
