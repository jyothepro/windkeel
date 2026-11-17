# Windkeel Detailed Architecture and Implementation Plan

## 1. Product Goal

Windkeel is a **full autonomous software engineering factory**, not only a verification layer.

The long-term product should be capable of taking engineering work from intake to a verified pull request:

```text
Issue / Prompt / Jira / Slack / Cron / API
                  ↓
            Engineering Task
                  ↓
               Planning
                  ↓
        Agent + Model Selection
                  ↓
             Sandbox Run
                  ↓
           Implementation
                  ↓
             Debug / Test
                  ↓
         Independent Verification
                  ↓
              PASS / FAIL
               ↙      ↘
          Repair      PR Ready
               ↓
            Re-verify
                  ↓
             Human Review
                  ↓
                Merge
```

The strategic differentiator is the trust architecture built directly into the factory:

- maker/checker separation
- independent verification
- evidence rather than unsupported agent claims
- deterministic verdicts where possible
- risk-aware policy
- provenance
- cross-agent and cross-model neutrality

---

# 2. What Already Exists

The current Windkeel repository is primarily a verification-oriented TypeScript CLI / GitHub Action system.

The current work should **not be discarded**. It becomes the verification and evidence kernel inside the broader software factory.

## Already Built / Valuable

### Verification stages
- Repository checks
- Test/lint/typecheck execution
- Independent AI review
- Acceptance-criteria mapping
- Security checks
- Browser QA foundations
- Policy-driven verdict generation

### Evidence system
- Evidence package structure
- Manifest
- Intent
- Mapping
- Findings
- Transcripts
- Hashes / artifact digests
- Recomputable verdict
- Offline package verification

### Trust and integrity
- Reviewer independence concepts
- Artifact integrity
- Transcript integrity
- Exit-code binding
- Signed provenance / Sigstore support

### Distribution
- CLI
- GitHub Action
- Annotations / gating behavior

### Quality / evaluation
- Benchmark corpus
- Seeded defect cases
- Clean controls
- Historical replay harness
- Tamper / regression testing

---

# 3. What Should Be Kept

These should remain first-class product assets.

## Keep as core IP

- Evidence format
- Deterministic verdict logic
- Independent reviewer design
- Intent / acceptance-criteria mapping
- Security verification
- Browser verification
- Artifact hashing
- Provenance / signing
- Benchmark corpus
- Historical replay harness
- CLI
- GitHub Action

These become reusable interfaces beneath:

```text
Windkeel CLI
Windkeel GitHub Action
Windkeel Cloud
Windkeel Enterprise
```

All should eventually invoke the same verification engine.

---

# 4. What Should Be Refactored

## 4.1 Extract a reusable Verification Engine

Today, verification behavior is too closely coupled to CLI and local filesystem assumptions.

Target API:

```ts
interface VerificationEngine {
  verify(input: VerificationRequest): Promise<VerificationResult>;
}
```

Example conceptual request:

```ts
type VerificationRequest = {
  taskId: string;
  workspace: WorkspaceHandle;
  intent: EngineeringIntent;
  policy: VerificationPolicy;
  candidate: CandidateChange;
};
```

The engine should not care whether it is invoked from:

- CLI
- GitHub Action
- Windkeel Cloud
- Vercel Sandbox
- Cloudflare Sandbox
- Customer VPC

---

## 4.2 Replace local process execution with an execution abstraction

Instead of stage code directly invoking local commands, introduce:

```ts
interface ExecutionEnvironment {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

Implementations:

```text
LocalExecutionEnvironment
VercelSandboxExecutionEnvironment
CloudflareSandboxExecutionEnvironment
DockerExecutionEnvironment
```

This lets current verification semantics survive while infrastructure changes underneath.

---

## 4.3 Normalize model access

Introduce a Windkeel-owned model abstraction:

```ts
interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Possible implementations:

```text
OpenRouterGateway
VercelAIGateway
OpenAIGateway
AnthropicGateway
OpenAICompatibleGateway
```

Use Vercel AI SDK internally where helpful, but do not expose it as a Windkeel domain primitive.

---

# 5. What Should Be Retired or Archived

Very little production code should be thrown away.

## Retire
- Prototype-only evidence package implementations that have already been superseded
- Any duplicate experimental implementation of the current evidence model
- Product positioning that treats Windkeel as only a “zero-server PR gate”

## Archive, do not delete
Move old research/specification docs that encode superseded infrastructure decisions into an archive folder.

Examples of ideas that should no longer be treated as current architecture:

- Temporal-first assumptions
- Daytona-first assumptions
- LiteLLM as the core model abstraction
- custom-built orchestration infrastructure when eve / Workflow can be reused

Suggested structure:

```text
docs/
  architecture/
    current.md
  archive/
    2026-07/
      previous-specs.md
      old-infrastructure-research.md
```

The objective is to prevent coding agents from faithfully implementing obsolete architecture.

---

# 6. Target Domain Model

Introduce durable entities owned by Windkeel.

