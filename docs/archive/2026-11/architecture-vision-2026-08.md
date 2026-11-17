# Windkeel High-Level Architecture

## Product Definition

Windkeel is a **full autonomous software engineering factory with independent verification built in**.

It should compete with products like Devin and other software factories on the complete workflow:

**task intake → planning → implementation → debugging → verification → repair → PR → human review**

Its primary differentiation is that the same system that performs the work is **not trusted to verify its own result**. Windkeel introduces an explicit trust boundary, independent checking, evidence, provenance, and policy-driven merge readiness.

---

## High-Level Architecture

```text
GitHub / Jira / Linear / Slack / Cron / API
                    ↓
              WINDKEEL FACTORY
        task intake • planning • routing
                    ↓
             Agent / Model Router
    Codex • Claude Code • OpenHands • OpenCode
                    ↓
              Sandbox Layer
       Vercel first • Cloudflare later
                    ↓
          Implementation / Debugging
                    ↓
           Candidate Software Change
                    │
           ═══ TRUST BOUNDARY ═══
                    │
          WINDKEEL VERIFICATION ENGINE
     tests • security • browser QA • intent
      independent review • policy • evidence
                    ↓
               PASS / FAIL
                 ↙     ↘
              repair    PR ready
                 ↓
              re-verify
                    ↓
               Human Review
                    ↓
             Merge / Reject / Revise
```

---

## Core Product Responsibilities

Windkeel should own:

- Engineering task lifecycle
- Requirement and acceptance-criteria extraction
- Planning and decomposition
- Risk classification
- Agent selection
- Model selection and routing policy
- Repair and retry strategy
- Independent verification
- Maker/checker separation
- Evidence generation
- Provenance and integrity
- Merge-readiness policy
- Repository and organization knowledge
- Agent/model performance intelligence
- Cost and reliability optimization

Windkeel should reuse commodity infrastructure where practical:

- Model SDKs and gateways
- Durable workflow engines
- Sandboxes
- Coding-agent runtimes
- Managed databases
- Object storage
- OAuth/integration primitives
- Queueing and infrastructure telemetry

---

## Recommended Tech Stack

### Product / UI
- Next.js
- TypeScript
- Vercel

### Orchestration
- Windkeel-owned task/run model
- eve / Vercel Workflow behind Windkeel abstractions
- Durable retries, waits, approvals, schedules, and resumability

### Model Layer
- Vercel AI SDK
- OpenRouter
- Direct OpenAI / Anthropic / other provider support
- BYO API keys
- BYO OpenAI-compatible endpoint
- Self-hosted/open-weight models

### Coding Workers
Behind a common `WorkerAdapter`:

- Codex
- Claude Code
- OpenHands
- OpenCode
- Future agents

### Sandboxes
Behind a common `SandboxProvider`:

1. Vercel Sandbox initially
2. Cloudflare Sandbox as second backend
3. Self-hosted Docker/Kubernetes/VM providers later

### Persistence
- PostgreSQL / Supabase for durable product state
- Object storage for evidence, traces, screenshots, logs, and artifacts
- Optional Redis/Valkey for ephemeral coordination only

### Integrations
- GitHub App first
- Linear
- Jira
- Slack
- Cron / API triggers

### Verification
Reuse and evolve the current Windkeel verification engine:

- Repository checks
- Independent AI review
- Acceptance-criteria mapping
- Security verification
- Browser QA
- Deterministic verdict
- Evidence packages
- Artifact hashing
- Signed provenance

---

## End-to-End Workflow

```text
1. Human creates issue / prompt / request
2. Windkeel classifies task and risk
3. Windkeel derives acceptance criteria
4. Planner builds implementation plan
5. Router selects coding worker + model
6. Sandbox is provisioned
7. Worker implements and tests
8. Candidate change crosses trust boundary
9. Independent Windkeel verifier checks result
10. If FAIL:
      - create structured repair packet
      - return to worker
      - repair
      - re-verify
11. If PASS:
      - create draft PR
      - attach compact evidence summary
12. Human reviews
13. Human merges, rejects, or requests changes
```

---

## Human Review Model

Humans should not need to replay every agent action.

The human review surface should summarize:

```text
Acceptance criteria      5/5 passed
Tests                    passed
Security                 passed
Independent review       passed
Browser verification     passed
Repair attempts           1
Residual risks            1 medium
Overall verdict           PASS
```

The reviewer can then inspect:

- Code diff
- Requirement-to-evidence mapping
- Any failed/repaired checks
- Risk flags
- Verification artifacts
- Agent/model provenance
- Cost and execution summary

Humans remain the final authority for merge decisions unless an organization explicitly enables a stricter automated policy.

---

## Core Design Principle

Windkeel should feel like **one complete autonomous software engineer**, even though it may reuse multiple open-source and managed systems internally.

The durable product boundary is:

> **Windkeel performs the engineering work, independently proves that the work is correct enough, repairs failures, and presents humans with a verified merge-ready result.**
