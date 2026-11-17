# Autonomous Engineering Platform — Architecture and Infrastructure Cost Summary

**Last updated:** July 25, 2026  
**Currency:** USD  
**Scope:** Infrastructure and software hosting only. **LLM/API inference costs are excluded.**

---

## 1. What We Are Building

This platform combines:

- **Devin-style cloud sessions:** start an isolated cloud development environment, let an agent code, observe its work, take over the terminal/browser/editor, and receive a pull request.
- **Vorflux-style orchestration:** turn large goals into plans, execute multiple workstreams, use specialized agents, review the implementation independently, and require evidence before completion.

The platform is not one coding model. It is the operating system around coding agents:

```text
User request
    ↓
Next.js product
    ↓
Temporal workflow
    ↓
Planner / Builder / Reviewer / QA agents
    ↓
Daytona cloud sandbox
    ↓
GitHub + Playwright
    ↓
Verified pull request
```

---

## 2. Simplified Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Next.js Application                                        │
│ React UI · Route Handlers · Auth · Webhooks · Live Views   │
└────────────────────────────┬────────────────────────────────┘
                             │
                    PostgreSQL + pgvector
                             │
                      Temporal Client
                             │
┌────────────────────────────▼────────────────────────────────┐
│ Temporal TypeScript Worker                                 │
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

---

## 3. Tools and What Each One Does

| Tool | Role in the architecture | Initial recommendation |
|---|---|---|
| **Next.js + React** | Product UI, APIs, webhooks, authentication flows, command center, project/session pages | Use from day one |
| **TypeScript** | Shared language for UI, APIs, Temporal workers, adapters, schemas, and browser automation | Use everywhere initially |
| **Temporal** | Durable, long-running workflows; pause/resume, retries, approvals, scheduling, recovery | Use from day one |
| **PostgreSQL** | Sessions, projects, plans, events, approvals, task graphs, read models | Use from day one |
| **pgvector** | Semantic retrieval for repository and organizational memory | Use inside Postgres initially |
| **Daytona** | Isolated cloud sandboxes where coding agents run | Use for cloud execution |
| **Local Docker** | Local development, CI, and lower-cost local execution | Use from day one |
| **Playwright** | Deterministic browser testing, screenshots, traces, console and network evidence | Use for verification |
| **Browser agent / Playwright MCP** | Explores unknown UI flows and generates reusable Playwright tests | Add after basic Playwright |
| **GitHub App** | Scoped repository access, branches, commits, pull requests, checks, and reviews | Use from day one |
| **S3-compatible storage** | Logs, screenshots, traces, videos, diffs, and evidence artifacts | Use from day one |
| **OpenTelemetry** | End-to-end tracing and metrics across APIs, workers, sandboxes, models, and browser runs | Use from day one |
| **Langfuse** | Prompt/model tracing, experiments, datasets, and agent-quality evaluation | Add later |
| **LiteLLM** | Central model gateway, routing, fallback, budgets, and provider abstraction | Add when multi-provider complexity requires it |
| **Redis** | Optional short-lived caching, rate limits, and ephemeral coordination | Avoid until needed |
| **Managed OIDC provider** | Login, organizations, roles, SSO foundation | Use managed service initially |
| **pnpm + Turborepo** | TypeScript monorepo and shared package management | Use from day one |

---

## 4. Cost Assumptions

The estimates below assume:

- One production environment
- One development or staging environment where noted
- Managed services where practical
- No enterprise support contracts
- No LLM inference charges
- No engineer salaries or implementation labor
- Sandboxes are paused or stopped when idle
- Typical agent sandbox: approximately **4 vCPU and 8 GB RAM**
- Typical engineer usage: **40 active sandbox hours per month**
- Heavy engineer usage: **160 active sandbox hours per month**

Actual pricing changes by provider, region, workload, retention, and contract.

---

## 5. Cost by Component

### 5.1 Next.js Application

**Purpose**

