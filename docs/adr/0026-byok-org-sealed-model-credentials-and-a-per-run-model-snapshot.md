# ADR-0026: BYOK — organizations bring sealed model credentials, and every run freezes its models at intake

- Status: Proposed
- Date: 2026-10-06

## Context

M9's goal is *make Windkeel model-neutral* (`research/direction-change/PLAN.md` §M9): an organization runs the factory on its own model keys and its own model choices, maker/checker independence stays enforced, and every dollar is accounted for.

## Decision

- §1 — Credentials are organization-scoped rows, sealed: A `model_credential` row carries `organization_id`, `provider`, optional `base_url`, a label, `last4`, a `status` (`unverified | valid | invalid | revoked`) and the sealed value.
- §2 — The sealed box gets a v2 format: The additional data binds the *context* — for a model credential, `model_credential:<organization_id>:<credential_id>` — so a ciphertext copied to another organization's row fails to open.
- §3 — Plaintext lives only inside one handler call on the stage deployment: It is opened where it is used, never passed as a step argument or result, never written to a row, never logged.
- §4 — Model policy is layered and frozen per run: Organization default → repository override → task override, each naming a role (`maker`, `checker`), a model, and either a credential or *Windkeel-managed* (the operator keys of today).
- §5 — Independence is checked at intake, on the snapshot: The vendor is derived from the model, not the router: `openrouter` + `anthropic/claude-*` is `anthropic`.
- §6 — No silent fallback: A customer credential that is revoked, invalid, rate-limited or out of quota fails the run with a reason naming the credential.
- §7 — The maker is told its model: Codex receives `--model` and, for a non-default provider, its `model_providers` overrides on the command line (`-c`), pointing at a placeholder environment variable.
- §8 — The checker stays on the Windkeel-owned `ModelGateway`, `fetch`-based: OpenRouter and other OpenAI-compatible endpoints use the existing compatible gateway.
- §9 — Prices come from a model catalog: overridable by environment, and every cost event records its key source (`windkeel` or `customer`).
- §10 — Claude as the maker is out of scope: — Codex speaks OpenAI's wire formats; a second worker is M11.

## Consequences

- **What the sealed box does and does not separate, stated precisely.** Since #213 (ADR-0020), ingress and the workflow steps are **one Vercel deployment**: a queue message is addressed to the producer's own deployment, so the private key is in the same function environment as the internet-facing routes.
- Validating a credential needs the private key, so validation runs on the stage deployment, not in the request that stored it.
- Every stage now reads models from the run, not the process.
- Passing `--model` to Codex changes behaviour for existing deployments that relied on Codex's default without knowing it.

**Later changes** (full text in Background):

- As built

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Proposed
- Date: 2026-10-06
- Milestone: 9 (BYOK and model routing)
- Amends: [ADR-0010](0010-maker-checker-model-policy-pre-byok.md) §5 (as it anticipated), [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) §1

### Context

M9's goal is *make Windkeel model-neutral* (`research/direction-change/PLAN.md` §M9): an
organization runs the factory on its own model keys and its own model choices, maker/checker
independence stays enforced, and every dollar is accounted for.

What exists on `main` at the start of M9:

- **Every model setting is process environment, loaded once per warm instance.** The checker's
  endpoints are built in `worker-config.ts` from `ANTHROPIC_API_KEY` alone; the maker's key is
  named by `WINDKEEL_MODEL_KEY_ENV_VAR`; prices are three global `WINDKEEL_USD_PER_*` numbers.
  `engineering_run.selected_model` exists and is never written.
- **Codex is never told which model to use.** `WINDKEEL_MAKER_MODEL` is recorded in
  `agent_run.model` but never reaches the `codex exec` argv, so the maker runs on Codex's built-in
  default and the record may not match reality. Independence is checked against the recorded name.
- **The credential broker reads `process.env[rule.secretEnvVar]`** (`credential-broker.ts`). A rule
  can name a variable, not carry a value, so a per-organization key has no way in.
- **A sealed box already exists** (`secret-box.ts`, ADR-0023 §9): ingress holds only the public
  key and can store a secret it cannot read; the stage deployment holds the private key. Its AEAD
  additional data is `version:keyName`, and it has no notion of which key pair sealed a value.
- **Vercel Workflow journals step arguments and results.** Today only `(runId, attempt)` and a
  `TickResult` cross that boundary (`vercel-flow.ts`).

Alternatives considered for storing customer keys:

- **Supabase Vault.** Protects a dump, but decrypts *in the database* for any role that can read
  `vault.decrypted_secrets`. Ingress holds database credentials and the database is shared with
  other products, so an ingress compromise or a broad role in another product would read every
  customer's key. It replaces a cryptographic boundary with a grant.
- **Vercel environment variables.** Per project and deploy-time; not a per-tenant runtime store.
- **A KMS (envelope encryption, customer-managed keys).** The right end state; M14's. This ADR
  leaves the seam for it (`keypair_id`).

Alternatives considered for calling models:

- **AI SDK** (PLAN lists it). Brings normalized usage and many providers, and a dependency into a
  path that has worked with `fetch`. `packages/verification` keeps `dependencies: {}`.
