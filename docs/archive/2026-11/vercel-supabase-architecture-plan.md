# Architecture Update Plan — Vercel-First + Supabase

## Objective

Evolve the cloud architecture toward a **Vercel-first stack with Supabase Postgres as the persistent source of truth**, while preserving the existing portable verification/evidence core.

This is not a blind rewrite. Prefer the smallest clean migration that reduces infrastructure and operational burden while keeping portability at the boundaries that matter.

## Target architecture

```text
Next.js / Vercel
      |
API / Task Service
      |
Supabase Postgres            <- source of truth
      |
Vercel Workflow              <- durable orchestration
      |
Agent / Coding Harness
      |
Vercel Sandbox               <- isolated execution
      |
git / shell / Playwright
      |
Existing independent verifier
      |
Evidence package / PR gate
```

Supporting services:

- **Vercel AI SDK** for model/tool plumbing where useful.
- **Vercel AI Gateway** for model routing.
- **Vercel Connect + MCP** for integrations.
- **Supabase Storage or another S3-compatible store** for artifacts.
- **OpenTelemetry-compatible instrumentation** for portable observability.

The central rule:

> **Supabase stores product state. Vercel Workflow executes workflows. Vercel Sandbox executes coding workloads. The verifier stays portable and agent-neutral.**

## 1. Database — Supabase Postgres

Use Supabase Postgres as the durable product database.

Persist important state such as tasks, attempts, workflow IDs, sandbox IDs, repositories, PR metadata, verification results, evidence references and usage/accounting data.

Do not make Vercel Workflow the only place that knows task state.

### Why

Postgres is standard and portable. Supabase reduces database operations without forcing the domain model into a proprietary datastore.

### Door

**Two-way door / low lock-in.**

Prefer standard Postgres semantics for core domain data so moving to another Postgres provider remains practical.

## 2. Orchestration — Vercel Workflow instead of pg-boss

Migrate orchestration from **pg-boss + custom worker orchestration** to **Vercel Workflow**, then remove pg-boss after equivalent behavior is validated.

A coding-agent task is naturally a durable workflow:

```text
receive task
 -> create sandbox
 -> prepare repository
 -> run coding harness
 -> run tests
 -> fix failures
 -> wait for external CI if necessary
 -> run independent verification
 -> optionally wait for approval
 -> create/update PR
 -> complete
```

pg-boss is a capable Postgres job queue, but our application must own more of the workflow state machine, chaining, waits and recovery semantics. Vercel Workflow is a closer match to the workload.

Persist important transitions to Supabase:

```text
task.status
task.workflow_id
task.sandbox_id
task.current_stage
task.last_error
task.pr_number
task.verification_status
```

Use a small boundary rather than spreading Workflow-specific APIs through domain code:

```ts
interface WorkflowEngine {
  startTask(input: StartTaskInput): Promise<WorkflowHandle>;
  getStatus(id: string): Promise<WorkflowStatus>;
  cancel(id: string): Promise<void>;
}
```

Do not implement Temporal/Inngest/pg-boss adapters now. The boundary exists to contain coupling, not to support multiple engines prematurely.

### Door

**Medium one-way-door risk if implemented carelessly; mostly two-way if state remains in Supabase and Workflow-specific code stays at the infrastructure edge.**

## 3. Sandbox — standardize on Vercel Sandbox

Use Vercel Sandbox as the default cloud execution environment.

It should handle cloning repositories, dependency installation, shell execution, coding harnesses, builds, tests, browser QA and artifacts.

Keep a deliberately small provider interface:

```ts
interface SandboxProvider {
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
  exec(id: string, command: string): Promise<ExecResult>;
  readFile(id: string, path: string): Promise<string>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  exposePort(id: string, port: number): Promise<string>;
  stop(id: string): Promise<void>;
}
```

Do not mirror the full Vercel Sandbox SDK.

Potential future implementations can include E2B, Modal, local Docker or a custom runtime, but do not maintain several cloud providers without a concrete requirement.

### Door

**Two-way if abstracted; medium/high lock-in if Vercel Sandbox types leak throughout the application.**

## 4. Models — Vercel AI Gateway

