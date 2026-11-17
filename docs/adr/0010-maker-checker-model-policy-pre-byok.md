# ADR-0010: Pre-BYOK model policy — OpenAI makes, Anthropic checks, maker identity is explicit

- Status: Accepted; amended by ADR-0027
- Date: 2026-08-17

## Context

Plan §11's invariant — the checker model may be forced to differ from the maker's — is already implemented on `main`: `selectGateway`/`makerIdentity` in `src/providers/index.ts` filter checker endpoints by maker vendor and exact model, throwing `NoIndependentProviderError` when nothing independent remains.

## Decision

**Pre-BYOK, the maker is Codex on OpenAI models and the checker defaults to Anthropic; the factory always passes the maker's identity into the checker policy explicitly, and vendor-plus-exact-model independence stays a hard invariant.**

- §1 — Maker: the Codex CLI's default OpenAI model, pinned to an exact model per run — recorded as `EngineeringRun.selected_model` and on every `AgentRun.model` (ADR-0003 fields).
- §2 — Checker: Anthropic by default (`claude-sonnet-4-5`, the existing `DEFAULT_MODELS` value on `main`), operator-overridable per policy.
- §3 — Independence extends to worker-driven making by explicitness, not inference: when the factory spawns a verification, it sets `ModelPolicy.maker = { vendor: "openai", model: <the run's exact maker model> }` from its own records.
- §4 — `NoIndependentProviderError` is run-fatal: a factory run whose policy leaves no independent checker fails (`FAILED`, reason recorded) — verification is never silently skipped and never falls back to a dependent checker.
- §5 — BYOK changes the key source, not the invariant: the BYOK milestone adds customer endpoints into `ModelPolicy.endpoints`; this ADR's defaults become the fallback and the independence filter continues to apply unchanged.

## Consequences

- The v1 default configuration is exactly two operator keys in the worker container: OpenAI (maker, via `CODEX_API_KEY`) and Anthropic (checker) — and the maker/checker pair is cross-vendor by default, the strongest independence posture available without BYOK.
- Explicit maker identity closes an inference hole: a repair commit authored via the worker could otherwise be misattributed by the PR-author heuristic; the factory's own record is now authoritative.
- Pinned exact models per run make `AgentRun`/`VerificationRun` rows sufficient for the §20 cost and provenance queries without consulting external config history.
- If Anthropic is unavailable, the operator adds a different non-OpenAI endpoint (e.g. via the existing OpenAI-compatible gateway pointing at another vendor); pointing the checker at OpenAI stays impossible by construction while the maker is Codex.

**Later changes** (full text in Background):

- Amendment, 2026-09-23 — this ADR names milestones instead of numbering them

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-17
- Resolves: [#63 — Decide the maker/checker model policy for v1 (pre-BYOK)](https://github.com/jyothepro/orqon/issues/63) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §11's invariant — the checker model may be forced to differ from the maker's — is already implemented on `main`: `selectGateway`/`makerIdentity` in `src/providers/index.ts` filter checker endpoints by maker vendor and exact model, throwing `NoIndependentProviderError` when nothing independent remains. Today the maker identity is *inferred* from the PR author, because the CLI/Action verifies work it didn't make. In the factory, the maker is chosen by Windkeel itself, which changes what the policy must say.

What's already fixed: ADR-0006 makes Codex the worker, tying v1 maker inference to OpenAI models — §63's decision inherits that on the maker side. BYOK is a later milestone and out of scope here; all keys are operator-supplied. ADR-0002 puts model keys in the worker container's environment, not the ingress functions.

### Decision

**Pre-BYOK, the maker is Codex on OpenAI models and the checker defaults to Anthropic; the factory always passes the maker's identity into the checker policy explicitly, and vendor-plus-exact-model independence stays a hard invariant.**

1. **Maker**: the Codex CLI's default OpenAI model, pinned to an exact model per run — recorded as `EngineeringRun.selected_model` and on every `AgentRun.model` (ADR-0003 fields). One model serves all `AgentRun` roles (implementer, repairer) in v1; per-role routing is the planner milestone's territory.
2. **Checker**: Anthropic by default (`claude-sonnet-4-5`, the existing `DEFAULT_MODELS` value on `main`), operator-overridable per policy. The checker model is recorded on the `VerificationRun` via its policy version.
3. **Independence extends to worker-driven making by explicitness, not inference**: when the factory spawns a verification, it sets `ModelPolicy.maker = { vendor: "openai", model: <the run's exact maker model> }` from its own records. `makerIdentity`'s author-inference path remains only for the standalone CLI/GitHub Action, where the maker is genuinely unknown. The existing filter semantics are unchanged: a checker endpoint is rejected if it shares the maker's vendor, or serves the maker's exact model through any aggregator.
4. **`NoIndependentProviderError` is run-fatal**: a factory run whose policy leaves no independent checker fails (`FAILED`, reason recorded) — verification is never silently skipped and never falls back to a dependent checker.
5. **BYOK changes the key source, not the invariant**: the BYOK milestone adds customer endpoints into `ModelPolicy.endpoints`; this ADR's defaults become the fallback and the independence filter continues to apply unchanged.

### Consequences

- The v1 default configuration is exactly two operator keys in the worker container: OpenAI (maker, via `CODEX_API_KEY`) and Anthropic (checker) — and the maker/checker pair is cross-vendor by default, the strongest independence posture available without BYOK.
- Explicit maker identity closes an inference hole: a repair commit authored via the worker could otherwise be misattributed by the PR-author heuristic; the factory's own record is now authoritative.
- Pinned exact models per run make `AgentRun`/`VerificationRun` rows sufficient for the §20 cost and provenance queries without consulting external config history.
- If Anthropic is unavailable, the operator adds a different non-OpenAI endpoint (e.g. via the existing OpenAI-compatible gateway pointing at another vendor); pointing the checker at OpenAI stays impossible by construction while the maker is Codex.
- Amended by [ADR-0027](0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md) §4: the operator's checker defaults are an ordered multi-vendor list (`WINDKEEL_CHECKER_VENDORS`, default `anthropic,openai`), and intake takes the first independent of the run's maker, so a maker on Anthropic's models (the Claude Code harness) gets the OpenAI checker. Independence is still enforced by vendor; nothing here relaxes it.

### Amendment, 2026-09-23 — this ADR names milestones instead of numbering them

The roadmap's M7–M15 were reordered (`research/MILESTONES.md`, *The 2026-09-23 reordering*). No
decision here changes: the deliverables moved position, not content. Every milestone *number* in
this record was replaced with the milestone's *name*, because a number written into a decision
record becomes wrong the first time the roadmap resequences, and a wrong number is worse than no
number. The mapping table in `MILESTONES.md` decodes the old numbers still visible in git history.

BYOK is now **M9**; the planner is now **M10**.
