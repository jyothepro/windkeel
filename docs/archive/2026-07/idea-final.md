# Autonomous Engineering Platform
## Combining Devin-Style Cloud Sessions with Vorflux-Style Multi-Agent Orchestration

**Document status:** Product and engineering implementation specification  
**Architecture revision:** TypeScript-first, Next.js API, Temporal TypeScript workers, Playwright browser foundation  
**Intended audience:** AI coding agents, software architects, engineering leads, and product engineers  
**Primary goal:** Provide enough context to design and build an autonomous software-engineering platform without access to the original planning conversation.

---

# 1. Executive Summary

This project is an autonomous software-engineering platform that combines two complementary product philosophies:

1. **Devin-style execution and usability**
   - Start a coding session in seconds.
   - Give every session an isolated cloud computer.
   - Let the agent use a terminal, browser, editor, Git, and developer tools.
   - Let the user observe the agent, interrupt it, take over, and resume automation.
   - Produce reviewable pull requests with test evidence.

2. **Vorflux-style orchestration and verification**
   - Convert ambiguous engineering outcomes into structured plans.
   - Break large work into dependency-aware workstreams.
   - Run specialized agents in parallel.
   - Preserve repository and organizational memory.
   - Independently review and verify agent output.
   - Require evidence before declaring work complete.

The platform should not be designed as a single monolithic coding agent. It should be designed as an **agent operating system** with separable layers:

- Product control plane
- Agent runtime
- Cloud sandbox layer
- Durable workflow orchestration
- Planning and decomposition
- Verification and evidence
- Memory and retrieval
- Model routing
- Git and developer-tool integrations
- Governance and security
- Observability and evaluation

The recommended initial stack is:

```text
Next.js + React + TypeScript
        ↓
Next.js Route Handlers
        ↓
Temporal TypeScript Workflows and Workers
        ↓
TypeScript Agent and Sandbox Adapters
        ↓
Daytona Cloud Sandboxes
        ↓
GitHub + Playwright + Pull Requests
```

The platform should use **TypeScript end to end for the initial product**. Python should be introduced only when a specific dependency, model workflow, or research requirement provides a clear benefit that cannot be achieved cleanly through TypeScript, an API, ACP, MCP, or a sandboxed CLI integration.

Open-source components should be used for commodity infrastructure. Proprietary engineering should focus on planning, orchestration, verification, memory quality, convergence, evaluation, and user experience.

---

# 2. Product Vision

The system should make it possible for an engineer, product manager, or engineering leader to describe a desired outcome and receive a validated implementation.

Example input:

> Add organization-level audit-log export. Include an API endpoint, a scheduled export process, a settings page, permissions, tests, and documentation.

The platform should:

1. Gather repository and organizational context.
2. Ask clarifying questions only when materially necessary.
3. Generate acceptance criteria.
4. Produce a dependency-aware implementation plan.
5. Let the user approve or edit the plan.
6. Provision isolated cloud workspaces.
7. Assign tasks to specialized agents.
8. Execute independent workstreams in parallel where safe.
9. Integrate the work.
10. Run static checks, tests, browser validation, security checks, and independent review.
11. Open one or more draft pull requests.
12. Present a complete evidence package.
13. Let the user request revisions, take over, or approve the output.

The long-term product should feel like a combination of:

- A cloud IDE
- An autonomous software engineer
- A multi-agent workflow engine
- An engineering project manager
- A verification and QA system
- An organizational engineering memory

---

# 3. Product Principles

## 3.1 Fast for small tasks

Small tasks should not require a complex multi-agent workflow.

```text
Prompt → Single coding agent → Test → Pull request
```

Examples:

- Fix a bug
- Add a unit test
- Update a dependency
- Repair CI
- Add a small endpoint
- Refactor a single module

## 3.2 Structured for large outcomes

Large tasks should use a project-oriented workflow.

```text
Outcome
  ↓
Context gathering
  ↓
Plan compiler
  ↓
Dependency graph
  ↓
Parallel workstreams
  ↓
Integration
  ↓
Independent review
  ↓
Verification
  ↓
Pull-request set
```

Examples:

- Framework migrations
- Cross-repository changes
- Frontend and backend features
- Authentication redesign
- Infrastructure migrations
- Large refactors
- New product areas

## 3.3 Observable by default

Users must always be able to inspect:

- What the agent is doing
- Why the system chose the current plan
- Commands that were run
- Files that changed
- Tests that passed or failed
- Current blockers
- Cost and elapsed time
- Which model and agent role performed each action

## 3.4 Interruptible and recoverable

Users must be able to:

- Pause work
- Resume work
- Cancel work
- Add instructions
- Edit the plan
- Approve risky actions
- Take over the terminal or IDE
- Return control to the agent
- Retry from a checkpoint
- Fork an earlier state

## 3.5 Evidence over claims

A builder agent saying “done” is not sufficient.

Completion requires evidence:

- Tests
- Type checks
- Lint checks
- Screenshots
- Browser traces
- Review results
- Security findings
- Acceptance-criteria mapping
- Mergeability checks

## 3.6 Open architecture

The platform should support multiple:

- Models
- Coding agents
- Sandbox providers
- Git providers
- Authentication providers
- Observability systems
- Artifact stores

Every external dependency should sit behind a stable internal abstraction.

---

# 4. User Personas

## 4.1 Individual engineer

Needs:

- Quick cloud coding sessions
- Bug fixes and feature implementation
- Test execution
- Pull-request creation
- Ability to take over the workspace

## 4.2 Engineering manager

Needs:

- Parallel execution of backlog items
- Status visibility
- Cost controls
- Quality and completion metrics
- Repository and team policies

## 4.3 Staff or principal engineer

Needs:

- Architecture-aware planning
- Cross-repository work
- Technical review
- Migration coordination
- Dependency visibility

## 4.4 Product manager

Needs:

- Outcome-oriented project requests
- Editable plans
- Acceptance criteria
- Progress visibility
- Clear blockers and tradeoffs

## 4.5 Platform administrator

Needs:

- Authentication and access controls
- Repository restrictions
- Model policies
- Sandbox policies
- Audit logs
- Network controls
- Data-retention controls
- Usage and budget management

---

# 5. Core User Flows

## 5.1 Start a fast coding session

1. User selects a repository.
2. User enters a task.
3. System creates a cloud sandbox.
4. System clones the repository.
5. System runs repository setup.
6. Coding agent inspects the code.
7. Agent creates a working plan.
8. Agent implements the change.
9. Agent runs relevant checks.
10. Agent opens a draft pull request.
11. System presents files, tests, logs, and risks.

## 5.2 Start a managed project

1. User selects repositories and describes an outcome.
2. Context collector retrieves repository and organizational context.
3. Planner creates:
   - Assumptions
   - Clarifying questions
   - Acceptance criteria
   - Risks
   - Dependency graph
   - Verification plan
4. User edits or approves the plan.
5. System creates workstreams.
6. Each workstream receives its own agent run and isolated branch or workspace.
7. Independent agents execute eligible tasks in parallel.
8. Integration agent combines results.
9. Reviewer and QA agents validate the integrated state.
10. System opens one or more pull requests.
11. User receives an evidence package.

## 5.3 Take over a session

1. User opens an active session.
2. User clicks “Take over.”
3. Agent is paused at a safe boundary.
4. User receives terminal, browser, and IDE control.
5. User edits or investigates.
6. User clicks “Return to agent.”
7. System records user changes and instructions.
8. Agent resumes from the updated state.

## 5.4 Retry from checkpoint

1. User opens a failed or low-quality run.
2. User selects an earlier checkpoint.
3. User may change:
   - Model
   - Instructions
   - Agent role
   - Tool permissions
   - Verification requirements
4. System forks the sandbox and workflow state.
5. New run proceeds without modifying the original run.

---

# 6. Functional Requirements

# 6.1 Session Management

The platform must support:

- Create session
- Start session
- Pause session
- Resume session
- Cancel session
- Restart session
- Fork session
- Clone session
- Delete session
- Archive session
- Search session history
- Filter sessions by repository, status, user, project, and date
- Add follow-up instructions
- Attach files or context
- View current status
- View current agent activity
- View model usage
- View cost
- View elapsed time
- View artifacts
- View changed files
- View terminal output
- View browser state
- View pull-request status

