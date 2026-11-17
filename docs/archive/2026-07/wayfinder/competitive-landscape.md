# Competitive & Open-Source Landscape: Cloud Autonomous Coding (mid-2026)

**Ticket:** jyothepro/windkeel#4 · **Researched:** 2026-07-25 · **Sources:** product sites, pricing pages, docs, GitHub, trade press (high-trust web sources; AFK research)

---

## 1. Commercial landscape

### Devin (Cognition)
- **Capabilities:** The original "AI software engineer." Plans, executes, debugs, deploys, monitors; cloud-hosted sessions with its own VM, browser, editor. Devin 2.0 (April 2025) claims 83% more junior-dev tasks completed per ACU vs 1.x. Now available as cloud SaaS, Enterprise VPC deployment, and a CLI for local orchestration. Cognition also acquired Windsurf (2025), giving it an IDE surface.
- **Pricing:** Core $20/mo entry with pay-as-you-go ACUs at ~$2.25/ACU (1 ACU ≈ 15 min of active work); Team $500/mo (250 ACUs, extra at $2); Enterprise custom (VPC, SSO, teamspace isolation).
- **Positioning:** Premium autonomous engineer for delegation of whole tasks; increasingly enterprise-focused. Entirely closed source.
- Sources: [VentureBeat on Devin 2.0 pricing](https://venturebeat.com/programming-development/devin-2-0-is-here-cognition-slashes-price-of-ai-software-engineer-to-20-per-month-from-500), [Lindy Devin pricing breakdown](https://www.lindy.ai/blog/devin-pricing), [eesel on Cognition pricing](https://www.eesel.ai/blog/cognition-ai-pricing)

### Cursor Cloud/Background Agents (Anysphere)
- **Capabilities:** Background agents run tasks off your machine; cloud agents (Pro and up) with multi-repo support, Dockerfile-based environments with layer caching, environment version history/rollback, scoped secrets, Slack/Teams integration (May 2026 changelog). Tight IDE handoff is the differentiator: kick off in cloud, pull down into the editor.
- **Pricing:** Pro $20/mo (cloud agents included; a single large-codebase agent run can eat ~20%+ of the monthly credit pool), Pro+ $60, Ultra $200; credit/usage-based.
- **Positioning:** IDE-first company extending into cloud delegation; agents are an extension of the editor workflow, not an autonomous platform. Closed source.
- Sources: [Cursor cloud agents guide](https://www.buildfastwithai.com/blogs/cursor-cloud-agents-development-environments-2026), [CloudZero on Cursor pricing](https://www.cloudzero.com/blog/cursor-ai-pricing/)

### OpenAI Codex (cloud)
- **Capabilities:** Cloud-based autonomous agent (launched May 2025) on GPT-5-Codex; >70% SWE-bench Verified. Surfaces: web (ChatGPT), VS Code extension (~9.8M installs), CLI, iOS, and Amazon Bedrock (June 2026). Parallel task fan-out in cloud sandboxes; PRs back to GitHub.
- **Pricing:** Free / Go $8 / Plus $20 / Pro $100 (5x) / Pro $200 (20x); Business $20–25/user/mo. April 2026: switched from per-message metering to API-token-aligned credits on a rolling 5-hour window.
- **Positioning:** Volume play bundled into ChatGPT subscriptions; cheapest path to "assign a task, get a PR." Closed source (the Codex CLI itself is open source, but the cloud product is not).
- Sources: [eesel Codex pricing](https://www.eesel.ai/blog/codex-pricing), [UI Bakery Codex pricing](https://uibakery.io/blog/openai-codex-pricing)

### GitHub Copilot coding agent (Microsoft)
- **Capabilities:** Assign a GitHub issue to Copilot; it works in an Actions-powered cloud sandbox, writes code, runs tests, opens a PR. As of March 2026 the agent also runs in VS Code and JetBrains. Copilot code review is a separate paid feature (13x request multiplier). Only user prompts count against quota; autonomous tool calls don't.
- **Pricing:** Free / Pro $10 / Pro+ $39 / Max $100 / Business $19/seat. June 1, 2026: moved from Premium Request Units to per-token "GitHub AI Credits" (Pro includes $15 credits, Pro+ $70, Max $200).
- **Positioning:** Distribution king — the default agent for anyone already on GitHub. Deeply integrated with issues/PRs/Actions but shallow orchestration (one agent, one issue, one PR). Closed source.
- Sources: [GitHub premium requests docs](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests), [unerr on Copilot billing](https://www.unerr.dev/blog/github-copilot-pricing-explained), [NxCode Copilot guide](https://www.nxcode.io/resources/news/github-copilot-complete-guide-2026-features-pricing-agents)

### Factory (Droids)
- **Capabilities:** "Droids" cover the full SDLC — code, tests, PR review, docs, deployment; strong model-routing story (spend tokens wisely across models). CLI + cloud. Used at Nvidia, Adobe, Bayer, EY, MongoDB, Zapier.
- **Pricing:** Pro $20 / Plus $100 / Max $200; Teams and Enterprise custom (SSO/SCIM, audit logging, dedicated compute, on-prem). Raised $150M Series C at $1.5B (April 16, 2026).
- **Positioning:** Enterprise-grade agent platform; closest commercial analog to "org of agents" thinking. Closed source.
- Sources: [Factory Series C coverage](https://www.idlen.io/news/factory-ai-150-million-1-5-billion-droids-coding-agents-enterprise-april-2026/), [Coda One Factory review](https://www.codaone.ai/tools/factory-ai/)

### OpenHands / OpenHands Cloud (All Hands AI)
- **Capabilities:** The leading open-source (MIT) autonomous coding agent (~70K stars): sandboxed Docker execution, GUI/TUI/CLI, git integrations, model-agnostic, resolves GitHub issues end-to-end (~68% SWE-bench Verified with Claude Opus 4.6). 2026 additions: **sub-agent delegation via TaskToolSet**, and a **"Verification Stack"** — an agent-level *critic model* that scores runs and can stop/retry before a human sees them (runs in OpenHands Cloud / Agent Canvas), plus repo-level *code review* and *QA agents* (plugins in the OpenHands Extensions repo, deployable via GitHub Actions or Cloud Automations). The QA agent posts **a structured QA report as a PR review with evidence (commands, outputs, screenshots) and a verdict**.
- **Pricing:** OSS free; Cloud free tier with BYOK/at-cost model usage; Enterprise custom. Also ships an SDK positioned as a composable foundation for production agents (arXiv:2511.03690).
- **Positioning:** The open-source Devin. Its commercial layer (Cloud, critic model, org-wide automations) is where the managed convenience and the trained critic live.
- Sources: [OpenHands verification stack](https://www.openhands.dev/blog/20260506-the-verification-stack), [OpenHands May 2026 product update](https://www.openhands.dev/blog/openhands-product-update---may-2026), [OpenHands OSS agents roundup](https://www.openhands.dev/blog/open-source-ai-coding-agents), [OpenHands SDK paper](https://arxiv.org/pdf/2511.03690)

### Claude Code + cloud sessions (Anthropic)
- **Capabilities:** Terminal-first agent that grew a fleet layer: `claude agents` dashboard dispatching/monitoring background sessions; **remote cloud sessions (beta)** with state synced to your Claude account (close the laptop, work continues; scheduled server-side runs); subagents (YAML-defined) and **agent teams** that message each other; web + mobile surfaces (Cowork). Managed Agents announced at Code with Claude 2026.
- **Pricing:** Bundled with Claude subscriptions (Pro/Max tiers) or API usage.
- **Positioning:** The power-user default; the harness is everywhere but the orchestration/verification layer is DIY. Closed source.
- Sources: [CloudZero on Claude Code agents](https://www.cloudzero.com/blog/claude-code-agents/), [InfoQ on Code with Claude 2026](https://www.infoq.com/news/2026/05/code-with-claude/), [Claude Code changelog W28 2026](https://code.claude.com/docs/en/whats-new/2026-w28)

### Google Jules
- **Capabilities:** Async cloud agent: clones repo into a secure VM, plans, makes multi-file changes, opens a PR. GA at Google I/O 2026 (May 19).
- **Pricing:** Free (15 tasks/day, 3 concurrent); Google AI Pro $19.99 (100/day, 15 concurrent); Ultra $124.99 (300/day, 60 concurrent).
- **Positioning:** Commodity async task-runner bundled into Google AI subscriptions. Closed source.
- Sources: [Jules](https://jules.google/), [Google blog on Jules](https://blog.google/innovation-and-ai/models-and-research/google-labs/jules/), [Morph Jules explainer](https://www.morphllm.com/comparisons/jules-google-coding-agent)

### Others of note
- **Amp (Sourcegraph, ex-Cody):** agentic coding for big enterprise monorepos; leans on Sourcegraph code graph for codebases larger than any context window. Closed source. ([Sourcegraph agentic coding guide](https://sourcegraph.com/blog/agentic-coding))
- **Zencoder, Augment Code:** IDE-centric agents with whole-repo context engines ("Repo Grokking"); enterprise SDLC pitch. Closed source. ([Zencoder](https://zencoder.ai/blog/cody-ai-alternatives))
- **AI code review lane (adjacent, converging):** CodeRabbit ($24/dev/mo), Greptile ($30/dev/mo, semantic codebase graph, free tier since June 24, 2026), Qodo Merge ($19/seat, built on open-source **PR-Agent**, ~8.5K stars, self-hostable free). These are *reviewers of human+AI PRs*, not verifiers coupled to an agent execution platform. ([Greptile comparison](https://www.greptile.com/content-library/best-ai-code-review-tools), [Surmado alternatives](https://www.surmado.com/blog/best-coderabbit-alternatives-2026))

## 2. Open-source landscape

**Autonomous agents / harnesses (strong):** OpenHands (MIT), Aider (Apache-2.0, 6.8M+ PyPI installs, clean per-change git commits), Cline, Roo Code, Kilo Code, OpenCode, Goose (Block, MIT), SWE-agent/mini-swe-agent (research-grade), Codex CLI. All model-agnostic/BYOK; many support local models. This layer is **saturated** — an OSS "agent that codes" is a solved commodity. ([SSOJet self-hosted roundup](https://ssojet.com/blog/open-source-ai-coding-agents), [openalternative Devin list](https://openalternative.co/alternatives/devin))

**Multi-agent orchestrators (fragmented, mostly thin):** ~9 notable OSS orchestrators, nearly all converging on git-worktree parallelism with varying coordination depth: **Vibe Kanban** (Apache-2.0; company Bloop shut down April 10, 2026 — now community-maintained, cloud product sunset), **Claude Squad**, **claude-flow** (swarm workflows), Conductor, and **Gastown** (Steve Yegge, MIT, v1.0 in 2026) — the deepest: a "mayor" agent supervising 20–30 mixed agents (Claude Code/Copilot/Codex/Gemini) with coder/reviewer/supervisor roles, built on the **Beads** dependency-aware issue ledger; cloud hosting via a partnership with Kilo, not as OSS. ([Augment orchestrator survey](https://www.augmentcode.com/tools/open-source-agent-orchestrators), [New Stack on Gas Town cloud](https://thenewstack.io/steve-yegges-ai-agent-orchestration-project-gas-town-comes-to-the-cloud-and-brings-the-wasteland-with-it/), [Vibe Kanban status](https://alternativeto.net/software/vibe-kanban/about))

**Verification (nascent):** PR-Agent (open source) reviews diffs. OpenHands' repo-level review/QA plugins are in its Extensions repo, but the trained **critic model gates runs only in OpenHands Cloud**, and reports land as PR comments. No OSS project treats verification as a first-class, adversarial, independent stage of an orchestration pipeline.

**Evidence/provenance (essentially empty):** Regulatory pull is real and imminent — EU AI Act high-risk obligations hit **August 2, 2026**; auditors are starting to ask for AI-code audit trails, AIBOMs, and in-toto/SLSA-style attestations; NIST 2026 concept work calls for agent identity, binding to human intent, tamper-evident logs, non-repudiation. The most commonly cited compliance gap: *git history shows the human who committed, not the agent that wrote it*. No open-source tool today packages agent work into a portable, signed, audit-grade evidence artifact. ([Codacy on 2026 audits](https://blog.codacy.com/what-auditors-will-ask-about-ai-generated-code-in-2026), [CodeSlick on EU AI Act audit trails](https://codeslick.dev/blog/eu-ai-act-audit-trail-2026), [Zylos on signed agent provenance](https://zylos.ai/research/2026-04-25-agent-identity-provenance-signed-audit-trails/))

## 3. Gap analysis: Windkeel's four pillars vs. open source

| Windkeel pillar | Best OSS alternative today | Gap strength |
|---|---|---|
| **Instant cloud sessions** | OpenHands (self-host Docker sandboxes); Codex CLI/Claude Code are harnesses but their cloud layers are proprietary | **Weak-to-moderate gap.** OpenHands covers "agent in a sandbox"; what's missing in OSS is the *instant, managed, resumable session fabric* (warm pools, snapshot/resume, scheduled server-side runs) — everyone's cloud layer (Devin, Codex, Cursor, Claude, Jules, OpenHands Cloud) is closed or commercial. |
| **Dependency-aware multi-agent orchestration** | Gastown + Beads (dependency-aware ledger, reviewer roles); Vibe Kanban (worktree parallelism, now orphaned) | **Moderate gap.** Gastown is real prior art and closest to Windkeel here — but it's local-first, personality-heavy, terminal-native, and its cloud story is a commercial Kilo partnership. No OSS orchestrator combines a task DAG with *hosted* execution and a verification gate per node. |
| **Independent verification / review** | PR-Agent (diff review); OpenHands verification stack (critic in Cloud only; review/QA plugins OSS-ish) | **Strong gap.** Nothing OSS enforces *independence*: a verifier with a different model/vendor, no shared conversation state, adversarial posture, run as a mandatory pipeline stage that can block the DAG. OpenHands is the only one even pointing this direction, and its gating critic is a cloud feature. |
| **Evidence packages** | None. OpenHands QA posts evidence *as a PR comment*; commercial review tools produce dashboards | **Very strong gap — effectively unfilled.** No OSS (or commercial) product emits a portable, self-contained, signed evidence package per task: plan, diffs, commands run, test/QA transcripts, verifier verdict from an independent model, provenance/attestation (in-toto/SLSA-style), linked to the originating human intent. EU AI Act timing (Aug 2026) makes this acutely relevant *right now*. |

## 4. The sharp answer

**Commodity (don't compete):** single-agent autonomy, the coding harness itself, raw sandbox execution, diff-level AI review. All saturated in OSS.

**The credible open-source gap for Windkeel:** no open-source project today offers the *integrated pipeline* — instant cloud sessions + dependency-aware DAG orchestration where **every node exits through an independent verifier (different model, clean context, adversarial) and emits a signed, portable evidence package**. The pieces exist in isolation (OpenHands = sessions + cloud-only critic; Gastown/Beads = dependency-aware orchestration; PR-Agent = review), but the integration is absent, and the evidence-package layer is absent *everywhere*, including commercially.

**Sharpest wedge (showcase-worthy):** independent verification + evidence packages, wrapped around orchestration. It is (a) genuinely unoccupied, (b) riding a hard regulatory deadline (EU AI Act, Aug 2, 2026; auditor demand for AI-code provenance), (c) small enough for a solo builder to ship credibly (an evidence-package spec + verifier gate is tractable where "beat Devin's infra" is not), and (d) a natural trust story: *"agents did the work; here's the independently verified proof."* The instant-cloud-session fabric is the pillar where a side project is least differentiated against funded players and should lean on existing OSS sandboxes (e.g., OpenHands runtimes, Docker/Firecracker) rather than reinvent.

---

*Caveats: pricing/features move monthly in this market; figures above are as reported by cited sources in mid-2026. Several secondary sources (review/aggregator blogs) were used where vendor pages weren't directly fetched; treat exact plan numbers as indicative.*