Use Vercel AI Gateway as the default model-routing layer and retain support for multiple model vendors.

Different stages may intentionally use different models:

```text
planning            -> reasoning model
coding              -> coding-optimized model
summarization       -> inexpensive model
independent review  -> provider independent from authoring agent where required
```

Preserve the verifier's independence guarantees.

### Door

**Two-way / low lock-in** when calls use standardized internal/AI SDK types.

## 5. Agent SDK and coding harness

Use Vercel AI SDK where it simplifies model calls, tools, structured output, streaming and agent loops.

Do **not** rewrite the existing verifier merely to adopt AI SDK.

Do not assume the product must implement its own coding engine. Keep a small harness boundary that can invoke Claude Code, Codex, OpenCode or future agents:

```ts
interface CodingHarness {
  run(input: CodingTaskInput): Promise<CodingTaskResult>;
}
```

### Door

**Two-way** if AI SDK remains infrastructure plumbing and coding harnesses remain replaceable.

## 6. Connectors — Vercel Connect + MCP

Prefer Vercel Connect when it removes OAuth/token/credential infrastructure. Prefer MCP for the long tail of integrations.

Likely integrations include GitHub, Linear, Slack, Jira, Sentry and Datadog.

Agents should consume product-level connector capabilities, not Vercel Connect APIs directly.

Example:

```ts
interface GitHubConnector {
  getIssue(...args: unknown[]): Promise<Issue>;
  createBranch(...args: unknown[]): Promise<Branch>;
  createPullRequest(...args: unknown[]): Promise<PullRequest>;
}
```

The implementation can later be Vercel Connect, a direct GitHub App, or MCP.

### Door

**Medium/high stickiness over time.** Auth and connector systems accumulate account mappings, scopes, webhooks and credential state, so protect this boundary early.

## 7. Browser QA — Playwright

Use Playwright inside the sandbox.

Typical flow:

```text
agent modifies app
 -> start dev server
 -> expose port
 -> run declared Playwright flows
 -> collect screenshots/traces/logs
 -> pass artifacts into verification
```

Do not add a remote browser vendor without a demonstrated requirement.

### Door

**Two-way / low lock-in.**

## 8. Verification core — preserve

Do not rewrite the existing verification/evidence system as part of this migration.

It should remain independently runnable locally, in CI or inside a sandbox and remain independent of the authoring agent and orchestration provider.

Preserve repository checks, adversarial review, intent mapping, security scanning, browser evidence, artifact hashing, evidence packages, reproducible verdicts, signatures/attestations and benchmark corpus.

The desired relationship remains:

```text
Coding agent -> patch -> independent verifier -> evidence -> PR gate
```

The verifier should not care whether orchestration is Vercel Workflow, Temporal, Inngest, pg-boss, GitHub Actions or a local CLI.

## 9. Artifact storage

Use a small artifact-store boundary. Supabase Storage is a reasonable default; retain S3 compatibility where practical.

```ts
interface ArtifactStore {
  put(path: string, data: Buffer): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Buffer>;
  delete(ref: ArtifactRef): Promise<void>;
}
```

Store evidence packages, screenshots, Playwright traces, logs and larger task artifacts here.

### Door

**Two-way / low lock-in.**

## 10. Frontend and hosting

Use Next.js on Vercel.

Do not build a hosting abstraction. This is not a high-risk architectural boundary.

### Door

**Two-way / low lock-in.**

## 11. Observability

Use OpenTelemetry-compatible instrumentation where practical. Vercel-native observability can be used, but provider dashboards must not be the only source of debugging information.

Track at least task ID, workflow ID, sandbox ID, repository, model/provider, coding harness, model cost, sandbox runtime, stage durations, retries, tests, verifier result, PR number and failure category.

## One-way vs two-way doors

A **two-way door** is reversible later at reasonable cost. Examples here include Vercel hosting, AI Gateway, Playwright, object storage, model selection, and Vercel Sandbox when properly abstracted.

A **one-way or sticky door** becomes embedded in persistent data, identity, workflows, public APIs, external integrations or trust/security contracts. These deserve more design effort.

### Current classification