Session statuses:

```text
CREATED
PROVISIONING
INITIALIZING
PLANNING
WAITING_FOR_APPROVAL
RUNNING
WAITING_FOR_USER
PAUSED
VERIFYING
REVIEWING
PR_READY
COMPLETED
FAILED
CANCELLED
ARCHIVED
```

---

# 6.2 Cloud Workspace and Sandbox

Each agent session must receive a secure and isolated execution environment.

Required sandbox operations:

```text
createWorkspace()
startWorkspace()
stopWorkspace()
resumeWorkspace()
snapshotWorkspace()
forkWorkspace()
destroyWorkspace()
executeCommand()
startProcess()
streamProcess()
killProcess()
readFile()
writeFile()
listFiles()
searchFiles()
openTerminal()
openBrowser()
exposePort()
createPreviewUrl()
uploadArtifact()
downloadArtifact()
```

Required sandbox capabilities:

- Linux environment
- Docker support where permitted
- Repository clone
- Git credentials
- Persistent filesystem
- CPU and memory configuration
- Configurable storage
- Environment variables
- Secret injection
- Network policies
- Domain allowlists
- Port previews
- Browser automation
- VNC or remote desktop when needed
- Background processes
- Snapshot and restore
- Idle shutdown
- Automatic cleanup
- Audit logging
- Per-organization isolation
- Optional regional placement
- Time and cost limits

Sandbox provider abstraction:

```typescript
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<Sandbox>;
  start(id: string): Promise<Sandbox>;
  stop(id: string): Promise<void>;
  resume(id: string): Promise<Sandbox>;
  snapshot(id: string): Promise<Snapshot>;
  fork(snapshotId: string): Promise<Sandbox>;
  execute(id: string, command: Command): Promise<Execution>;
  stream(id: string, processId: string): AsyncIterable<ProcessOutput>;
  exposePort(id: string, port: number): Promise<Preview>;
  destroy(id: string): Promise<void>;
}
```

Initial implementations:

- `DaytonaSandboxProvider`
- `LocalDockerSandboxProvider`

Future implementations:

- `KubernetesSandboxProvider`
- `E2BSandboxProvider`
- Internal private-cloud provider

---

# 6.3 Repository Setup

Each repository should support a version-controlled agent configuration file.

Recommended file:

```text
.agent/project.yaml
```

Example:

```yaml
version: 1

setup:
  image: node:22
  commands:
    - corepack enable
    - pnpm install

services:
  - name: postgres
    command: docker compose up -d postgres
    healthcheck: pg_isready

commands:
  test: pnpm test
  lint: pnpm lint
  typecheck: pnpm typecheck
  dev: pnpm dev
  build: pnpm build

agent:
  instructions:
    - Follow existing architectural patterns.
    - Do not modify generated files manually.
    - Prefer repository utilities over adding dependencies.

verification:
  required:
    - typecheck
    - unit_tests

network:
  allowed_domains:
    - registry.npmjs.org
    - github.com

artifacts:
  paths:
    - test-results/**
    - playwright-report/**
```

Repository setup should support:

- Setup commands
- Environment image
- Required services
- Test commands
- Lint commands
- Build commands
- Dev-server command
- Allowed network domains
- Repository instructions
- Required secrets
- Artifact paths
- Verification policies
- Code ownership hints

---

# 6.4 Agent Runtime

The platform should support more than one coding-agent implementation.

Agent adapter interface:

```python
from typing import AsyncIterator, Protocol

class CodingAgentAdapter(Protocol):
    async def start(self, context: "AgentContext") -> "AgentRun":
        ...

    async def send(self, run_id: str, message: str) -> None:
        ...

    async def pause(self, run_id: str) -> None:
        ...

    async def resume(self, run_id: str) -> None:
        ...

    async def cancel(self, run_id: str) -> None:
        ...

    async def stream_events(self, run_id: str) -> AsyncIterator["AgentEvent"]:
        ...
```

Initial adapters:

- OpenHands adapter
- Claude Code adapter
- Codex adapter

Future adapters:

- Gemini coding agent
- Internal agent
- ACP-compatible agents

The control plane must not depend directly on provider-specific events.

Normalized event schema:

```typescript
type AgentEvent = {
  id: string;
  organizationId: string;
  projectId?: string;
  sessionId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type:
    | "message"
    | "thought_summary"
    | "tool_started"
    | "tool_completed"
    | "command_output"
    | "file_changed"
    | "test_result"
    | "browser_action"
    | "artifact_created"
    | "approval_requested"
    | "status_changed"
    | "checkpoint_created"
    | "error";
  payload: unknown;
};
```

Provider-native events should be stored separately for debugging.

---

# 6.5 Single-Agent Coding Loop

Default loop:

1. Parse the task.
2. Inspect repository instructions.
3. Search relevant files and symbols.
4. Identify constraints.
5. Create a concise execution plan.
6. Make the smallest coherent change.
7. Run targeted checks.
8. Analyze failures.
9. Revise implementation.
10. Run required repository checks.
11. Summarize changes and limitations.
12. Commit changes.
13. Open or update a draft pull request.
14. Emit structured completion evidence.

Agent tools:

- Terminal execution
- File read/write
- File search
- Code symbol search
- Git
- GitHub
- Browser
- Playwright
- Test runner
- Language server
- Package documentation
- Web search
- MCP tools
- Internal documentation search
- Screenshot capture
- Artifact upload

Guardrails:

- Maximum iteration count
- Maximum wall-clock duration
- Maximum token budget
- Maximum dollar budget
- Restricted commands
- Restricted network access
- Approval for destructive actions
- Automatic stop after repeated identical failures
- No direct production writes by default
- No merges by default

---

# 6.6 Planning System

The planning system is a core proprietary subsystem.

Responsibilities:

- Interpret ambiguous outcomes
- Inspect repositories
- Retrieve organizational context
- Generate assumptions
- Generate clarifying questions
- Generate acceptance criteria
- Identify risks
- Identify affected services and repositories
- Produce a task graph
- Assign recommended agent roles
- Produce a verification plan
- Estimate complexity
- Identify human approval points
- Revise plans when assumptions fail

Plan schema:

```typescript
type ProjectPlan = {
  id: string;
  organizationId: string;
  projectId: string;
  objective: string;
  summary: string;
  assumptions: Assumption[];
  clarifyingQuestions: ClarifyingQuestion[];
  acceptanceCriteria: Criterion[];
  risks: Risk[];
  repositories: RepositoryRef[];
  tasks: PlannedTask[];
  edges: DependencyEdge[];
  verificationPlan: VerificationStep[];
  status:
    | "draft"
    | "waiting_for_answers"
    | "waiting_for_approval"
    | "approved"
    | "executing"
    | "replanning"
    | "complete"
    | "cancelled";
  version: number;
  createdAt: string;
  updatedAt: string;
};

type PlannedTask = {
  id: string;
  title: string;
  description: string;
  repositories: string[];
  dependencies: string[];
  expectedFiles?: string[];
  acceptanceCriteria: Criterion[];
  verificationSteps: VerificationStep[];
  suggestedAgentRole:
    | "planner"
    | "builder"
    | "researcher"
    | "reviewer"
    | "test_engineer"
    | "browser_qa"
    | "integration"
    | "security_reviewer";
  estimatedComplexity: "small" | "medium" | "large";
  estimatedDurationMinutes?: number;
  canRunInParallel: boolean;
  requiresHumanApproval: boolean;
};
```

Planning output must be structured and machine-readable. Do not rely on unstructured prose alone.

The planner should use:

- Static repository inspection
- Search and retrieval
- Dependency manifests
- Code ownership
- Historical pull requests
- Repository instructions
- LLM reasoning
- Deterministic validation

Plan validation should detect:

- Missing acceptance criteria
- Circular dependencies
- Unowned tasks
- Tasks with no verification method
- Parallel tasks likely to edit the same files
- Missing integration task
- Missing migration or rollback strategy
- Missing security review for sensitive areas