- React UI
- Route Handlers
- Authentication callbacks
- GitHub webhooks
- Workflow initiation
- Live session views

**Hosting options**

- Vercel
- Fly.io
- Railway
- Render
- AWS ECS/Fargate
- Google Cloud Run

**Estimated monthly cost**

| Stage | Estimated cost |
|---|---:|
| Local prototype | $0 |
| Hosted prototype | $20–$50 |
| Small production team | $50–$150 |
| Growing platform | $200–$1,000+ |

Vercel Pro includes a monthly usage credit and then charges for additional consumption. A container platform may be easier if the Next.js application needs persistent streaming connections.

**Budget recommendation:** **$50/month initially**

---

### 5.2 Temporal

**Purpose**

- Durable project and session workflows
- Retries and recovery
- Pause and resume
- Human approval waits
- Parallel workstreams
- Scheduling

**Options**

1. **Temporal Cloud**
2. **Self-hosted Temporal**

Temporal Cloud Essentials currently starts at approximately **$100/month**, with included actions and storage; additional actions and storage are usage-based.

| Option | Estimated monthly cost |
|---|---:|
| Local Temporal development server | $0 |
| Temporal Cloud Essentials | $100+ |
| Small self-hosted deployment | $50–$200 |
| Larger managed usage | $200–$1,000+ |

Self-hosting can reduce the direct bill but adds operational work, upgrades, backups, and incident ownership.

**Budget recommendation:** **$100/month for Temporal Cloud**

---

### 5.3 PostgreSQL + pgvector

**Purpose**

- Product data
- Sessions and projects
- Plans and tasks
- Events and approvals
- Memory metadata and embeddings
- Dashboard queries

**Options**

- Neon
- Supabase
- AWS RDS
- Google Cloud SQL
- Crunchy Bridge
- Self-hosted PostgreSQL

Neon supports usage-based serverless Postgres, autoscaling, scale-to-zero, connection pooling, and pgvector.

| Stage | Estimated monthly cost |
|---|---:|
| Local development | $0 |
| Prototype | $0–$30 |
| Small production team | $30–$100 |
| Growing platform | $150–$500+ |

Event volume and retention will matter more than normal transactional data.

**Budget recommendation:** **$50/month initially**

---

### 5.4 Daytona Sandboxes

**Purpose**

Every active agent receives an isolated development computer with:

- CPU and RAM
- Filesystem
- Git
- Terminal
- Browser
- Preview ports
- Snapshots
- Repository dependencies

Daytona uses pay-as-you-go pricing based on reserved vCPU, RAM, and disk. Started sandboxes are billed for CPU, memory, and disk. Stopped or paused sandboxes are billed for disk only. Archived or deleted sandboxes are not billed, excluding retained snapshots.

Because public rates and machine choices can change, use a planning estimate of:

> **$0.10–$0.25 per active sandbox hour** for a typical coding environment.

This is an estimate, not a quoted Daytona rate.

#### Per-engineer sandbox cost

| Usage pattern | Active hours/month | Estimated monthly cost |
|---|---:|---:|
| Light | 20 | $2–$5 |
| Typical | 40 | $4–$10 |
| Heavy | 160 | $16–$40 |
| Always running | 730 | $73–$183 |

Allow additional budget for:

- Persistent disks
- Snapshots
- Idle transition time
- Larger builds
- Multiple simultaneous agents
- Browser and Docker workloads

A safe planning budget is:

- **Typical engineer:** $10–$25/month
- **Heavy agent user:** $30–$75/month
- **Multi-agent project:** multiply by the number of simultaneously active sandboxes

#### Example

A project running four agents in parallel for three hours:

```text
4 agents × 3 hours × $0.10–$0.25
= $1.20–$3.00 of sandbox compute
```

**Budget recommendation:** **$20 per active engineer per month initially**

---

### 5.5 Local Docker

**Purpose**

- Local development
- CI tests
- Optional local agent mode
- Lower-cost alternative to cloud sandboxes

**Estimated direct hosting cost:** **$0**

