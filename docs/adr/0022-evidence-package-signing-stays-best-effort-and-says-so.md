# ADR-0022: Evidence package signing stays best-effort, and every unsigned package says so

- Status: Accepted
- Date: 2026-09-22

## Context

The first successful live run — `2329bb84-d81c-4caf-967e-856a2c590c61`, 2026-09-19, producing draft PR jyothepro/content-machine#90 — produced an evidence package with `signed: false`.

## Decision

**Signing stays best-effort. Packages produced by the deployed control plane are unsigned, this is intended, and every surface that reports a verdict says so when it is true.**

- §1 — `signPackage` keeps its current contract: No ambient OIDC identity means an unsigned package, not a failed run.
- §2 — Deployed packages are unsigned, on purpose, and this record is the statement of it: The next person meets this sentence instead of rediscovering it from a run, which is the acceptance criterion #232 wrote for exactly this outcome.
- §3 — `signed: false` is surfaced, not merely stored: It was already recorded on `verification_run.risk_summary`.
- §4 — The signed case renders nothing: A row reading "signed" on every run teaches an operator to skip the line, which is precisely how the unsigned case would go unread.
- §5 — Not recorded is not the same as unsigned: A row predating the field, or a run with no completed verification, renders nothing rather than claiming an unsigned package.
- §6 — `windkeel doctor` says nothing about signing capability: It reports what would stop a run or make one unverifiable, and an unsigned package is now a policy rather than a fault.

## Consequences