---

# 6.7 Multi-Agent Roles

Agents should have distinct responsibilities, context, permissions, and completion criteria.

## Planner

Responsibilities:

- Understand objective
- Inspect context
- Generate task graph
- Define acceptance criteria
- Define verification
- Identify risk

Restrictions:

- Does not normally modify production code
- Does not approve its own plan

## Builder

Responsibilities:

- Implement one scoped workstream
- Run relevant checks
- Commit changes
- Produce structured handoff

Restrictions:

- Works only within assigned scope
- Does not declare overall project complete
- Cannot approve its own output

## Researcher

Responsibilities:

- Investigate unfamiliar systems
- Read documentation
- Search historical implementations
- Compare options
- Return evidence

Restrictions:

- Read-only by default
- No code commits unless explicitly reassigned

## Reviewer

Responsibilities:

- Review task, acceptance criteria, and diff independently
- Search for correctness issues
- Search for regressions
- Search for security problems
- Search for maintainability issues
- Produce blocking and non-blocking findings

Restrictions:

- Must not rely only on the builder summary
- Should use an independent model family when practical

## Test Engineer

Responsibilities:

- Translate acceptance criteria into executable validation
- Add or run tests
- Exercise negative cases
- Check edge cases
- Identify missing coverage

## Browser QA Agent

Responsibilities:

- Launch application
- Execute user flows through Playwright
- Capture screenshots
- Capture traces
- Capture console logs
- Capture network failures
- Compare expected and actual behavior

## Integration Agent

Responsibilities:

- Combine workstreams
- Resolve conflicts
- Rebase branches
- Verify shared interfaces
- Run repository-wide checks
- Own final branch integrity

## Security Reviewer

Responsibilities:

- Review authentication and authorization
- Review secret handling
- Review privilege boundaries
- Review dependency changes
- Review unsafe shell usage
- Review infrastructure and network changes

---

# 6.8 Multi-Agent Orchestration

Required orchestration capabilities:

- Directed acyclic task graph
- Dependency resolution
- Parallel execution
- Concurrency limits
- Per-agent branch or workspace
- Structured handoffs
- Cancellation
- Retries
- Timeouts
- Failure propagation
- Dynamic replanning
- Human approvals
- Integration checkpoints
- Conflict detection
- Final convergence policy

Use Temporal for durable execution.

Illustrative workflow:

```text
ProjectWorkflow
 ├── CollectContextActivity
 ├── CompilePlanWorkflow
 ├── WaitForPlanApproval
 ├── ExecuteTask child workflows
 │    ├── ProvisionSandbox
 │    ├── StartAgent
 │    ├── MonitorAgent
 │    ├── RunTaskVerification
 │    └── StoreHandoff
 ├── IntegrationWorkflow
 ├── ReviewWorkflow
 ├── VerificationWorkflow
 ├── PullRequestWorkflow
 └── PublishEvidenceActivity
```

Rules for fan-out:

- Default maximum: 3 concurrent builder agents
- Increase only after evaluation proves value
- Do not parallelize tasks that edit the same files or interfaces
- Require explicit integration ownership
- Prefer one agent for tightly coupled work
- Stop agents that repeatedly fail without new information
- Replan when dependencies change materially

---

# 6.9 Verification Engine

The verification engine is a core proprietary subsystem.

It should map the type of change to required evidence.

Example policy:

```yaml
change_types:
  frontend_behavior:
    required:
      - typecheck
      - unit_tests
      - browser_flow
      - screenshots
      - console_error_check

  api_endpoint:
    required:
      - typecheck
      - unit_tests
      - integration_tests
      - authorization_tests
      - api_contract_check

  database_migration:
    required:
      - migration_up
      - migration_recovery_plan
      - schema_diff
      - backward_compatibility_check
      - data_integrity_check

  authentication:
    required:
      - security_review
      - privilege_boundary_tests
      - negative_access_tests
      - secret_scan

  dependency_update:
    required:
      - lockfile_validation
      - unit_tests
      - integration_tests
      - vulnerability_scan
      - changelog_review
```

Verification pipeline:

```text
Builder completion claim
        ↓
Static checks
        ↓
Unit tests
        ↓
Integration tests
        ↓
Independent reviewer
        ↓
Browser QA when applicable
        ↓
Security and policy checks
        ↓
Acceptance-criteria evaluation
        ↓
Mergeability check
        ↓
Evidence package
```

Completion condition:

```text
All required tasks complete
AND task graph converged
AND required checks passed
AND no blocking reviewer findings remain
AND acceptance criteria have supporting evidence
AND final branch is mergeable
```

Every acceptance criterion should map to one or more evidence items.

Evidence item schema:

```typescript
type EvidenceItem = {
  id: string;
  projectId: string;
  sessionId?: string;
  taskId?: string;
  criterionId?: string;
  type:
    | "test_result"
    | "lint_result"
    | "typecheck_result"
    | "screenshot"
    | "browser_trace"
    | "console_log"
    | "network_log"
    | "review_finding"
    | "security_scan"
    | "command_log"
    | "artifact"
    | "manual_approval";
  status: "passed" | "failed" | "warning" | "informational";
  title: string;
  summary: string;
  artifactUrl?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};
```

---

# 6.10 Evidence Package

A completed project or session must provide:

- Original request
- Final approved plan
- Plan revisions
- Assumptions
- Acceptance criteria
- Repository and branch information
- Tasks and owners
- Agent runs
- Files changed
- Commits
- Pull requests
- Commands run
- Unit-test results
- Integration-test results
- Lint results
- Type-check results
- Build results
- Browser screenshots
- Playwright traces
- Console output
- Network failures
- Security findings
- Reviewer findings
- Known limitations
- Remaining risks
- Cost
- Duration
- Models used
- Human interventions

The evidence package should be viewable in the UI and exportable as JSON and Markdown.

---

# 6.11 Memory and Retrieval

Memory should be divided into layers.

## Session Memory

Includes:

- Current task
- Current plan
- Agent messages
- Tool calls
- Command output
- Current failures
- Files changed
- User corrections
- Pending approvals

## Repository Memory

Includes:

- Setup instructions
- Architecture
- Testing conventions
- Important modules
- Service dependencies
- Code ownership
- Known footguns
- Historical migrations
- Relevant pull requests
- Preferred patterns

## Organizational Memory

Includes:

- Engineering standards
- Security policies
- Release procedures
- Preferred libraries
- Team ownership
- Internal terminology
- Review expectations
- Compliance requirements

## Learned Operational Memory

Includes:

- Successful task-decomposition patterns
- Failed strategies
- Common environment failures
- Model performance by task type
- Repeated review feedback
- Useful prompts
- Repository-specific agent corrections

Memory item schema:

```typescript
type MemoryItem = {
  id: string;
  organizationId: string;
  scopeType: "session" | "repository" | "project" | "organization";
  scopeId: string;
  title: string;
  content: string;
  sourceType:
    | "user"
    | "repository_file"
    | "documentation"
    | "pull_request"
    | "session"
    | "policy"
    | "system_generated";
  sourceReference?: string;
  authority: "low" | "medium" | "high";
  confidence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  ownerId?: string;
  accessPolicy: string[];
  embedding?: number[];
  metadata: Record<string, unknown>;
};
```

Memory requirements:

- Every retrieved item must be source-cited.
- Freshness must be visible.
- Scope must be enforced.
- Access permissions must be checked.
- Conflicting memories must be surfaced.
- Users must be able to edit or delete memory.
- Sensitive information must be filtered.
- Expired knowledge must not be silently treated as current.
- Retrieval should explain why an item was selected.

Do not dump all chat history into a vector database and call it memory.

Initial storage:

- PostgreSQL
- JSONB
- pgvector

Add a dedicated vector or graph database only after demonstrated need.

---

# 6.12 Model Routing

Use explicit role-based routing initially.

Example:

| Agent role | Desired model characteristics |
|---|---|
| Planner | Strong reasoning, long context, structured output |
| Builder | Strong code generation, tool use, debugging |
| Reviewer | Independent reasoning, code review quality |
| Researcher | Retrieval, summarization, long-context reading |
| Browser QA | Reliable structured tool execution |
| Summarizer | Fast and inexpensive |
| Classifier | Small and inexpensive |