| Decision | Door | Risk |
|---|---|---|
| Next.js on Vercel | Two-way | Low |
| Supabase Postgres | Two-way | Low |
| Vercel AI Gateway | Two-way | Low |
| Playwright | Two-way | Low |
| Object storage | Two-way | Low |
| Vercel Sandbox | Two-way if abstracted | Medium |
| Vercel AI SDK | Two-way if kept at infrastructure edge | Medium |
| Coding harness | Two-way if interface exists | Medium |
| Vercel Workflow | Reversible with state separation | Medium/High |
| Vercel Connect | Sticky over time | Medium/High |
| Domain schema | One-way-ish | High |
| Public APIs | One-way-ish | High |
| Evidence format / verification contract | One-way-ish | High |
| Security / trust model | One-way | Very High |

## Abstractions to create

Create small boundaries only around infrastructure likely to change:

- WorkflowEngine
- SandboxProvider
- ModelProvider / Gateway
- CodingHarness
- ConnectorProvider
- ArtifactStore

Do **not** abstract everything. Avoid unnecessary wrappers around Next.js, React, ordinary Postgres SQL, Playwright, basic logging or every individual Vercel/Supabase SDK call.

The goal is not zero vendor APIs. The goal is preventing high-risk infrastructure decisions from infecting core domain logic.

## Migration sequence

### Phase 1 — inspect

Before modifying implementation:

1. Map current worker/job architecture.
2. Identify all pg-boss producers and consumers.
3. Identify retry and scheduling semantics.
4. Find task state stored only in jobs.
5. Inspect existing sandbox-provider boundaries.
6. Identify provider-specific model calls.
7. Identify integration/auth code.
8. Confirm current Vercel Sandbox usage.
9. Confirm verifier boundaries.

Produce a short migration map before implementation.

### Phase 2 — Supabase source of truth

Ensure every long-running task has durable product state in Postgres. Reuse the existing schema where appropriate rather than duplicating concepts.

### Phase 3 — Workflow boundary

Introduce the minimum WorkflowEngine boundary and implement Vercel Workflow.

### Phase 4 — migrate pg-boss

Migrate flows incrementally, validate equivalent behavior, then remove pg-boss, obsolete queue tables and worker infrastructure that is no longer needed.

### Phase 5 — standardize sandbox

Make Vercel Sandbox the default cloud provider while preserving the small SandboxProvider boundary.

### Phase 6 — models and harness

Move model access behind AI Gateway/AI SDK boundaries and keep coding harness selection independent.

### Phase 7 — connectors

Adopt Vercel Connect/MCP incrementally where it removes meaningful custom auth/credential infrastructure.

## Non-goals

Do not:

- rewrite the verifier;
- redesign the evidence-package contract;
- introduce Kubernetes;
- build a custom sandbox platform;
- build a custom OAuth platform;
- introduce a vector database without demonstrated need;
- implement multiple workflow engines today;
- maintain several cloud sandbox providers without user need;
- replace working code purely for architectural aesthetics;
- couple domain state exclusively to Vercel Workflow.

## Success criteria

The migration is successful when:

1. Tasks persist in Supabase.
2. Vercel Workflow durably executes a task.
3. Vercel Sandbox executes coding work.
4. A replaceable coding harness operates inside the sandbox.
5. Model access works through the gateway/SDK layer.
6. Repository changes are tested.
7. Existing independent verification runs against the produced change.
8. Evidence is persisted.
9. A PR can be created/updated.
10. Failures and retries are visible.
11. Workflow execution survives interruption/redeployment.
12. Important task state can be reconstructed from Supabase.
13. The verifier remains runnable independently of Vercel.
14. pg-boss can be removed without loss of product functionality.
15. Provider-specific APIs remain concentrated at clear infrastructure boundaries.

## Implementation instruction

Before editing implementation code, summarize:

1. what exists today;
2. what already matches this target;
3. what must change;
4. what should remain untouched;
5. migration risks;
6. the smallest implementation sequence.

Then implement in incremental, reviewable commits.

Whenever the choice is between **rewriting for architectural purity** and **preserving working behavior behind a clean boundary**, choose the latter.

The goal is **simpler infrastructure with preserved product differentiation**, not a rewrite for its own sake.