- **Vercel AI Gateway** as one endpoint for maker and checker. Attractive under ADR-0020; adds a hop
  and a lock-in decision that M9 does not need to make. Revisit with measured evidence.

### Decision

1. **Credentials are organization-scoped rows, sealed.** A `model_credential` row carries
   `organization_id`, `provider`, optional `base_url`, a label, `last4`, a `status`
   (`unverified | valid | invalid | revoked`) and the sealed value. Nothing returns the value; there
   is no field for it.
2. **The sealed box gets a v2 format.** The additional data binds the *context* — for a model
   credential, `model_credential:<organization_id>:<credential_id>` — so a ciphertext copied to
   another organization's row fails to open. Each sealed value records the `keypair_id` that sealed
   it; the stage deployment may hold the current and the previous private key so the pair can be
   rotated and values re-sealed. v1 values keep opening.
3. **Plaintext lives only inside one handler call on the stage deployment.** It is opened where it
   is used, never passed as a step argument or result, never written to a row, never logged.
   Opened values are registered with a redactor before any output that could echo them is stored.
4. **Model policy is layered and frozen per run.** Organization default → repository override →
   task override, each naming a role (`maker`, `checker`), a model, and either a credential or
   *Windkeel-managed* (the operator keys of today). Intake resolves it once into a snapshot on the
   run — vendor, model, provider, `base_url`, credential id, key source — and every later stage
   reads the snapshot, not the environment. When nothing is configured the snapshot is exactly
   today's behaviour.
5. **Independence is checked at intake, on the snapshot.** The vendor is derived from the model,
   not the router: `openrouter` + `anthropic/claude-*` is `anthropic`. An unknown model on an
   OpenAI-compatible endpoint must declare its vendor. An invalid pairing fails the run before a
   sandbox is provisioned, with the reason. `NoIndependentProviderError` stays run-fatal.
6. **No silent fallback.** A customer credential that is revoked, invalid, rate-limited or out of
   quota fails the run with a reason naming the credential. A run never moves from a customer key
   to Windkeel's, or the reverse, unless policy says so explicitly — and M9 ships no such policy.
7. **The maker is told its model.** Codex receives `--model` and, for a non-default provider, its
   `model_providers` overrides on the command line (`-c`), pointing at a placeholder environment
   variable. The broker rule carries the resolved value (or a resolver), not an environment
   variable name; the allowed egress domain is the resolved provider's host. A `base_url` that
   resolves to a private, loopback or link-local address is refused.
8. **The checker stays on the Windkeel-owned `ModelGateway`, `fetch`-based.** OpenRouter and other
   OpenAI-compatible endpoints use the existing compatible gateway. AI SDK and AI Gateway are not
   adopted in M9.