The cost is absorbed by the developer machine or CI runner. Local execution is useful for quick tasks, while Daytona is better for long-running, shared, or parallel work.

---

### 5.6 Playwright

**Purpose**

- Browser automation
- Functional UI verification
- Screenshots
- Traces
- Console errors
- Network failures
- Cross-browser tests

**Software license cost:** **$0**

Playwright runs inside the existing sandbox or CI environment, so its cost is primarily extra sandbox runtime and artifact storage.

Typical incremental infrastructure cost:

- Short UI test: usually negligible
- Large browser test suite: additional compute minutes
- Video and traces: additional storage

**Budget recommendation:** included in sandbox cost

---

### 5.7 Browser Agent or Playwright MCP

**Purpose**

- Explore an unfamiliar UI
- Decide which actions to take
- Investigate bugs
- Generate deterministic Playwright tests

**Software/infrastructure cost**

- Playwright MCP itself can be self-hosted with no separate software charge.
- Browser execution runs inside the sandbox.
- The excluded LLM cost is usually the largest browser-agent cost.

**Budget recommendation:** included in sandbox cost, excluding LLM usage

---

### 5.8 GitHub App

**Purpose**

- Scoped repository authentication
- Clone repositories
- Create branches and commits
- Open draft pull requests
- Read checks and review comments

**Platform integration cost:** generally **$0**

GitHub organization or enterprise subscription costs are separate and are assumed to already exist.

**Budget recommendation:** $0 incremental infrastructure cost

---

### 5.9 S3-Compatible Object Storage

**Purpose**

- Screenshots
- Playwright traces
- Videos
- Logs
- Diffs
- Evidence exports
- Agent artifacts

**Estimated monthly cost**

| Usage | Estimated monthly cost |
|---|---:|
| Prototype, under 50 GB | $1–$5 |
| Small team, 100–500 GB | $5–$25 |
| Larger platform, 1–5 TB | $25–$150+ |

Data egress and request charges may add cost. Use lifecycle policies to delete or archive old traces and videos.

**Budget recommendation:** **$10/month initially**

---

### 5.10 OpenTelemetry Backend

OpenTelemetry libraries are open source and free. You still need somewhere to store and query traces and metrics.

**Options**

- Grafana Cloud
- Honeycomb
- Datadog
- New Relic
- Self-hosted Grafana, Tempo, Prometheus, and Loki

| Stage | Estimated monthly cost |
|---|---:|
| Local/self-hosted development | $0 |
| Managed prototype | $0–$50 |
| Small production team | $50–$200 |
| High-volume telemetry | $500+ |

Agent command output can generate enormous telemetry volumes. Do not store all terminal output as tracing attributes. Store large logs as artifacts and keep references in traces.

**Budget recommendation:** **$25–$75/month initially**

---

### 5.11 Langfuse

**Purpose**

- Model and prompt traces
- Prompt version comparisons
- Evaluation datasets
- Experiments
- Human feedback
- Model and agent quality analysis

Langfuse is not required for the first MVP. OpenTelemetry plus PostgreSQL can handle basic model invocation tracking.

| Option | Estimated monthly cost |
|---|---:|
| Not used during MVP | $0 |
| Self-hosted small deployment | $20–$100 |
| Managed service | Depends on current plan and usage |
| Larger evaluation workloads | $100–$500+ |

**Budget recommendation:** **$0 for Phase 1; add later**

---

### 5.12 LiteLLM

**Purpose**

- One interface for multiple model providers
- Fallback
- Rate limiting
- Budget controls
- Usage accounting
- Customer-specific policies

LiteLLM is open source. A self-hosted proxy needs a small application instance and database access.

| Stage | Estimated monthly cost |
|---|---:|
| Direct SDKs, no LiteLLM | $0 |
| Small self-hosted proxy | $10–$50 |
| Highly available proxy | $100–$300+ |

**Budget recommendation:** **$0 initially; direct SDKs first**

---

### 5.13 Redis

**Purpose**