Use LiteLLM as the model gateway for:

- Provider abstraction
- Load balancing
- Retry
- Fallback
- Budget controls
- Usage tracking
- Model aliases

The application, not LiteLLM, should decide which role and model class to use.

Routing inputs may later include:

- Repository language
- Task category
- Complexity
- Context size
- Tool requirements
- Customer policy
- Cost budget
- Latency target
- Historical success rate
- Data residency requirements

Model decision record:

```typescript
type ModelRoutingDecision = {
  role: string;
  requestedClass: string;
  selectedProvider: string;
  selectedModel: string;
  reason: string;
  fallbackModels: string[];
  budgetLimitUsd?: number;
  latencyTargetMs?: number;
};
```

---

# 6.13 Human Approval System

Actions requiring approval may include:

- Running destructive commands
- Modifying infrastructure
- Accessing sensitive secrets
- Changing authentication logic
- Applying database migrations
- Writing to external systems
- Opening a non-draft pull request
- Merging a pull request
- Deploying
- Increasing project budget
- Expanding network access

Approval schema:

```typescript
type ApprovalRequest = {
  id: string;
  organizationId: string;
  projectId?: string;
  sessionId?: string;
  requestedByRunId: string;
  actionType: string;
  title: string;
  description: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requestedAt: string;
  expiresAt?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  approverId?: string;
  decisionReason?: string;
};
```

Authorization must be refreshed before durable or high-risk actions. Prior approval should not automatically apply after the context materially changes.

---

# 6.14 GitHub Integration

Use a GitHub App.

Required capabilities:

- List accessible repositories
- Clone repositories with scoped credentials
- Read branches and commits
- Create branches
- Read pull requests
- Create draft pull requests
- Update pull-request descriptions
- Add comments
- Read checks
- Read review comments
- Create commit statuses
- Request reviews
- Read CODEOWNERS
- Link sessions to pull requests
- Detect merge conflicts
- Detect branch protection
- Track merged or closed state

Do not give agents broad personal access tokens.

Pull-request description should include:

- Task summary
- Implementation summary
- Acceptance criteria
- Verification evidence
- Screenshots
- Test commands
- Known limitations
- Session link
- Cost and duration when configured

---

# 6.15 Browser and UI Verification

Use Playwright.

Required capabilities:

- Launch app in sandbox
- Wait for health check
- Run named user flows
- Capture screenshots
- Capture video optionally
- Capture Playwright trace
- Capture browser console
- Capture page errors
- Capture failed network requests
- Record step-by-step results
- Store artifacts in object storage

Browser-flow schema:

```yaml
name: create_project
base_url: http://localhost:3000
steps:
  - action: goto
    path: /projects
  - action: click
    selector: text=New project
  - action: fill
    selector: input[name=name]
    value: Demo Project
  - action: click
    selector: button[type=submit]
  - action: expect_text
    text: Demo Project
artifacts:
  screenshots: true
  trace: true
  console: true
```

Where possible, agents should generate or reuse deterministic Playwright tests instead of relying only on free-form visual interaction.

---

# 6.16 Command Center UI

The main command center should show:

- Queued sessions
- Provisioning sessions
- Planning sessions
- Waiting-for-approval sessions
- Active sessions
- Blocked sessions
- Paused sessions
- Verification sessions
- Review-ready sessions
- Failed sessions
- Completed sessions

Each card should show:

- Task title
- Repository
- Project
- Agent role
- Current action
- Status
- Elapsed time
- Estimated remaining work if available
- Cost
- Test status
- Pull-request status
- Human attention required

Project detail page:

```text
Project
 ├── Overview
 ├── Plan
 ├── Dependency graph
 ├── Workstreams
 ├── Sessions
 ├── Pull requests
 ├── Verification
 ├── Artifacts
 ├── Decisions
 ├── Risks
 ├── Cost
 └── Audit log
```

Session detail page:

```text
Session
 ├── Conversation
 ├── Activity timeline
 ├── Terminal
 ├── Browser
 ├── IDE
 ├── Changed files
 ├── Tests
 ├── Artifacts
 ├── Checkpoints
 ├── Model usage
 └── Pull request
```

Use WebSockets or Server-Sent Events for live updates.

---

# 6.17 Governance and Enterprise Controls

Required enterprise features:

- Organization isolation
- Role-based access control
- Repository allowlists
- Per-repository access controls
- Model-provider restrictions
- Data-retention policies
- Regional execution policies
- Audit logs
- Secret access policies
- Network egress controls
- Domain allowlists
- Session export
- Session deletion
- Usage quotas
- Budget limits
- Concurrency limits
- Protected operations
- Branch protection awareness
- Private networking
- SSO and SCIM later
- Customer-managed keys later

Default restrictions:

- No production access
- No direct merge
- No deployment
- No unrestricted internet
- No reusable long-lived personal credentials
- No secrets in prompts or logs
- No cross-organization memory

---

# 7. Non-Functional Requirements

## Reliability

- Workflow state must survive API and worker restarts.
- Session event ordering must be deterministic.
- Sandbox failure must not corrupt product state.
- Every action must be idempotent where practical.
- Duplicate workflow execution must not create duplicate pull requests.
- Artifacts must be durable.

## Performance

Initial targets:

- Workspace request accepted in less than 1 second.
- Warm sandbox usable in less than 15 seconds.
- Cold sandbox usable in less than 90 seconds.
- Live events visible within 2 seconds.
- Command output streaming latency below 2 seconds.
- Command-center page loads in less than 3 seconds for normal organizations.

## Scalability

Initial design target:

- 100 organizations
- 1,000 users
- 500 concurrent sessions
- 100 concurrent active sandboxes
- Millions of session events

Design should be horizontally scalable.

## Security

- Encrypt data in transit and at rest.
- Use short-lived credentials.
- Redact secrets from logs.
- Isolate sandbox networking.
- Maintain immutable audit logs.
- Prevent cross-tenant access.
- Scan artifacts and logs for credentials.
- Verify permissions before Git writes.

## Observability

Track:

- Workflow latency
- Sandbox startup time
- Agent duration
- Model latency
- Token usage
- Cost
- Error rate
- Retry rate
- Tool failures
- Test outcomes
- Pull-request outcomes
- Human intervention
- Merge rate
- Regression rate

---

# 8. Recommended Technology Stack

Use one primary language and package ecosystem for the initial product:

- TypeScript
- Node.js
- pnpm workspaces
- Turborepo

The system still uses separate runtime processes:

```text
Runtime 1: Next.js application
Runtime 2: Temporal TypeScript worker
Runtime 3: Optional gateway later
```

Everything can use TypeScript without everything running inside Next.js. Next.js handles short-lived product requests. Temporal workers handle long-running, durable agent execution.

# 8.1 Frontend and Product API

Use:

- Next.js
- React
- TypeScript
- Next.js Route Handlers
- Tailwind CSS
- shadcn/ui or equivalent
- TanStack Query
- Monaco editor
- xterm.js
- React Flow
- WebSockets or Server-Sent Events

Next.js responsibilities:

- Authentication
- Organization and user management
- Project and session APIs
- Plan editing
- Approvals
- GitHub webhooks
- Repository selection
- Read-model queries
- Starting and signaling Temporal workflows
- Streaming live session updates

Keep Route Handlers thin. Business logic belongs in shared packages.

```typescript
export async function POST(request: Request) {
  const input = StartSessionSchema.parse(await request.json());
  const session = await sessionService.create(input);

  await temporalClient.workflow.start(sessionWorkflow, {
    taskQueue: "agent-sessions",
    workflowId: `session-${session.id}`,
    args: [{ sessionId: session.id }],
  });

  return Response.json(session, { status: 201 });
}
```

Do not introduce Fastify initially.

Extract a Fastify API later only if there is a concrete need for:

- Multiple frontend or mobile clients
- A public developer API
- Independent API scaling
- High-volume WebSocket traffic
- Heavy webhook isolation
- Separate backend team ownership
- Divergent frontend and backend deployment cycles