> Locked by `docs/adr/0003-factory-domain-model-and-run-state-machine.md`: field lists below are final (with the additions noted inline), all ids are UUIDs, `acceptance_criteria` is the engine's `Criterion[]`, `verdict`/`final_verdict` are the engine's `Verdict`, and `RepairAttempt.repair_packet` embeds the engine's `RepairPacket` verbatim.

## EngineeringTask

Represents requested engineering work.

Suggested fields:

```text
id
organization_id   (the Product UI milestone, M7 — see docs/adr/archive/0001-v1-single-tenant-product-shape.md)
repository_id
source_type
source_reference
title
description
acceptance_criteria
risk_level
priority
status
created_at
updated_at
```

## EngineeringRun

Represents one autonomous attempt to complete a task.

```text
id
task_id
status
plan
selected_worker
selected_model
sandbox_provider
started_at
completed_at
cost
final_verdict
spend_cap_usd           (added by ADR-0011: required by default; uncapped needs explicit operator confirmation)
wall_clock_cap_seconds  (added by ADR-0011)
stop_reason             (added by ADR-0011: spend_cap | wall_clock_cap | stuck | repair_cap | error)
pr_number               (added by ADR-0013)
pr_merged_at            (added by ADR-0013)
human_commits_after_pr  (added by ADR-0013: the rework metric, from pull_request events)
```

> `cost` is defined by ADR-0013 as the maintained sum of the run's `cost_event` rows — the ledger is the source of truth, the column exists so the ADR-0011 rail reads one value.

## cost_event (added by ADR-0013)

Append-only ledger; one row per completed billable unit.

```text
id
engineering_run_id
stage_type          (agent_run | verification_run | workspace)
stage_id
kind                (model | sandbox)
tokens_in
tokens_out
usd
recorded_at
```

## run_state_transition (added by ADR-0013)

Append-only; written by the ADR-0007 reducer on every legal transition.

```text
id
engineering_run_id
from_state          (null on the initial CREATED row)
to_state
reason              (ADR-0011 stop_reason, or the transition's trigger)
at
```

## AgentRun

Represents a worker execution segment.

```text
id
engineering_run_id
worker_type
model
role
started_at
completed_at
result
token_usage
model_cost
```

Roles could include:

```text
planner
implementer
debugger
reviewer
repairer
```

## VerificationRun

```text
id
engineering_run_id
candidate_sha
policy_version
verdict
evidence_package_ref      (nullable — see ADR-0015: null + evidence_pruned_at means pruned by policy)
risk_summary
started_at
completed_at
evidence_pruned_at        (added by ADR-0015)
evidence_manifest_digest  (added by ADR-0015: written at seal time for every verification, retained forever)
```

## RepairAttempt

```text
id
engineering_run_id
verification_run_id
agent_run_id      (added by ADR-0003: the repairer AgentRun it spawned)
attempt_number
repair_packet
result
```

## Workspace

```text
id
engineering_run_id  (added by ADR-0003)
role                (added by ADR-0003: maker | verifier — see ADR-0004)
sandbox_provider
provider_handle
repository
base_sha
working_branch
status
expires_at
```

---

# 7. Factory State Machine

Recommended lifecycle:

```text
CREATED
  ↓
CLASSIFYING
  ↓
PLANNING
  ↓
PROVISIONING
  ↓
IMPLEMENTING
  ↓
VERIFYING
  ↓
 ┌───────────────────────┐
 │                       │
PASS                    FAIL
 │                       │
PR_CREATING          REPAIRING
 │                       │
PR_READY             VERIFYING
 │
WAITING_FOR_HUMAN
 │
COMPLETED
```

Other terminal/exception states:

```text
FAILED
CANCELLED
BLOCKED
WAITING_FOR_APPROVAL
MAX_REPAIR_ATTEMPTS_REACHED
```

> Locked by `docs/adr/0003-factory-domain-model-and-run-state-machine.md`: the full legal-transition table lives there. Terminal states are exactly COMPLETED, FAILED, CANCELLED, MAX_REPAIR_ATTEMPTS_REACHED; BLOCKED and WAITING_FOR_APPROVAL are non-terminal waits; VERIFYING → REPAIRING → VERIFYING is the only cycle; a `warn` verdict goes to PR_CREATING, never around the repair loop.

---

# 8. Orchestration Architecture

Windkeel should own the domain model and lifecycle.