- **The silent situation ends without buying infrastructure.** The gap #232 named — six months from now, can someone tell "never meant to be signed" from "something went wrong"?
- **`sigstore.ts`'s doc comment is corrected.** It described a premise that expired with ADR-0020: it said "a local run without an OIDC identity", which reads as though the deployed path has one.
- **This is not a security regression.** Nothing that was signed becomes unsigned.
- **The cheapest real option was preferred to the most principled one, deliberately.** Requiring signatures would be the stronger statement and is rejected on cost-for-benefit under ADR-0001, not on principle — with the conditions that reverse it written above, because a decision whose reversal conditions are unstated is one the next person has to re-argue from scratch.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-22
- Resolves: [#232 — Decide whether deployed evidence packages must be signed](https://github.com/jyothepro/orqon/issues/232)

### Context

The first successful live run — `2329bb84-d81c-4caf-967e-856a2c590c61`, 2026-09-19, producing draft PR jyothepro/content-machine#90 — produced an evidence package with `signed: false`.

That is not a bug. `packages/verification/src/attest/sigstore.ts` is explicit about it, and its doc comment states the intent: *"Signing is best-effort by design: a local run without an OIDC identity produces an unsigned package rather than no package."* `canSignKeyless` looks for `ACTIONS_ID_TOKEN_REQUEST_TOKEN` or `SIGSTORE_ID_TOKEN`, a Vercel function has neither, and so **every package the deployed control plane produces is unsigned.**

The behaviour was designed when the factory ran in CI or on a developer's machine, where "unsigned because local" was the honest description. [ADR-0020](0020-the-control-plane-is-vercel-end-to-end.md) moved the control plane to Vercel and that premise expired without anyone revisiting it.

#### The load-bearing fact, established before choosing

#232 asked that whether Vercel can supply a Fulcio-usable OIDC identity be settled *before* the decision rather than after, because it prices one of the options. It was, and the answer is in two parts.

**Vercel can supply an OIDC identity.** OIDC federation is generally available. With it enabled, Vercel signs a short-lived token per function invocation and attaches it to the request as `x-vercel-oidc-token`; the issuer is `https://oidc.vercel.com/[team]` (team mode) or `https://oidc.vercel.com` (global), with JWKS published under `/.well-known/jwks` and custom audiences supported.

**Fulcio does not trust it.** The public-good Sigstore instance's trusted-issuer list (`sigstore/fulcio`, `config/identity/config.yaml`) carries 22 issuers — `token.actions.githubusercontent.com`, `gitlab.com`, `oidc.circleci.com`, `oidc.codefresh.io`, `agent.buildkite.com`, `accounts.google.com` and others. **Neither `vercel.com` nor `oidc.vercel.com` is among them.** A Vercel OIDC token is therefore a perfectly good identity that Fulcio will not issue a certificate against.

So "production packages must be signed" is not a configuration change. It costs one of: an upstream change to Fulcio's issuer list, on someone else's schedule; a privately operated Fulcio and Rekor; or abandoning keyless signing for a managed key, which is a key-custody story — rotation, storage, blast radius — for a single-tenant product ([ADR-0001](archive/0001-v1-single-tenant-product-shape.md)).

#### What signing would and would not add

The package is **already tamper-evident without a signature**. The DSSE envelope covers `sha256(hashes.json)`, which covers every file; `windkeel verify-package` recomputes the chain and refuses a package whose digests do not match. A signature adds **provenance** — *who produced this* — not integrity.

Provenance matters when the consumer of a verdict must trust it without trusting whoever handed it over. Under ADR-0001 the factory is single-tenant and the only consumer is the operator who owns it, who obtained the package from their own object store using their own credentials. That is a question nobody is currently asking.

It is not a question nobody will *ever* ask, which is why this record states its own expiry condition rather than pretending the answer is permanent.

### Decision

**Signing stays best-effort. Packages produced by the deployed control plane are unsigned, this is intended, and every surface that reports a verdict says so when it is true.**

Concretely:

1. **`signPackage` keeps its current contract.** No ambient OIDC identity means an unsigned package, not a failed run. The local path is unchanged, and a run in GitHub Actions still signs.
2. **Deployed packages are unsigned, on purpose, and this record is the statement of it.** The next person meets this sentence instead of rediscovering it from a run, which is the acceptance criterion #232 wrote for exactly this outcome.
3. **`signed: false` is surfaced, not merely stored.** It was already recorded on `verification_run.risk_summary`. It is now rendered by both report surfaces — the CLI's `windkeel run report` and the GitHub check-run summary — through one shared helper, as [#228](https://github.com/jyothepro/orqon/issues/228) did for incomplete stages, so the two cannot disagree.
4. **The signed case renders nothing.** A row reading "signed" on every run teaches an operator to skip the line, which is precisely how the unsigned case would go unread. Only the absence is reported, and it is reported with its consequence — tamper-evident, no provenance — rather than as a bare boolean.
5. **Not recorded is not the same as unsigned.** A row predating the field, or a run with no completed verification, renders nothing rather than claiming an unsigned package. The report's field is `boolean | null` for this reason.
6. **`windkeel doctor` says nothing about signing capability.** It reports what would stop a run or make one unverifiable, and an unsigned package is now a policy rather than a fault. A check that reports "cannot sign" on every deployed run, forever, is a check that trains its reader to ignore the section it lives in.

#### What would change this answer

Stated so the next person meets a trigger rather than re-deriving the reasoning:

- **A consumer who is not the operator.** Anyone who receives a verdict without also holding the credentials to the store it came from needs provenance, because integrity alone cannot tell them who produced the thing. Multi-tenancy (superseding ADR-0001), a customer-facing verdict, or an auditor are all this trigger.
- **Fulcio adding Vercel as a trusted issuer.** That collapses the cost of option 2 to enabling OIDC federation and a `cosign` invocation, at which point the balance of this record no longer holds and it should be revisited rather than defended.
- **A run whose verdict is cited outside the system** — in a compliance artefact, a security review, a contract.

### Consequences

- **The silent situation ends without buying infrastructure.** The gap #232 named — six months from now, can someone tell "never meant to be signed" from "something went wrong"? — is closed by this record plus the rendered row, which is where the question is actually asked.
- **`sigstore.ts`'s doc comment is corrected.** It described a premise that expired with ADR-0020: it said "a local run without an OIDC identity", which reads as though the deployed path has one. It now names the deployed path and points here.
- **This is not a security regression.** Nothing that was signed becomes unsigned. Integrity is unchanged, and `verify-package` is unchanged.
- **The cheapest real option was preferred to the most principled one, deliberately.** Requiring signatures would be the stronger statement and is rejected on cost-for-benefit under ADR-0001, not on principle — with the conditions that reverse it written above, because a decision whose reversal conditions are unstated is one the next person has to re-argue from scratch.
- **It overlaps with #228 and resolves the same class of problem.** A reported result that omits something true about the package is the failure both address. Sharing `incompleteLines`' pattern rather than inventing a second one is deliberate.
- **No implementation follow-up is filed**, because the decision is "best-effort stays". If the triggers above fire, the follow-up begins with establishing whether Fulcio's issuer list has moved, since that is what sets the price.