# 8.2 Durable Workflows and Workers

Use the Temporal TypeScript SDK.

The worker must run as a separate Node.js process from Next.js.

Responsibilities:

- Sandbox provisioning
- Repository initialization
- Planning
- Agent execution
- Review
- Verification
- Browser QA
- Checkpointing
- Human approval waits
- Pull-request creation
- Retry and recovery
- Scheduled work

Temporal owns durable workflow state. PostgreSQL owns product state, dashboards, search, filtering, and read models.

# 8.3 Agent Runtime

Use TypeScript adapters.

```typescript
interface AgentAdapter {
  start(input: AgentStartInput): Promise<AgentRun>;
  send(runId: string, message: string): Promise<void>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  events(runId: string): AsyncIterable<AgentEvent>;
}
```

Initial adapters:

- Claude Code
- Codex
- OpenHands
- ACP-compatible agents

Preferred integration order:

1. Stable TypeScript SDK
2. ACP
3. MCP
4. HTTP API
5. CLI process inside the sandbox

Do not add Python only because many AI tools use it. Add an isolated Python service later only when a critical capability cannot be accessed cleanly through TypeScript, an API, ACP, MCP, or a sandboxed CLI.

# 8.4 Sandbox

Use Daytona initially behind the `SandboxProvider` abstraction.

Also provide Local Docker for development and CI.

Add Kubernetes later only when cost, compliance, private-cloud deployment, regional execution, scale, or custom isolation justify it.

# 8.5 Browser Infrastructure

Use Playwright as the underlying browser platform.

Playwright provides deterministic control, DOM and accessibility interaction, screenshots, traces, console capture, network capture, cross-browser support, and CI-compatible tests.

A browser agent and Playwright are complementary:

```text
Browser agent
    ↓
Decides what to do

Playwright
    ↓
Executes and records browser actions
```

Recommended hierarchy:

1. Existing deterministic Playwright test
2. Generated Playwright test
3. Playwright DOM or accessibility interaction
4. Playwright MCP browser agent
5. Screenshot-based visual reasoning
6. Full computer-use agent

Use browser agents for exploration and unknown flows. Use deterministic Playwright tests as completion gates.

```text
Natural-language acceptance criterion
        ↓
Browser agent explores with Playwright
        ↓
Agent creates or updates a Playwright test
        ↓
Test runs deterministically
        ↓
Trace, screenshots, console output, and result become evidence
```

# 8.6 Model Gateway

Start with direct provider SDKs behind an internal interface.

Introduce LiteLLM when centralized multi-provider routing, fallback, rate limits, budgets, and customer-specific model policies become necessary.

The application owns role and task routing. LiteLLM executes routing decisions; it does not define product policy.

# 8.7 Data Layer

Use:

- PostgreSQL
- JSONB
- pgvector
- S3-compatible object storage
- Redis only for ephemeral caching, rate limiting, or transient coordination

Do not initially add a separate graph database, vector database, event database, or large analytics platform.

# 8.8 Observability and Langfuse

Use OpenTelemetry from day one for:

- HTTP requests
- Temporal workflows and activities
- Sandbox lifecycle
- Agent lifecycle
- Model calls
- Database latency
- GitHub operations
- Playwright runs
- Artifacts
- Errors and retries

Store model invocation records in PostgreSQL:

```text
provider
model
agent role
prompt version
input tokens
output tokens
cost
latency
status
error
session
project
```

Langfuse is optional for the MVP.

Add Langfuse when the team starts regularly comparing:

- Planner prompts
- Reviewer prompts
- Model choices
- Retrieval strategies
- Agent implementations
- Evaluation datasets
- Human feedback
- Cost and quality tradeoffs

Use Langfuse for:

- LLM traces
- Prompt versioning
- Model latency and cost analysis
- Datasets
- Experiments
- Human and automated evaluations
- Comparing agent and model performance

Langfuse must not be the source of truth for sessions, projects, plans, approvals, or workflow state.

# 8.9 Authentication

Use a managed identity provider such as WorkOS, Auth0, Clerk, or an existing OIDC provider.

# 8.10 Monorepo and Shared Types

Use:

- pnpm workspaces
- Turborepo
- Zod
- Drizzle or Prisma
- Shared TypeScript packages

Recommended initial ORM: Drizzle. Prisma is acceptable if already standardized.

# 9. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 Next.js Application                        │
│ React UI · Route Handlers · Auth · Webhooks · Live Views   │
└────────────────────────────┬────────────────────────────────┘
                             │
                    PostgreSQL + pgvector
                             │
                      Temporal Client
                             │
┌────────────────────────────▼────────────────────────────────┐
│                Temporal TypeScript Worker                  │
│ Plan · Build · Review · Verify · Approvals · PR Workflow   │
└───────────────┬────────────────────────────┬────────────────┘
                │                            │
       ┌────────▼─────────┐          ┌───────▼──────────┐
       │ Agent Adapters   │          │ Model Interface  │
       │ Claude Code      │          │ Direct SDKs or   │
       │ Codex            │          │ LiteLLM          │
       │ OpenHands        │          └──────────────────┘
       └────────┬─────────┘
                │
       ┌────────▼────────────┐
       │ Sandbox Abstraction │
       └────────┬────────────┘
                │
     ┌──────────▼───────────────┐
     │ Daytona / Local Docker   │
     │ Git · Terminal · IDE     │
     │ Browser · Snapshots      │
     └──────────┬───────────────┘
                │
     ┌──────────▼────────────────────────┐
     │ GitHub · Playwright · Artifacts   │
     │ PRs · Tests · Traces · Screenshots│
     └───────────────────────────────────┘
```

The architecture uses one primary language while preserving process boundaries:

- Next.js handles short-lived product interactions.
- Temporal workers handle durable long-running work.
- Sandboxes execute untrusted repository and agent workloads.
- Shared TypeScript packages prevent duplicated schemas and logic.
- External systems remain behind internal interfaces.

# 10. Runtime and Package Boundaries

## `apps/web`

Next.js application responsible for UI, Route Handlers, authentication callbacks, GitHub webhooks, product APIs, approval APIs, read-model queries, Temporal workflow calls, and live event streaming.

## `apps/worker`

Temporal TypeScript worker responsible for workflows, planning, agent execution, sandbox lifecycle, review, verification, browser QA, checkpointing, pull requests, retries, and recovery.

## Optional later: `apps/gateway`

Extract only when public APIs, high-volume streaming, agent-protocol normalization, webhook isolation, or independent scaling require it.

Shared packages:

```text
packages/
├── domain
├── database
├── events
├── workflows
├── activities
├── agents
├── sandboxes
├── github
├── browser
├── verification
├── memory
├── telemetry
├── policy
├── config
└── ui
```

# 11. Domain Model

Core entities:

```text
Organization
User
OrganizationMembership
RepositoryConnection
Repository
Project
ProjectPlan
PlannedTask
TaskDependency
Session
AgentRun
Sandbox
Checkpoint
Artifact
EvidenceItem
VerificationRun
ReviewFinding
ApprovalRequest
MemoryItem
ModelInvocation
PullRequest
AuditEvent
UsageRecord
```

Suggested relationships:

```text
Organization
 ├── Users
 ├── RepositoryConnections
 ├── Repositories
 ├── Projects
 └── Policies

Project
 ├── Plan versions
 ├── Planned tasks
 ├── Sessions
 ├── Pull requests
 ├── Evidence
 └── Audit events

Session
 ├── Agent runs
 ├── Sandbox
 ├── Checkpoints
 ├── Events
 ├── Artifacts
 ├── Evidence
 └── Pull request