Potential uses:

- Rate limiting
- Ephemeral cache
- Presence
- Short-lived coordination

Temporal and PostgreSQL already cover most durable needs. Avoid Redis until there is a demonstrated requirement.

| Stage | Estimated monthly cost |
|---|---:|
| Not used initially | $0 |
| Small managed instance | $10–$30 |
| Larger managed use | $50–$200+ |

**Budget recommendation:** **$0 initially**

---

### 5.14 Authentication Provider

**Purpose**

- Login
- Organizations
- Roles
- OIDC
- Future SSO and SCIM

Options include WorkOS, Auth0, Clerk, or an existing company identity provider.

| Stage | Estimated monthly cost |
|---|---:|
| Prototype/free tier | $0 |
| Small production team | $0–$100 |
| Enterprise SSO/SCIM | $100–$1,000+ |

**Budget recommendation:** **$0–$50/month initially**

---

### 5.15 Domain, DNS, Email, and Miscellaneous

| Item | Estimated monthly cost |
|---|---:|
| Domain | Approximately $1–$3 when annualized |
| DNS | $0–$10 |
| Transactional email | $0–$20 |
| Secrets manager | $0–$30 |
| Error tracking | $0–$50 |
| Backups | $5–$50 |

**Budget recommendation:** **$25/month initially**

---

## 6. Monthly Budget Scenarios

### Scenario A — Local Development

One engineer building the prototype locally.

| Component | Monthly |
|---|---:|
| Next.js local | $0 |
| Temporal local | $0 |
| PostgreSQL local | $0 |
| Docker sandboxes | $0 |
| Playwright | $0 |
| GitHub App | $0 |
| Optional hosted storage/services | $0–$25 |
| **Total** | **$0–$25/month** |

This excludes the engineer’s laptop and LLM costs.

---

### Scenario B — Hosted Prototype

One to five engineers, occasional cloud sessions.

| Component | Monthly |
|---|---:|
| Next.js hosting | $20–$50 |
| Temporal Cloud | $100 |
| PostgreSQL | $0–$50 |
| Sandboxes | $25–$100 |
| Object storage | $5–$10 |
| Telemetry | $0–$50 |
| Authentication and miscellaneous | $0–$50 |
| **Total** | **Approximately $150–$410/month** |

A reasonable planning figure is:

> **$250–$350/month**, excluding LLM costs.

---

### Scenario C — Small Production Team

Approximately 20 active engineers.

Assumptions:

- 40 active sandbox hours per engineer per month
- Sandboxes budgeted at $20 per engineer to include idle and storage overhead
- Managed Temporal and Postgres
- Basic production observability

| Component | Monthly |
|---|---:|
| Next.js application | $75 |
| Temporal Cloud | $100–$200 |
| PostgreSQL | $50–$100 |
| Sandboxes | $400 |
| Object storage | $10–$25 |
| Telemetry | $50–$150 |
| Authentication and miscellaneous | $25–$100 |
| **Total** | **Approximately $710–$1,050/month** |

Planning figure:

> **Approximately $35–$55 per active engineer per month**, excluding LLM costs.

This includes shared control-plane costs, which become cheaper per engineer as usage grows.

---

### Scenario D — 100 Active Engineers

Assumptions:

- Typical sandbox usage
- Some parallel agents
- Managed production services
- Better monitoring and retention

| Component | Monthly |
|---|---:|
| Application and workers | $200–$500 |
| Temporal | $200–$500 |
| PostgreSQL | $150–$400 |
| Sandboxes | $2,000–$4,000 |
| Object storage | $25–$100 |
| Telemetry | $200–$750 |
| Authentication and miscellaneous | $100–$500 |
| **Total** | **Approximately $2,875–$6,750/month** |

Planning figure:

> **Approximately $30–$70 per active engineer per month**, excluding LLM costs.

The wide range is driven mostly by sandbox size, session duration, concurrency, telemetry retention, and multi-agent fan-out.

---

## 7. What Drives Cost