> Hosting (`docs/adr/archive/0002-control-plane-is-hybrid-vercel-ingress-plus-worker-container.md`): the control plane is hybrid — the GitHub App webhook receiver and thin API run on Vercel; the factory service and `WorkflowProvider` run in a long-lived worker container. The seam between them is data (persisted tasks/signals), never code. The orchestration backing (#60) must run embedded in or drivable from the worker container; Vercel function step caps do not constrain it.

eve / Vercel Workflow can provide durable infrastructure underneath.

> Backing (`docs/adr/archive/0007-pg-boss-backs-workflowprovider-postgres-is-authoritative.md`): v1 does **not** use eve / Vercel Workflow. `WorkflowProvider` is backed by pg-boss embedded in the worker container; the ADR-0003 transition table is implemented as Windkeel's own reducer, and the `EngineeringRun` row in Postgres is the single authoritative run state — pg-boss job tables are transport, never truth. Signals/cancellation are data rows picked up by the factory.

Conceptually:

```text
Windkeel EngineeringRun
        ↓
Windkeel Factory Service
        ↓
WorkflowProvider
        ↓
eve / Vercel Workflow
```

Introduce:

```ts
interface WorkflowProvider {
  startRun(run: EngineeringRun): Promise<WorkflowHandle>;
  signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void>;
  cancel(handle: WorkflowHandle): Promise<void>;
  status(handle: WorkflowHandle): Promise<WorkflowStatus>;
}
```

Do not let Windkeel's public architecture depend directly on eve-specific types.

> Local development decided (`docs/adr/0016-local-development-hermetic-by-default.md`): the whole loop runs offline on a laptop. `docker compose up` starts stock Postgres (migrations applied on boot; pg-boss makes its own tables as in production) and MinIO for the S3-protocol evidence store; the factory service and ingress run as plain Node processes against them. Execution uses the existing `LocalExecutionEnvironment` with **separate maker and verifier checkouts**, preserving ADR-0004's shape — though local mode reproduces the workflow of independent verification, not its isolation, so changes touching provisioning, credentials, or egress must be exercised against a real Vercel Sandbox (drivable from any machine with `VERCEL_TOKEN`). Webhooks arrive as **replayed fixtures** via `windkeel dev trigger`, signed with the dev secret so ingress validation and routing are genuinely exercised; a tunnel is documented for capturing new fixtures. Models are the bench corpus's scripted fakes plus a recorded-JSONL fake worker, with real keys opt-in. No substitute may be a second implementation of factory logic.

---

# 9. Worker Architecture

Do not build a new coding-agent runtime from scratch.

Create a Windkeel-owned adapter:

```ts
interface WorkerAdapter {
  start(input: WorkerStartInput): Promise<WorkerSession>;
  send(session: WorkerSession, message: WorkerMessage): Promise<void>;
  events(session: WorkerSession): AsyncIterable<WorkerEvent>;
  cancel(session: WorkerSession): Promise<void>;
  result(session: WorkerSession): Promise<WorkerResult>;
}
```

Initial workers:

1. Codex (decided by `docs/adr/0006-codex-is-the-first-worker.md`)
2. Second worker after the first full loop is reliable — OpenHands is the leading candidate

Later:

- Claude Code
- OpenCode
- Grok Build
- others

Worker implementations should normalize events into Windkeel semantics:

```text
started
thinking
command_started
command_finished
file_changed
test_started
test_finished
message
completed
failed
```

---

# 10. Sandbox Architecture

Sandboxes execute untrusted repositories and AI-generated commands.

Windkeel must own the abstraction.

```ts
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: string): Promise<ExecResult>;
  putFiles(handle: SandboxHandle, files: SandboxFile[]): Promise<void>;
  getFiles(handle: SandboxHandle, paths: string[]): Promise<SandboxFile[]>;
  exposePort?(handle: SandboxHandle, port: number): Promise<string>;
  snapshot?(handle: SandboxHandle): Promise<SandboxSnapshot>;
  destroy(handle: SandboxHandle): Promise<void>;
}
```

## Initial provider

### Vercel Sandbox
Use initially because:

- strong isolation
- low operational burden
- integrates well with the rest of the initial stack
- designed for AI-generated code execution
- supports Docker and arbitrary repo tooling

## Second provider

### Cloudflare Sandbox
Implement and benchmark after v1.

Benchmark:

- cold start
- clone speed
- dependency install
- Docker
- test execution
- Playwright
- preview ports
- snapshot / restore
- failure rates
- cost per completed task

## Later providers

```text
DockerSandboxProvider
KubernetesSandboxProvider
DigitalOceanVMProvider
AWSCustomerVPCProvider
```

---

# 11. Model and BYOK Architecture

BYO model support should be first-class.

Supported modes:

```text
1. Windkeel-managed model
2. Customer provider API key
3. Customer OpenRouter key
4. Customer private/self-hosted endpoint
```

Example policy:

```yaml
models:
  maker:
    provider: openrouter
    model: qwen/qwen-coder

  checker:
    provider: anthropic
    model: claude

routing:
  low_risk:
    use: cheap
  high_risk:
    use: premium
```

Important invariant:

```text
Maker model and checker model may be forced to differ
```

for stronger independence where policy requires it.

> Pre-BYOK policy (`docs/adr/0010-maker-checker-model-policy-pre-byok.md`): maker is Codex on OpenAI models (ADR-0006), exact model pinned per run; checker defaults to Anthropic. The factory sets `ModelPolicy.maker` explicitly from its own records — author inference remains only for the standalone CLI/Action. Vendor + exact-model independence is a hard invariant; `NoIndependentProviderError` is run-fatal, never a silent skip. BYOK (the model-neutrality milestone, M9) adds endpoints without changing the invariant.

---

# 12. Planner and Task Understanding

> M6 slice decided (`docs/adr/0012-m6-task-understanding-extract-first-generate-fallback.md`): task creation extracts criteria deterministically (`extractCriteria`); only a zero-criteria issue triggers LLM generation, which runs on the checker-default model (ADR-0010, never the maker's vendor) and holds at `WAITING_FOR_APPROVAL` for `/windkeel approve` (amends ADR-0009's command list). No approved criteria → run ends `CANCELLED` with a reason comment; no checks-only mode. Everything below this line — risk classification, subtask decomposition, worker selection — is the planner milestone's (M10). Implementation: issue #74.

This should be a Windkeel-owned product capability.

Planner responsibilities:

```text
task input
  ↓
repository context
  ↓
acceptance criteria
  ↓
risk classification
  ↓
implementation plan
  ↓
verification plan
  ↓
worker selection
```

For simple tasks, avoid over-planning.

For larger tasks, generate subtasks and dependencies:

```text
Feature
 ├── DB migration
 ├── API implementation
 ├── frontend
 └── tests
```

Later, independent workers can execute subtasks in separate worktrees/sandboxes.

---

# 13. Independent Verification Architecture

This remains Windkeel's strongest differentiated subsystem.

The candidate change crosses a trust boundary:

```text
Maker
  ↓
Candidate Change
  │
════════ TRUST BOUNDARY ════════
  │
Verifier
```

Verification should combine:

- deterministic repository checks
- acceptance-criteria evidence
- independent LLM review
- security scanners
- browser / E2E verification
- risk-specific policies
- provenance checks

Do not let the candidate-authoring agent decide the final verdict.

> Placement (`docs/adr/0004-verification-runs-in-a-fresh-independent-sandbox.md`): every `VerificationRun` executes in its own freshly created sandbox — never the maker's sandbox, its fork, or its snapshot, and never the control plane. The verifier trusts only the candidate git commits fetched from the remote; deps, builds, and toolchain are re-established from the clean clone. Checker credentials enter only the verifier sandbox (or stay out entirely via egress credential brokering).

---

# 14. Repair Loop

The first major bridge from current Windkeel to full software factory.

Current pattern:

```text
candidate
  ↓
verify
  ↓
FAIL
```

Target:

```text
candidate
  ↓
verify
  ↓
FAIL
  ↓
RepairPacket
  ↓
worker
  ↓
repair
  ↓
verify
```

`RepairPacket` should be structured:

```text
failed_acceptance_criteria
failed_checks
security_findings
review_findings
browser_findings
evidence_links
recommended_focus
repair_constraints
```

Repair attempts should be capped by policy.

Example:

```text
low risk: 3 autonomous repairs
medium risk: 2
high risk: 1 then human escalation
```

> Policy decided (`docs/adr/0011-repair-loop-policy-and-run-safety-rails.md`): the example above is the v1 policy — risk-tiered caps 3/2/1 by `EngineeringTask.risk_level`. Between attempts nothing escalates: same worker/model, Codex session resumed with the new `RepairPacket`. Three rails bound every run: a spend cap (`spend_cap_usd`, default $25, required by default), a wall-clock cap (default 2h), and stuck detection (2 consecutive no-delta `RepairPacket` fingerprints → stop early). Cap/stuck stops land in `MAX_REPAIR_ATTEMPTS_REACHED`; spend/time stops in `FAILED`; every stop records `EngineeringRun.stop_reason`. Implementation: issue #73.

---

# 15. GitHub Integration

GitHub should be the first product integration.

Target flow:

```text
GitHub Issue
   ↓
label: windkeel
   ↓
GitHub App webhook   (received on Vercel — ADR-0002)
   ↓
EngineeringTask
   ↓
EngineeringRun
   ↓
sandbox + worker
   ↓
verification + repair
   ↓
draft PR
   ↓
evidence summary comment/check
```

GitHub integration should support:

- issue ingestion
- issue status updates
- branch creation
- draft PR creation
- PR comments/check runs
- evidence links
- human approval status
- cancellation

> App scope decided (`docs/adr/0009-github-app-scope-for-milestone-6.md`): permissions are Metadata R, Issues RW, Contents RW, Pull requests RW, Checks RW — nothing else, nothing org-level. Events: `issues`, `issue_comment`, `pull_request`. The `windkeel` label is the trigger; unlabeling or `/windkeel cancel` cancels. Branches are `windkeel/issue-<number>-<slug>`; PRs are always draft with `Resolves #<number>` — the App never marks ready, approves, or merges. v1 is same-repo only: fork events are ignored; missing permissions fail the run with the reason recorded.

---

# 16. Human Review Experience

Human review should be concise and evidence-oriented.

> Surface decided (`docs/adr/0009-github-app-scope-for-milestone-6.md`): the summary below lives in **one sticky PR comment**, edited in place on re-verification, alongside a `windkeel/verification` check run on the head SHA carrying the machine verdict. The issue gets brief comments at run start and terminal states only.

Example:

```text
WINDKEEL RESULT

Task: Add CSV export

Acceptance criteria       5/5
Tests                     PASS
Security                  PASS
Independent review        PASS
Browser QA                PASS
Repair attempts           1
Residual risk             Medium
Overall verdict           PASS
```

Human reviewer can inspect:

```text
code diff
task intent
acceptance criteria
verification details
repair history
screenshots/traces
security findings
agent/model provenance
cost
```

Human decisions:

```text
Approve
Request changes
Retry with another agent/model
Cancel
Merge
```

---

# 17. Product UI

Do not build a massive Devin-style UI initially.

## v1 UI

```text
Tasks
Run detail
Verification detail
PR link
Settings
```

Run detail should show:

```text
Task
Plan
Current stage
Worker/model
Sandbox
Commands/events
Verification
Repairs
Cost
Final result
```

Later:

```text
Automations
Agent benchmarking
Policies
Repository memory
Organization memory
Analytics
Team/RBAC
Billing
```

---

# 18. Persistence and Storage

> Concretes decided (`docs/adr/0008-supabase-postgres-and-storage-sql-file-migrations.md`): Supabase hosts both stores — Postgres (direct connection for the worker container and pg-boss; Supavisor pooler for Vercel ingress) and Supabase Storage for evidence packages via its **S3-compatible API**, so the object store stays swappable. Migrations are numbered forward-only SQL files applied by a small node-pg runner; the Milestone 1 schema is the first migration, transcribed from ADR-0003. Supabase Auth/RLS/Realtime are not adopted in v1.

## PostgreSQL / Supabase

Use for:

- organizations (the Product UI milestone, M7 — see `docs/adr/archive/0001-v1-single-tenant-product-shape.md`)
- users (the Product UI milestone, M7 — see `docs/adr/archive/0001-v1-single-tenant-product-shape.md`)
- repositories
- tasks
- runs
- worker runs
- verification runs
- repair attempts
- policies
- integrations
- model configurations
- sandbox metadata
- usage/costs

## Object storage

> Retention decided (`docs/adr/0015-evidence-retention-outcome-tiered-with-tombstones.md`): **outcome-tiered**. The verdict of record — the final `VerificationRun` of any run that reached a terminal state — is kept indefinitely, so evidence links in merged PRs never decay. Superseded packages from earlier repair cycles expire after 90 days. Pruning is **whole-package only** (the package is sealed and signed as a unit; partial pruning would leave something that looks like evidence but fails verification), and every prune leaves a **tombstone**: `evidence_pruned_at` plus the `evidence_manifest_digest` captured at seal time, so a stale link says "pruned by policy" rather than 404.

Use for:

- evidence packages
- logs
- screenshots
- Playwright traces
- transcripts
- build artifacts
- large diffs
- provenance bundles

Postgres should store metadata and object references, not large binary artifacts.

## Redis / Valkey

Optional.

Use only for:

- locks
- cache
- deduplication
- temporary coordination

Do not make Redis the authoritative task/run store.

---

# 19. Security Model

Security is foundational because Windkeel executes untrusted customer repositories and model-generated commands.

Required principles:

> Credential concretes decided (`docs/adr/0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md`): **no model key ever enters a sandbox** — the maker's OpenAI key is attached by the egress proxy for the model API domain (Codex runs with a placeholder), and the checker's key never needs to cross at all because the engine makes review calls host-side in the worker container. Supabase database and Storage credentials likewise never enter a sandbox. Git access is a **fresh per-workspace installation token**, repo-scoped and role-scoped: maker `contents: write`, verifier `contents: read` — so ADR-0004's boundary is enforced by the credential, not by convention. Egress is **phase-based**: registries + github.com during install, narrowed to the brokered model API before any model-generated or repository-provided command runs. Worst case for a fully compromised sandbox: push to one repo (maker only), spend capped model tokens until the ADR-0011 rails stop the run.

- one isolated sandbox per execution context
- minimal secret injection
- short-lived credentials
- secrets never stored in transcripts/evidence
- network policy where supported
- sandbox expiration
- artifact integrity
- signed provenance
- audit events
- explicit trust boundary between maker and verifier

For enterprise later:

- customer VPC execution
- private model endpoints
- private Git
- private artifact storage
- configurable data retention

---

# 20. Observability and Cost Accounting

Capture every run from day one.

> v1 shape decided (`docs/adr/0013-v1-observability-cost-ledger-transition-log-sql-views.md`): all twelve metrics below are answerable from Milestone 1. Cost is an append-only **`cost_event` ledger** (per model call and per sandbox teardown, attributed to the AgentRun / VerificationRun / Workspace that incurred it), with `EngineeringRun.cost` maintained as its sum in the same transaction so the ADR-0011 spend rail stays a single-column read — and so the rail counts verification and sandbox spend, not just maker tokens. Timing comes from an append-only **`run_state_transition` log** written by the ADR-0007 reducer on every legal transition. Merge and rework rates come from `pr_number` / `pr_merged_at` / `human_commits_after_pr` on `EngineeringRun`, populated from ADR-0009's `pull_request` events. The metrics ship as **named SQL views** plus a `windkeel metrics` command; nothing leaves Postgres in v1 — no dashboard, no alerting service.

Metrics:

```text
task success rate
first-pass verification rate
repair success rate
human rework rate
merge rate
time to PR
sandbox duration
model tokens
model cost
sandbox cost
verification cost
cost per verified PR
```

Key business/product metric:

```text
Verified engineering work merged without human rework
```

Key infrastructure metric:

```text
COGS per verified PR
```

---

# 21. Repository / Organization Memory

Later milestone, not v1.

Repository memory:

```text
architecture
coding standards
testing expectations
dangerous modules
approved patterns
historical failures
```

Organization memory:

```text
security policy
review expectations
approved dependencies
release constraints
risk rules
```

Long-term value:

```text
more work
  ↓
more outcomes
  ↓
better routing + verification + policy
  ↓
higher autonomous success rate
```

---

# 22. Recommended Repository Structure

Do not perform a giant rewrite immediately.

Target structure over time:

```text
windkeel/

apps/
  web/
  worker/

packages/
  domain/
  factory/
  workflows/

  agents/
    codex/
    openhands/
    claude/
    opencode/

  models/
    openrouter/
    vercel/
    openai/
    anthropic/
    openai-compatible/

  sandboxes/
    vercel/
    cloudflare/
    local/

  integrations/
    github/
    linear/
    jira/
    slack/

  verification/
  evidence/
  policy/
  persistence/
  telemetry/

  cli/

docs/
  architecture/
  archive/
```

Migrate incrementally rather than moving all code at once.

> Timing (`docs/adr/0005-monorepo-split-lands-with-the-control-plane.md`): single package until the first control-plane deployable lands (ADR-0002's ingress app or worker container); that change adopts npm workspaces, and the first split is `packages/verification`. The CLI and GitHub Action stay in the root package; tests keep driving `dist/cli.js` and the Action keeps its committed `dist` distribution. Everything else splits only when a second consumer or deployable needs the boundary.

---

# 23. Milestone Plan

## Milestone 0 — Stabilize Current Verification Kernel

Goal:

> Make the existing verifier reusable from Cloud/Factory code without changing behavior.

Deliverables:

- `VerificationEngine`
- `ExecutionEnvironment`
- current stages moved behind engine interfaces
- CLI still works
- GitHub Action still works
- benchmark corpus still passes
- evidence compatibility preserved

Do not add factory features yet.

---

## Milestone 1 — Factory Domain Model

Goal:

> Introduce the durable product lifecycle.

Deliverables:

- `EngineeringTask`
- `EngineeringRun`
- `AgentRun`
- `VerificationRun`
- `RepairAttempt`
- run state machine
- persistence schema
- basic run service

No autonomous coding required yet.

---

## Milestone 2 — Sandbox Abstraction

Goal:

> Run engineering work outside the Windkeel server.

Deliverables:

- `SandboxProvider`
- local test implementation
- Vercel Sandbox implementation
- clone repo
- exec commands
- upload/download artifacts
- teardown
- limits/timeouts

Success:

```text
Windkeel can create a sandbox, clone a repo, run tests, and destroy it.
```

---

## Milestone 3 — First Worker Adapter

Goal:

> Allow Windkeel to actually modify code.

Chosen (`docs/adr/0006-codex-is-the-first-worker.md`):

- Codex (`codex exec --json`; OpenHands returns as the second-worker milestone's candidate, M11)

Deliverables:

- `WorkerAdapter`
- start session
- send task
- normalized event stream
- cancellation
- completion result
- diff/artifact extraction

Success:

```text
Prompt → sandbox → worker → modified repo
```

---

## Milestone 4 — First Full Autonomous Loop

Goal:

> Cross the line from verifier to autonomous software engineer.

Flow:

```text
EngineeringTask
  ↓
Sandbox
  ↓
Worker
  ↓
Candidate Change
  ↓
VerificationEngine
  ↓
PASS / FAIL
```

Deliverables:

- task execution
- candidate SHA/diff capture
- verification
- run result
- evidence package

Success:

```text
A local/API-created task produces a verified code change.
```

---

## Milestone 5 — Autonomous Repair

Goal:

> Verification failures should drive implementation repair automatically.

Deliverables:

- structured `RepairPacket`
- retry policy
- worker repair invocation
- re-verification
- max-repair policy
- repair history

Success:

```text
worker creates defect
→ Windkeel catches it
→ worker repairs it
→ Windkeel passes it
```

This is a critical milestone.

---

## Milestone 6 — GitHub Issue to Draft PR

Goal:

> Produce the first customer-visible factory workflow.

Deliverables:

- GitHub App
- issue webhook
- task creation
- status comments/checks
- branch management
- draft PR creation
- evidence summary

Success:

```text
GitHub Issue
→ Windkeel
→ implementation
→ verification
→ repair if needed
→ verified draft PR
```

This is the minimum marketable autonomous factory.

---

> **Reordered 2026-09-23.** M7–M15 below were renumbered after M6 shipped, to put a usable
> surface and the integrations that feed it ahead of the intelligence layered on top. The
> deliverables are unchanged; only the sequence is. The old → new mapping is recorded in
> [`research/MILESTONES.md`](../MILESTONES.md#the-2026-09-23-reordering). **Everything written
> before that date refers to these milestones by their old numbers**, so prose elsewhere in this
> repository names them rather than numbering them.

## Milestone 7 — Product UI, REST API and CLI

Goal:

> Give the factory a surface a person can drive without reading source.

Windkeel can do the work and has had nowhere to show it: every run so far has been driven from a
terminal in this repository or from a GitHub label, and read back out of Postgres by hand.

Deliverables:

- REST API over the existing control plane — tasks, runs, attempts, evidence, cost
- a published CLI over that API, not over the database
- task list, create task
- run timeline, live status/events
- verification summary
- repair history
- PR links
- model/sandbox settings
- usage/cost display

One ordering constraint, not a preference: **the UI and the CLI consume the same REST API**, and
the API ships first. Today's `windkeel` CLI talks straight to Postgres because it was the operator's
tool on the operator's machine; a CLI anyone else runs cannot hold the database's credentials.
Building the UI against a second, private path would produce two surfaces that disagree — the
failure [#228](https://github.com/jyothepro/orqon/issues/228) already cost this project once.

Orgs and users land here (`docs/adr/archive/0001-v1-single-tenant-product-shape.md`), as additive
migrations: create `organizations`/`users`, add `organization_id` to `repositories`, backfill a
default organization owning every existing row.

Do not build broad workflow-builder UI yet.

---

## Milestone 8 — Automations and Additional Integrations

Goal:

> Let work reach the factory from where the work is already described.

Deliverables:

- schedules
- cron-triggered engineering tasks
- Slack
- Linear
- Jira
- API/webhook intake

Examples:

```text
Every Monday → dependency upgrades
New Linear issue → run Windkeel
Slack command → start task
Nightly → flaky-test repair
```

Status (2026-09-25, code complete on `m8-automations-integrations`; live proof is the checklist on
[#302](https://github.com/jyothepro/orqon/issues/302), after the M8-0 spike #292):

- [x] **Every Monday → dependency upgrades** — a schedule (#296): `windkeel schedule create --cron
  "0 9 * * mon" --tz Europe/London …`, ready to paste in `docs/schedules.md` § "The two PLAN
  examples". Proven in `test/e2e-m8-intakes.test.js` (Schedule case) and `test/schedules-tick.test.js`.
- [x] **New Linear issue → run Windkeel** — an issue labelled `windkeel` (#299): `docs/integrations.md`
  § "Linear". Proven in `test/e2e-m8-intakes.test.js` (Linear case: task → verified draft PR → the
  PR link commented on the issue).
- [x] **Slack command → start task** — `/windkeel <title> -- <criteria>` in a mapped channel (#298):
  `docs/integrations.md` § "Slack intake". Proven in `test/e2e-m8-intakes.test.js` (Slack case: the
  thread gets "started", then the PR link).
- [x] **Nightly → flaky-test repair** — a schedule (#296): `windkeel schedule create --cron "0 3 * * *"
  --tz America/New_York …`, the second example in `docs/schedules.md`.

Jira (#300), signed webhooks and `Idempotency-Key` on `POST /v1/tasks` (#297), and the console
(#301) are delivered too; every intake is covered by `test/e2e-m8-intakes.test.js`, and
`docs/integrations.md` is the operator's guide to all of them. Departures from ADR-0025 are in its
"As built" section.

Each new intake is the same shape M6 already built for GitHub — signature before parse, parse
before database, delivery recorded in the same transaction as the work it causes, every ignored
event answering with a reason. The API/webhook intake is M7's REST API with a trigger on it.

---

## Milestone 9 — BYOK / Model Routing

Goal:

> Make Windkeel model-neutral.

Deliverables:

- AI SDK integration
- OpenRouter
- OpenAI
- Anthropic
- OpenAI-compatible endpoints
- encrypted customer keys
- per-run model config
- maker/checker independence policies
- model usage/cost tracking

BYOK changes the key source, not the invariant
(`docs/adr/0010-maker-checker-model-policy-pre-byok.md` §5): customer endpoints enter
`ModelPolicy.endpoints`, ADR-0010's defaults become the fallback, and vendor + exact-model
independence keeps applying unchanged. Brokering (ADR-0014 §1) is what keeps a customer's key out
of a sandbox too.

---

## Milestone 10 — Planner / Risk Engine

Goal:

> Improve reliability and task understanding.

Deliverables:

- acceptance-criteria generation
- risk classification
- implementation plan
- verification plan
- worker/model selection inputs

Keep simple-task planning lightweight.

Criteria generation already exists as ADR-0012's fallback, and the live runs found its sharp edge:
a generated criterion can be *unsatisfiable* — true of no possible change — and
[#273](https://github.com/jyothepro/orqon/issues/273) had to teach the verifier to say so rather
than fail a correct change. A planner that generates criteria owns that failure mode; it is the
reason this milestone wants the run history M7 and M8 will have accumulated by the time it starts.

`EngineeringTask.risk_level` has existed since M1 and is operator-set; this is where it stops
being. Until then the run report says **not scored**, and inventing a level would be worse than
saying nothing (#35).

---

## Milestone 11 — Second Worker + Routing

Goal:

> Demonstrate genuine agent neutrality.

Add a second coding worker.

Deliverables:

- second `WorkerAdapter`
- worker capability metadata
- manual routing policy
- fallback policy
- comparative telemetry

OpenHands is the recorded candidate (`docs/adr/0006-codex-is-the-first-worker.md` §5). This is
where the `WorkerAdapter` interface proves it hides worker topology rather than describing Codex
in general terms — including `src/worker/command-classification.ts`, which a second worker needs
identically or the shim was Codex-shaped all along.

Later:

```text
task category
→ choose best worker/model combination
```

---

## Milestone 12 — Repository / Organization Memory

Deliverables:

- repo knowledge ingestion
- reusable architecture context
- policy extraction
- learned engineering preferences
- reviewer feedback incorporation

---

## Milestone 13 — Agent Performance Intelligence

Goal:

> Turn execution history into product advantage.

Capture:

```text
task type
worker
model
cost
first-pass success
verification findings
repair count
human changes
merge outcome
production outcome
```

Use it for:

- model routing
- agent routing
- cost optimization
- risk prediction
- escalation policies

Most of these columns are already written per run (ADR-0013) and two of the views over them had to
be fixed for flattering the system before the loop had ever run (#145, #181). The discipline this
milestone inherits: a metric that cannot be computed honestly is `null`, and a view excludes a null
run rather than counting it clean.

---

## Milestone 14 — Enterprise / Self-Hosted

Deliverables:

- self-hosted Windkeel control plane option
- customer VPC sandboxes
- private model endpoints
- private object storage
- SSO/RBAC
- audit logs
- policy administration
- retention controls

Single-tenant is a supported deployment shape permanently
(`docs/adr/archive/0001-v1-single-tenant-product-shape.md`), so this ships what v1 already is, hardened,
rather than unwinding SaaS assumptions.

---

## Milestone 15 — Cloudflare Sandbox Provider

Goal:

> Reduce infrastructure dependency and benchmark economics.

Deliverables:

- Cloudflare provider
- standard benchmark suite
- latency comparison
- reliability comparison
- cost comparison
- provider routing support

Do not switch defaults until measured evidence supports it.

This sits last because it is the only remaining milestone that buys no new capability — the
factory already runs in a sandbox. The seam for it is paid for: `SandboxProvider`
(`src/sandbox/provider.ts`) exists with two implementations, ADR-0014's obligations are
expressible-or-refusable so a second provider is honest about what it supports, and evidence
storage speaks the S3 protocol rather than Supabase's SDK precisely so R2 is a credential change
(ADR-0008 §2).

---

# 24. Suggested Immediate Build Order

The next sequence should be:

```text
1. Extract VerificationEngine
2. Add ExecutionEnvironment
3. Add EngineeringTask / EngineeringRun
4. Add SandboxProvider + Vercel implementation
5. Add one WorkerAdapter
6. Build task → worker → verifier
7. Add RepairPacket + repair loop
8. Add GitHub App
9. Produce GitHub Issue → verified draft PR
10. Add REST API, then UI and CLI on top of it
11. Add automations and non-GitHub intake
12. Add BYOK/OpenRouter
13. Add planner/risk
14. Add second worker
15. Add Cloudflare sandbox
```

Steps 10 onwards were resequenced on 2026-09-23 — see the note at the head of §23's M7.

Do not start with:

```text
Slack
Jira
Linear
large dashboard
multi-agent swarm
generic memory
generic workflow builder
```

until the core GitHub issue-to-verified-PR loop is reliable.

That gate opened for the first three on 2026-09-22, which is why Slack/Linear/Jira are M8 rather
than "later": the loop ran end to end on github.com. The last two are still held — a workflow
builder and generic memory both want the run history M7 and M8 produce.

---

# 25. Definition of the First Real Product

> "understand the task, create acceptance criteria" is decided for M6 (`docs/adr/0012-m6-task-understanding-extract-first-generate-fallback.md`): extract-first from the issue body, checker-side generation only when extraction yields zero, operator approval of anything generated, and no run without approved criteria.

The first meaningful Windkeel release should satisfy:

```text
Given:
  a GitHub issue
  a repository
  customer model credentials or Windkeel-managed model

Windkeel can:

  understand the task
  create acceptance criteria
  provision a sandbox
  invoke a coding worker
  implement the change
  test/debug it
  independently verify it
  repair verification failures
  generate evidence
  create a verified draft PR
  present the result for human review
```

At that point Windkeel is no longer a verification tool.

It is a **full autonomous software engineer with an independent trust system built into the execution lifecycle**.