```

---

# 12. Database Tables

Suggested initial tables:

```text
organizations
users
organization_memberships
repository_connections
repositories
repository_configurations
projects
project_plans
planned_tasks
task_dependencies
sessions
agent_runs
agent_events
sandboxes
checkpoints
artifacts
evidence_items
verification_runs
review_findings
approval_requests
memory_items
model_invocations
pull_requests
audit_events
usage_records
organization_policies
```

Important indexes:

- `sessions(organization_id, status, updated_at)`
- `sessions(repository_id, created_at)`
- `agent_events(session_id, sequence)`
- `planned_tasks(plan_id, status)`
- `task_dependencies(plan_id, upstream_task_id)`
- `memory_items(organization_id, scope_type, scope_id)`
- Vector index on memory embeddings
- `audit_events(organization_id, created_at)`
- `usage_records(organization_id, created_at)`

Large event payloads may eventually move to object storage, while PostgreSQL stores metadata and searchable projections.

---

# 13. API Design

Core endpoints:

```text
POST   /v1/projects
GET    /v1/projects/:projectId
POST   /v1/projects/:projectId/plan
PATCH  /v1/plans/:planId
POST   /v1/plans/:planId/approve
POST   /v1/projects/:projectId/execute
POST   /v1/projects/:projectId/cancel

POST   /v1/sessions
GET    /v1/sessions
GET    /v1/sessions/:sessionId
POST   /v1/sessions/:sessionId/messages
POST   /v1/sessions/:sessionId/pause
POST   /v1/sessions/:sessionId/resume
POST   /v1/sessions/:sessionId/cancel
POST   /v1/sessions/:sessionId/takeover
POST   /v1/sessions/:sessionId/return-control
POST   /v1/sessions/:sessionId/checkpoints
POST   /v1/sessions/:sessionId/fork

GET    /v1/sessions/:sessionId/events
GET    /v1/sessions/:sessionId/artifacts
GET    /v1/sessions/:sessionId/evidence
GET    /v1/sessions/:sessionId/files

GET    /v1/projects/:projectId/graph
GET    /v1/projects/:projectId/evidence
GET    /v1/projects/:projectId/pull-requests

POST   /v1/approvals/:approvalId/approve
POST   /v1/approvals/:approvalId/reject

GET    /v1/repositories
POST   /v1/repositories/:repositoryId/index
GET    /v1/repositories/:repositoryId/memory

GET    /v1/usage
GET    /v1/audit-events
```

Live event channel:

```text
WS /v1/sessions/:sessionId/stream
```

or:

```text
GET /v1/sessions/:sessionId/events/stream
Content-Type: text/event-stream
```

---

# 14. Event Model

Events must be append-only and ordered per session.

Example event:

```json
{
  "id": "evt_123",
  "organizationId": "org_123",
  "projectId": "proj_123",
  "sessionId": "ses_123",
  "runId": "run_123",
  "sequence": 104,
  "timestamp": "2026-07-25T19:22:00Z",
  "type": "tool_completed",
  "payload": {
    "tool": "terminal.execute",
    "command": "pnpm test",
    "exitCode": 0,
    "durationMs": 12420
  }
}
```

Event-processing requirements:

- Idempotent writes
- Sequence validation
- Replay support
- Provider event mapping
- Sensitive-data redaction
- Size limits
- Artifact references for large output
- Real-time fan-out
- Read-model updates

---

# 15. Repository Context Pipeline

When a repository is connected, create a repository profile.

Pipeline:

1. Read repository metadata.
2. Detect languages and frameworks.
3. Read:
   - README
   - CONTRIBUTING
   - agent instructions
   - package manifests
   - build files
   - test configuration
   - CI configuration
   - CODEOWNERS
4. Build a symbol and file index.
5. Identify key directories.
6. Identify standard commands.
7. Extract architecture notes.
8. Retrieve relevant historical pull requests.
9. Store source-cited repository memory.
10. Refresh incrementally on new commits.

Repository profile:

```typescript
type RepositoryProfile = {
  repositoryId: string;
  defaultBranch: string;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  buildCommands: string[];
  testCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  setupCommands: string[];
  keyDirectories: DirectorySummary[];
  services: ServiceSummary[];
  codeOwners: CodeOwnerRule[];
  instructions: CitedInstruction[];
  updatedAt: string;
  sourceCommitSha: string;
};
```

---

# 16. Agent Context Construction

Agent context must be intentionally assembled, not blindly concatenated.

Recommended context sections:

1. System role and safety rules
2. Assigned task
3. Acceptance criteria
4. Repository instructions
5. Relevant files and symbols
6. Dependency information
7. Prior task handoffs
8. Relevant memory with citations
9. Tool permissions
10. Budget and completion criteria
11. Required output schema

The context builder should:

- Enforce token budgets
- Prioritize authoritative sources
- Deduplicate content
- Include freshness
- Include source references
- Exclude inaccessible memory
- Exclude secrets
- Summarize low-priority material
- Preserve exact acceptance criteria

---

# 17. Checkpointing

Checkpoint types:

- Sandbox snapshot
- Git commit
- Workflow-state checkpoint
- Plan version
- Agent transcript offset
- Artifact manifest

Create checkpoints:

- After repository setup
- After plan approval
- Before risky operations
- After each completed task
- Before integration
- Before final verification
- On user request
- Before model or agent switch

Checkpoint schema:

```typescript
type Checkpoint = {
  id: string;
  sessionId: string;
  sandboxSnapshotId?: string;
  gitCommitSha?: string;
  workflowStateReference: string;
  agentEventSequence: number;
  label: string;
  createdAt: string;
  createdBy: "system" | "user" | "agent";
};
```

---

# 18. Conflict and Convergence Management

Parallel work creates integration risks.

Required mechanisms:

- Branch per workstream
- Expected-file declarations
- File ownership hints
- Shared interface contracts
- Early conflict prediction
- Integration checkpoints
- Rebase before handoff
- Conflict-resolution agent
- Final integration owner
- Whole-repository test gate

Conflict risk score may consider:

- Same files
- Same exported symbols
- Shared dependency manifests
- Shared database migrations
- API schema changes
- Shared generated files
- Overlapping test fixtures

Tasks with high conflict risk should run sequentially.

---

# 19. Agent Evaluation Framework

Every agent run should produce structured evaluation data.

Capture:

- Task category
- Repository
- Language
- Framework
- Agent implementation
- Model
- Prompt version
- Tools enabled
- Context size
- Plan
- Iterations
- Commands
- Test outcome
- Reviewer outcome
- Human interventions
- Human changes after completion
- Pull request merged or rejected
- Production regression
- Cost
- Duration

Core evaluation questions:

- Which model performs best for each task category?
- Does multi-agent execution improve completion?
- When does multi-agent execution increase conflicts?
- Which reviewer finds real issues?
- Does browser QA predict merge success?
- Which memories improve performance?
- Which repository setup failures are recurring?
- What percentage of agent changes are retained by humans?

Offline evaluation set:

```text
evaluations/
 ├── repositories/
 ├── tasks/
 ├── expected_outcomes/
 ├── scorers/
 ├── fixtures/
 └── reports/