### Primary cost driver: active sandboxes

The biggest variable is:

```text
Active agents
× sandbox size
× active duration
× number of parallel workstreams
```

A four-agent project can consume roughly four times the sandbox compute of a single-agent task.

### Secondary cost drivers

- Telemetry volume
- Event retention
- Playwright videos and traces
- Database event history
- Persistent sandbox disk
- Snapshots
- Idle sandbox duration
- Development and staging duplication

### Relatively small costs

- Next.js application
- GitHub App
- Playwright software
- pgvector
- Object storage at early scale

---

## 8. Cost-Control Mechanisms to Build Early

### Sandbox lifecycle policy

```text
Active
  ↓
Idle for 5–15 minutes
  ↓
Checkpoint and pause
  ↓
Disk-only billing
  ↓
Archive or delete after retention window
```

Required controls:

- Idle timeout
- Maximum session duration
- Maximum project duration
- CPU and RAM limits
- Organization concurrency limits
- Per-project budgets
- Automatic pause
- Snapshot cleanup
- Artifact lifecycle policies
- Alert before budget exhaustion

### Multi-agent limits

Start with no more than three concurrent builder agents per project.

Only expand fan-out when evaluation shows that parallelism improves completion enough to justify additional cost and merge complexity.

### Telemetry limits

- Sample high-volume traces
- Store terminal logs in object storage
- Do not attach full command output to every span
- Set retention periods
- Compress artifacts
- Disable video unless useful

### Local-first option

Offer:

- Local Docker for quick tasks
- Daytona for shared, parallel, long-running, or secure cloud tasks

This can materially reduce infrastructure cost.

---

## 9. Recommended Initial Budget

For the first hosted MVP:

| Category | Budget |
|---|---:|
| Shared control plane | $200–$300/month |
| Sandboxes | $20 per active engineer/month |
| Contingency | 20–30% |
| LLM costs | Excluded |

For a five-person engineering pilot:

```text
Shared services:        $250
Sandbox usage:          $100
Contingency:             $75
--------------------------------
Estimated infrastructure: $425/month
```

A practical budget is:

> **$300–$500/month for an early hosted pilot**, excluding LLM costs and engineering labor.

For a reliable 20-engineer production pilot:

> **Budget approximately $750–$1,250/month**, excluding LLM costs.

---

## 10. Build-vs-Managed Cost Recommendation

### Use managed initially

- Temporal Cloud
- Managed PostgreSQL
- Managed authentication
- Managed object storage
- Daytona

The direct bill may be somewhat higher, but operational complexity is much lower.

### Self-host later when justified

Consider self-hosting only when:

- Managed-service cost becomes material
- Compliance requires it
- Private networking requires it
- Usage is predictable enough to optimize
- The team can own upgrades, backups, scaling, and incidents

Do not self-host Temporal, Postgres, sandbox orchestration, observability, and identity simultaneously during the MVP.

---

## 11. Key Conclusion

The platform does not require a large infrastructure budget to start.

- A local prototype can run for nearly **$0/month**.
- A useful hosted MVP can run for approximately **$300–$500/month**.
- A 20-engineer production pilot may cost approximately **$750–$1,250/month**.
- At scale, sandbox compute becomes the dominant infrastructure expense.
- Pausing idle sandboxes and limiting multi-agent fan-out are the highest-impact cost controls.

These estimates exclude:

- LLM inference
- Engineering labor
- Existing GitHub subscriptions
- Enterprise contracts
- Compliance audits
- Customer support tooling

---

## 12. Pricing References

Pricing changes over time. Verify current rates before making a purchasing decision.

- Daytona pricing: https://www.daytona.io/pricing
- Daytona billing model: https://www.daytona.io/docs/en/billing/
- Temporal pricing: https://temporal.io/pricing
- Temporal Cloud pricing documentation: https://docs.temporal.io/cloud/pricing
- Neon pricing: https://neon.com/pricing
- Vercel pricing: https://vercel.com/pricing