9. **Prices come from a model catalog**, overridable by environment, and every cost event records
   its key source (`windkeel` or `customer`). Unknown is still not zero (#242).
10. **Claude as the maker is out of scope** — Codex speaks OpenAI's wire formats; a second worker is
    M11. **Risk-based routing** is M10; M9 only leaves room for it in the policy shape.

### Consequences

- **What the sealed box does and does not separate, stated precisely.** Since #213 (ADR-0020),
  ingress and the workflow steps are **one Vercel deployment**: a queue message is addressed to
  the producer's own deployment, so the private key is in the same function environment as the
  internet-facing routes. The guarantees that hold are therefore:
  - **Against the database:** a dump, a backup, a SQL injection, or another product reading the
    shared database gets only ciphertext. This is the property Supabase Vault would *not* give,
    since Vault decrypts in the database for any role allowed to read the view.
  - **Against the code path:** no ingress route, handler or response can open a credential;
    `test/api-routing.test.js` enforces that ingress code names no reader, validator or
    private-key accessor. A mistake in a handler cannot leak a key.
  - **Not against code execution in the deployment.** Anything that runs code inside the
    deployment's functions can read `WINDKEEL_SECRET_PRIVATE_KEY` from the environment and open every
    stored key. The earlier wording here ("a separate project from ingress", "a `doctor` check that
    it is absent from ingress") assumed a split #213 showed cannot exist on Vercel, and is withdrawn.
  M9 accepts this residual risk, the same one #213 accepted for `VERCEL_TOKEN`. Mitigations are a
  sensitive Vercel variable and restricted team access. The real reduction is M14's: the private key
  (or a per-organization data key) is unwrapped by a KMS on use, with no schema change, because
  `keypair_id` already names which key sealed each value.
- Validating a credential needs the private key, so validation runs on the stage deployment, not in
  the request that stored it. A freshly stored credential is `unverified` until it has been tried.
- Every stage now reads models from the run, not the process. Two runs on one warm instance can use
  different vendors.
- Passing `--model` to Codex changes behaviour for existing deployments that relied on Codex's
  default without knowing it. The default `WINDKEEL_MAKER_MODEL` must be checked against what runs
  actually used.

### As built

M9 shipped as seven PRs on `m9-byok-model-routing` and an end-to-end proof (#326). The decision
above holds; where the build differs from its wording, the difference is listed and was accepted in
review. The status stays *Proposed* until the live spike (#318) runs Codex on OpenRouter with a
brokered key.

| PR | Issue | What it built |
|---|---|---|
| #328 | M9-1 #319 | `packages/verification/src/providers/catalog.ts`: providers (`openai`, `anthropic`, `openrouter`, `openai-compatible`), `vendorOf` deriving the vendor from the model, per-model prices, the pure `checkIndependence` that `selectGateway` and intake both use. |
| #329 | M9-2 #320 | Sealed box v2 (`orqonsealv2:<keypair_id>:<context>` as AEAD data, `keypair_id` = first 16 hex of SHA-256 over the SPKI, `WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY`); `model_credential` (0029); `model-credentials.ts` with one reader, `openModelCredential`; the `base_url` guard (shape, every resolved address, again at connect time); `/v1/model-credentials`; `windkeel models credentials`; validation as a one-step workflow. |
| #330 | M9-3 #321 | `model_policy` (0030), `engineering_run.model_config`, `engineering_task.model_override`; `resolveRunModels` at intake; `independenceOf` on derived vendors; stop reason `model_policy`; `/v1/model-policy`; task `models`; `modelConfig` on the run read. |
| #331 | M9-4 #322 | `withCheckerModels`: the checker's policy built from the snapshot, the customer key opened only for the endpoint `selectGateway` will call and only for the length of the call; `guardedModelFetch`; 401/403 marks the credential `invalid`, 402/429 fails as retry-later, neither falls back; criteria generation recorded as a cost. |
| #332 | M9-5 #323 | `codexModelArgs` (`--model` always, `-c model_provider` / `model_providers.windkeel` for a non-default provider); `CredentialBrokerRule` carries either `secretEnvVar` or a `resolveSecret` resolver; `makerRouteFor` per stage; `operatorModelKey: false` keeps Windkeel's key off a customer-key maker from create onwards; a session refuses to resume on a different model. |
| #334 | M9-6 #324 | `cost_event.key_source`, `credential_id`, `model`, nullable `usd`, stage type `criteria` (0031); catalog pricing with `WINDKEEL_USD_PER_*` / `WINDKEEL_CHECKER_USD_PER_*` as per-field pins; `bySource` on the cost read and the report; unpriced calls counted against the spend cap at a conservative rate. |
| #333 | M9-7 #325 | Console Settings → Models, repository override, the run's Models panel; `doctor`'s `model-credentials` check; the sweep re-starting unverified credential checks. |
| this | M9-8 #326 | `test/e2e-m9-byok.test.js`; the docs. |

**Deviations accepted:**

- **The private key is not on a separate deployment** (§3, Consequences). #213 made ingress and the
  workflow steps one Vercel deployment, so the split is enforced in code (`test/api-routing.test.js`)
  and stated as such; the Consequences were amended (0b9daeb) and #333 shipped no runtime "key absent
  from ingress" check, which would fail every working deployment.
- **Validation is its own one-step workflow** (`orqonValidateModelCredentialFlow`), not part of the
  run flow: a credential has no run. Only two ids cross its step boundary. OpenRouter is probed at
  `GET /key`, because its `/models` answers any key. `POST …/{id}/validate` and an hourly sweep
  re-start a check that never ran — neither was in §1–3.
- **Revoking overwrites the ciphertext**, so a revoked credential cannot be opened even by the steps.
- **Re-sealing on rotation is not automatic.** §2's "values re-sealed" is done by setting each value
  again (`windkeel models credentials rotate`), because nothing on the server holds a value to re-seal;
  the previous private key keeps old values opening meanwhile. The procedure is in
  `docs/running-the-factory.md`.
- **The snapshot is resolved in the CLASSIFYING handler**, the first stage that runs: `CREATED →
  FAILED` is not an ADR-0003 transition. A run refused there never provisions a sandbox.
- **`GET /v1/model-policy` needs `models.read`, not `models.manage`**, so a member choosing a task's
  models can see what it would otherwise get.
- **The checker policy row is one model per layer**; only a task's `models.checker` is a list in
  preference order. A customer checker endpoint that is not the one `selectGateway` will call is
  never given its key.
- **Codex's provider is named `windkeel`**, with `wire_api = "responses"`, so it cannot collide with a
  built-in provider. Neither the syntax nor the wire API has been run against the pinned binary.
- **Unpriced is `null`, not zero, in the ledger** (§9, #242); the spend rail counts such a call at the
  catalog's highest rate (`WINDKEEL_UNPRICED_USD_PER_*`) and says when a cap was met on an estimate.
  `WINDKEEL_USD_PER_*` lost its default (gpt-5's price for every model).
- **The console mirrors the catalog's vendor table** (`apps/console/lib/models.ts`), since it depends
  on no workspace package; drift can only make its independence warning wrong, never a run.

**Proven and not.** The end-to-end test drives the real API, Workflow runtime, Postgres, stages,
Codex adapter, broker rules, sealed box and guarded transport, with a stub `codex`, a fake sandbox, a
fake GitHub and a scripted OpenRouter on loopback. No real model has been called on an
organization's key; `research/MILESTONES.md` lists what remains for #318.