```

Scorers:

- Build success
- Test success
- Acceptance-criteria coverage
- Diff relevance
- Regression detection
- Security findings
- Human edit distance
- Cost
- Duration
- Retry count

---

# 20. Product Metrics

## North-star metric

Percentage of accepted tasks that produce a mergeable, useful pull request with minimal human modification and no near-term regression.

## Supporting metrics

- Task completion rate
- Pull-request merge rate
- Median human edit distance
- Time to first useful pull request
- Time to verified completion
- Cost per merged pull request
- Sandbox setup failure rate
- Agent retry rate
- Human intervention rate
- Reviewer blocking-finding rate
- Regression rate
- Acceptance-criteria coverage
- Browser-QA pass rate
- Session resume success rate
- Percentage of tasks requiring replanning
- Multi-agent conflict rate

---

# 21. Build Versus Borrow

# Use Directly

- Temporal
- PostgreSQL
- pgvector
- Playwright
- LiteLLM
- OpenTelemetry
- Langfuse
- S3-compatible object storage
- GitHub App APIs
- Monaco editor
- xterm.js
- React Flow

# Wrap and Extend

- OpenHands
- Daytona
- Claude Code
- Codex
- Gemini coding agents
- Authentication provider
- Web IDE technology

# Build as Proprietary Product Value

- Plan compiler
- Task decomposition
- Dependency-aware orchestration
- Role assignment
- Model-routing policy
- Verification policy engine
- Evidence engine
- Convergence logic
- Conflict management
- Organizational memory quality layer
- Agent evaluation framework
- Human-agent interaction model
- Command-center experience
- Governance policy engine
- Repository context quality
- Completion and confidence scoring

---

# 22. Open-Source Alternatives

## Agent Runtime

### OpenHands

Use for:

- Agent abstractions
- Tool interfaces
- Remote-agent execution patterns
- Browser, terminal, and file interaction
- Model-agnostic agent support
- Basic coding-agent implementation

Do not tightly couple product state to OpenHands internals.

### Open Interpreter

Potentially useful for:

- Local computer interaction
- Terminal-first workflows
- Lightweight experimentation

Less appropriate as the primary cloud orchestration platform.

### SWE-agent

Useful for:

- Benchmark-style software issue solving
- Repository task execution
- Evaluation reference

Not a complete product harness.

### Aider

Useful for:

- Git-aware code editing
- Pair-programming flows
- Local workflows

Not a full cloud-session or multi-agent system.

## Sandbox Providers

### Daytona

Recommended initial choice.

### E2B

Useful alternative for:

- Hosted secure sandboxes
- Fast code execution
- Agent-focused environments

### Kubernetes

Use later for:

- Full infrastructure control
- Private cloud
- Compliance
- Cost optimization at scale

### Local Docker

Use for:

- Development
- CI
- Local testing
- Self-hosted lightweight mode

## Workflow Engines

### Temporal

Recommended.

### Inngest

Potential alternative for simpler event-driven workflows.

### Prefect or Dagster

Better for data workflows than interactive long-running agent orchestration.

### Celery or BullMQ

Useful for simple jobs, but insufficient alone for durable human-in-the-loop agent projects.

## Model Gateways

### LiteLLM

Recommended.

### Portkey

Potential managed alternative.

### Custom provider adapters

Avoid initially unless required by compliance.

## Observability

### Langfuse

Recommended for LLM traces and evaluations.

### Arize Phoenix

Useful open-source alternative for tracing and evaluation.

### OpenTelemetry

Use regardless of the LLM tracing product.

## Memory and Retrieval

### PostgreSQL + pgvector

Recommended initial choice.

### Qdrant, Weaviate, or Milvus

Add only when scale or retrieval features justify a dedicated system.

### Neo4j

Add only if relationship traversal becomes a demonstrated bottleneck.

---

# 23. Implementation Roadmap

# Phase 0: Technical Evaluation

Goal: prove that the core open-source and hosted components work together.

Build:

- Start Daytona sandbox
- Clone GitHub repository
- Run one coding agent
- Stream normalized events
- Change code
- Run tests
- Commit
- Open draft pull request
- Persist session
- Resume after service restart

Test with at least ten representative tasks.

Exit criteria:

- End-to-end runs complete
- API and worker restarts do not lose state
- Users can inspect command output
- Users can inspect changed files
- Pull requests are created reliably
- Sandbox startup is acceptable
- Usage and cost are recorded

---

# Phase 1: Devin-Style Single-Agent MVP

Build:

- Authentication
- Organizations
- GitHub App
- Repository selection
- New-session flow
- Sandbox provisioning
- Repository setup
- One coding-agent adapter
- Streaming conversation
- Activity timeline
- Terminal
- File diff
- Browser preview
- Pause/resume/cancel
- Pull-request creation
- Basic verification
- Artifact storage
- Command center
- Session history

Do not build multi-agent orchestration yet.

Exit criteria:

- Majority of simple benchmark tasks produce useful draft pull requests
- Sessions survive restarts
- Users can take over and return control
- Failures are classified
- Costs are visible
- Basic security review is complete

---

# Phase 2: Trust and Verification

Build:

- Structured acceptance criteria
- Verification policy files
- Independent reviewer agent
- Test evidence
- Playwright browser QA
- Screenshots
- Traces
- Console capture
- Secret scanning
- Mergeability checks
- Checkpoints
- Retry from checkpoint
- Evidence package

Exit criteria:

- Completion requires evidence
- Blocking findings prevent completion
- Users can understand exactly why a task passed or failed
- Evidence is attached to pull requests
- Verification results are reproducible

---

# Phase 3: Planning and Project Mode

Build:

- Context collector
- Plan compiler
- Editable plan UI
- Clarifying questions
- Dependency graph
- Plan approval
- Task child workflows
- Parallel execution
- Integration agent
- Project-level status
- Replanning
- Conflict prediction

Limit parallelism to three or four agents.

Exit criteria:

- Multi-component tasks can complete across multiple workstreams
- Project state survives service failures
- Plan changes are versioned
- Integration failures are visible
- Multi-agent performance is compared against single-agent baselines

---

# Phase 4: Memory

Build:

- Repository profiles
- Source-cited memory
- Organization instructions
- Freshness and expiration
- User memory editor
- Historical PR retrieval
- Learned operational memory
- Retrieval evaluation

Exit criteria:

- Memory reduces repeated environment and convention failures
- Every memory item has source and scope
- Users can inspect why memory was retrieved
- Access rules prevent cross-tenant leakage

---

# Phase 5: Platform Expansion

Build:

- Multiple agent adapters
- Role-based model routing
- Scheduled sessions
- Slack integration
- Jira integration
- Linear integration
- Batch work
- Session templates
- Cross-repository projects
- Private networking
- Enterprise policies
- Additional sandbox providers
- Advanced cost controls
- SSO and SCIM
- Customer-managed model credentials

---

# 24. Suggested Repository Structure

```text
platform/
├── apps/
│   ├── web/
│   ├── worker/
│   └── gateway/
├── packages/
│   ├── domain/
│   ├── database/
│   ├── events/
│   ├── workflows/
│   ├── activities/
│   ├── agents/
│   │   ├── claude-code/
│   │   ├── codex/
│   │   ├── openhands/
│   │   └── shared/
│   ├── sandboxes/
│   ├── github/
│   ├── browser/
│   ├── verification/
│   ├── memory/
│   ├── telemetry/
│   ├── policy/
│   ├── config/
│   └── ui/
├── prompts/
├── evaluations/
├── infrastructure/
├── docs/
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

Python is intentionally absent from the initial repository. Add an isolated Python service later only if a specific dependency or research workflow justifies it.

# 25. Initial Milestone Breakdown

## Milestone 1: Foundation

Deliver:

- Monorepo
- Local development environment
- PostgreSQL
- Temporal
- Object storage
- Basic authentication
- Organization model
- GitHub App installation flow
- Repository listing

## Milestone 2: Sandbox

Deliver:

- Sandbox provider interface
- Daytona implementation
- Local Docker implementation
- Repository clone
- Command execution
- Log streaming
- File access
- Sandbox cleanup

## Milestone 3: Agent

Deliver:

- Agent adapter interface
- First agent implementation
- Normalized event model
- Event persistence
- Live event streaming
- Budget and timeout controls

## Milestone 4: Session Product

Deliver:

- Create session
- Session detail page
- Activity timeline
- Terminal
- Changed files
- Pause/resume/cancel
- Session history

## Milestone 5: GitHub Output

Deliver:

- Branch creation
- Commit
- Draft pull request
- Pull-request description
- Check and review status
- PR link in session

## Milestone 6: Verification

Deliver:

- Test command discovery
- Required checks
- Evidence storage
- Reviewer agent
- Completion gate
- Exportable evidence package

## Milestone 7: Browser QA

Deliver:

- App launch
- Preview URL
- Playwright flow execution
- Screenshots
- Trace
- Console capture
- Evidence integration

## Milestone 8: Planning

Deliver:

- Context collector
- Plan schema
- Plan compiler
- Plan editor
- Approval
- Plan versioning

## Milestone 9: Multi-Agent Projects

Deliver:

- Task graph execution
- Child workflows
- Parallel builders
- Structured handoffs
- Integration agent
- Project command center

## Milestone 10: Memory and Evaluation

Deliver:

- Repository memory
- Organization memory
- Source citations
- Retrieval
- Benchmark suite
- Performance dashboards

---

# 26. Security Threat Model

Threats to consider:

- Malicious repository content
- Prompt injection in source files
- Dependency scripts executing arbitrary code
- Secret exfiltration
- Cross-tenant access
- Sandbox escape
- Unrestricted network access
- Git credential misuse
- Agent opening malicious pull requests
- Agent modifying CI to hide failures
- Log injection
- Artifact malware
- Model provider data retention
- Unauthorized memory access

Mitigations:

- Treat repository content as untrusted
- Separate system instructions from repository text
- Mark retrieved content as data, not instructions
- Use network allowlists
- Use short-lived scoped credentials
- Run secret scanning
- Isolate sandboxes
- Limit Linux capabilities
- Apply CPU, memory, storage, and time quotas
- Restrict Docker-in-Docker
- Require approval for high-risk actions
- Prevent agents from weakening required checks without approval
- Record immutable audit events
- Redact secrets from logs
- Encrypt artifacts
- Scan uploaded artifacts
- Enforce organization scope on every query

---

# 27. Failure Handling

Failure categories:

- Sandbox provisioning failure
- Repository setup failure
- Authentication failure
- Model failure
- Rate limit
- Tool failure
- Test failure
- Agent loop failure
- Budget exceeded
- Timeout
- Merge conflict
- Verification failure
- Human approval timeout
- Infrastructure failure

Each failure must include:

- Category
- Human-readable summary
- Technical details
- Retryability
- Recommended action
- Relevant logs
- Last checkpoint
- Cost incurred
- Whether user action is required

Retry policies:

- Infrastructure and provider failures: automatic bounded retries
- Identical agent failures: do not blindly retry
- Test failures: agent may revise within budget
- Authentication failures: require user action
- Budget exceeded: require approval
- Merge conflicts: integration workflow
- Verification failures: return to assigned builder or integration agent

---

# 28. Definition of Done for the MVP

The MVP is complete when a user can:

1. Sign in.
2. Connect GitHub.
3. Select a repository.
4. Enter a coding task.
5. Start a cloud session.
6. Watch agent progress.
7. Inspect terminal output.
8. Inspect changed files.
9. Pause and resume.
10. Take over the workspace.
11. Return control to the agent.
12. Run tests.
13. Receive a draft pull request.
14. Inspect evidence and known limitations.
15. Reopen the session later.
16. Retry from a checkpoint.

Operational requirements:

- State survives service restarts.
- Credentials are scoped and short-lived.
- Sandbox cleanup works.
- Cost is tracked.
- Every session has an audit trail.
- At least one representative repository setup is documented.
- At least ten benchmark tasks run reliably.

---

# 29. What Not to Build Initially

Do not initially build:

- Unlimited agent fan-out
- A proprietary foundation model
- A custom vector database
- A custom graph database
- A full custom Kubernetes sandbox platform
- Automatic merging
- Automatic production deployment
- Global memory shared across customers
- Complex reinforcement learning
- An agent marketplace
- Dozens of personas
- Automatic routing across every model
- Video generation before screenshots and traces are reliable
- Cross-repository projects before single-repository sessions are stable

The first priority is:

> Make one cloud agent easy to launch, observable, interruptible, persistent, secure, and trustworthy.

---

# 30. Key Architectural Decisions

## TypeScript end to end initially

Use TypeScript for the frontend, Route Handlers, schemas, Temporal workflows and activities, agent adapters, sandbox adapters, GitHub integration, verification, browser automation, and telemetry.

Introduce Python only when a specific capability cannot be accessed cleanly through a TypeScript SDK, HTTP API, ACP, MCP, or sandboxed CLI.

## Next.js is the initial product API

Route Handlers are sufficient for the initial APIs and webhooks. Keep them thin and place business logic in shared packages.

Extract Fastify later only when public APIs, multiple clients, high-volume streaming, or independent scaling require it.

## Temporal TypeScript workers run separately

Long-running work must not run inside Next.js requests. Temporal workers provide durable state, pause, resume, retries, timers, approvals, and recovery.

## Playwright is the browser foundation

Browser agents sit on top of Playwright for exploration. Deterministic Playwright tests are the completion gate and produce traces, screenshots, console logs, and network evidence.

## OpenTelemetry before Langfuse

OpenTelemetry covers the full system. Add Langfuse when prompt, model, retrieval, and evaluation experimentation becomes substantial.

Langfuse is an LLM observability and evaluation system, not product-state storage.

## Daytona before Kubernetes

Avoid rebuilding workspace persistence, snapshots, terminals, previews, browser access, networking, and cleanup. Preserve provider portability through an abstraction.

## PostgreSQL first

Product state, events, plans, task graphs, memory metadata, and read models fit PostgreSQL. JSONB and pgvector cover initial flexible and semantic requirements.

## Open agent adapter layer

No single coding agent should define the platform. Support Claude Code, Codex, OpenHands, and future ACP-compatible agents.

## Verification is first class

Independent review and reproducible evidence are required for trust and are a core product differentiator.

# 31. AI Agent Implementation Instructions

An AI coding agent using this document should:

1. Treat this specification as the primary source of truth.
2. Build in phases, starting with the single-agent MVP.
3. Preserve abstraction boundaries.
4. Avoid hard-coding Daytona, OpenHands, or a specific model into domain logic.
5. Use strict schemas for plans, events, evidence, and approvals.
6. Use the Temporal TypeScript SDK for long-running state.
7. Use PostgreSQL for application state and projections.
8. Store large artifacts in object storage.
9. Add automated tests for every service boundary.
10. Add integration tests for:
    - Session lifecycle
    - Sandbox lifecycle
    - Agent-event normalization
    - Pause and resume
    - Checkpoint and fork
    - Pull-request creation
    - Verification gates
11. Add structured logging and OpenTelemetry from the start.
12. Never expose secrets in logs, model prompts, or artifacts.
13. Document every external dependency and its license.
14. Prefer small, reviewable pull requests.
15. Keep the platform runnable locally with Docker Compose.

Recommended implementation order:

```text
Domain schemas
    ↓
Database migrations
    ↓
Temporal workflows
    ↓
Sandbox interface
    ↓
Local Docker sandbox
    ↓
Daytona sandbox
    ↓
Agent adapter interface
    ↓
One agent adapter
    ↓
Normalized events
    ↓
Session API
    ↓
Session UI
    ↓
GitHub pull request
    ↓
Verification
    ↓
Planning
    ↓
Multi-agent execution
```

---

# 32. Final Product Positioning

The product should be positioned as:

> A cloud operating system for autonomous software engineering.

It is not merely:

- A chat interface
- A code-completion tool
- A single coding agent
- A workflow automation product
- A hosted IDE

Its differentiated value is the combination of:

- Instant cloud workspaces
- Multiple interchangeable coding agents
- Durable project execution
- Dependency-aware planning
- Parallel specialized agents
- Independent verification
- Repository and organizational memory
- Human control
- Enterprise governance
- Evidence-backed pull requests

The best path to market is to begin with a polished, dependable single-agent cloud experience and then progressively add planning, verification, memory, and multi-agent execution.

The durable moat should come from:

- Better task decomposition
- Better orchestration decisions
- Better verification
- Better organizational context
- Better evaluation data
- Better human-agent interaction
- Better reliability and governance

Commodity infrastructure should be borrowed. Product intelligence and trust should be built.


---

# 33. Simplified Initial Stack

```text
Language:
TypeScript

Monorepo:
pnpm workspaces + Turborepo

Frontend and product API:
Next.js + React + Route Handlers

Durable execution:
Temporal TypeScript SDK

Database:
PostgreSQL + pgvector

Schemas:
Zod

ORM:
Drizzle, or Prisma if already standardized

Sandboxes:
Daytona + Local Docker

Agent execution:
TypeScript adapters around Claude Code, Codex, OpenHands, and ACP-compatible agents

Browser:
Playwright + Playwright MCP or browser-agent reasoning on top

Model access:
Direct provider SDKs initially; LiteLLM when centralized routing and budgets are needed

Observability:
OpenTelemetry from day one

LLM evaluation:
Langfuse later, when prompt and model experimentation becomes substantial

Artifacts:
S3-compatible object storage

Authentication:
Managed OIDC provider
```

This architecture minimizes languages and independently managed systems while preserving clean boundaries for future scale.
