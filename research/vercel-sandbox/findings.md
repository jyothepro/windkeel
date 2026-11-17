# Vercel Sandbox — capabilities for Windkeel factory workloads (wayfinder #52)

Researched 2026-08-14 against official Vercel docs (docs last updated 2026-08-03/04). Scope: can Vercel Sandbox host a per-run engineering sandbox (clone repo → run coding-agent CLI → run tests → tear down), and does it fit the planned `SandboxProvider` interface.

## TL;DR

Vercel Sandbox is a Firecracker microVM-per-sandbox service (dedicated kernel, full root) with first-class JS/Python SDKs, a CLI, and a REST API. It natively supports git-clone-on-create, blocking/detached command exec with streamed logs, file put/get, up to 15 exposed ports with public URLs, snapshot/fork/restore (persistent-by-default), per-domain egress firewall with credential brokering, and 24 h max runtime on Pro/Enterprise. It can run Docker, Playwright, and databases inside the VM. The default `universal` image preinstalls Node 24, Python 3.14, git, gh, and coding agents including **OpenAI Codex CLI, Claude Code, and OpenCode**. A 20-minute 4 vCPU run costs roughly **$0.10–0.23**. No hard blockers found; several interface-shaping details below.

---

## 1. API / SDK surface

SDKs: **JS/TS** (`@vercel/sandbox`), **Python** (`vercel.sandbox` in the `vercel` package), a **CLI** (`sandbox` — list/create/connect/exec/copy/stop/snapshot), and a **REST API** (`/docs/rest-api/sandboxes/*`: create/get/update/fork/delete named sandboxes, update network policy). SDK/CLI source is open at [github.com/vercel/sandbox](https://github.com/vercel/sandbox).

JS SDK core (all confirmed in the [JS SDK reference](https://vercel.com/docs/sandbox/sdk-reference)):

| Operation | API |
| --- | --- |
| Create | `Sandbox.create({ name?, image?, source?, resources: { vcpus }, timeout, ports, networkPolicy, env, tags, persistent, snapshotExpiration, keepLastSnapshots, mounts, onResume })` |
| Create from repo | `source: { type: 'git', url, username?, password?, depth?, revision? }` — **native git clone at create time**, incl. private repos via token; also `tarball` and `snapshot` sources |
| Lookup / resume | `Sandbox.get({ name })`, `Sandbox.getOrCreate({ name, onCreate, onResume })`, `Sandbox.list()` (filter by tags/name prefix, paginated) |
| Fork | `Sandbox.fork({ sourceSandbox })` — new sandbox seeded from another's current snapshot |
| Exec | `sandbox.runCommand(cmd, args)` or object form `{ cmd, args, cwd, env, sudo, detached, stdout, stderr, signal }`. Blocking → `CommandFinished` (`exitCode`, `durationMs`, `stdout()`, `stderr()`); `detached: true` → live `Command` with `logs()` async-generator streaming, `wait()`, `kill(signal)`; `sandbox.getCommand(cmdId)` re-attaches from another process |
| Put files | `sandbox.writeFiles([{ path, content: Buffer, mode? }])` (default cwd `/vercel/sandbox`); `sandbox.mkDir()`; also `sandbox.fs.*` — a `node:fs/promises`-compatible subset (readFile/writeFile/readdir/stat/chmod/chown/symlink/rm/rename/copyFile/exists…) |
| Get files | `sandbox.readFile({ path })` → stream, `readFileToBuffer()`, `downloadFile(src, dst)` to local disk. **Single-file only — no recursive directory download primitive** (bulk retrieval = `tar` via `runCommand` + read the tarball, or CLI `sandbox copy`) |
| Expose ports | declare `ports: number[]` at create (≤ 15) → `sandbox.domain(port)` returns a public URL; mutable later via `sandbox.update({ ports })` |
| Snapshot | `sandbox.snapshot({ expiration })` → `snapshotId`; **calling it shuts the sandbox down** (terminal). Restore: `Sandbox.create({ source: { type: 'snapshot', snapshotId } })` or `sandbox.update({ currentSnapshotId })` (rollback). `Snapshot.list/get/tree/delete` |
| Persistence | sandboxes are **persistent by default**: on stop, filesystem auto-snapshots; next SDK call auto-resumes from it. Opt out with `persistent: false`. Retention via `snapshotExpiration` (default 30 d) and `keepLastSnapshots: { count: 1–10 }` |
| Timeout | default 5 min; `timeout` at create; `sandbox.extendTimeout(ms)` up to plan max; `expiresAt` accessor |
| Teardown | `sandbox.stop()` (ends session, returns `activeCpuDurationMs`, network transfer, snapshot metadata) vs `sandbox.delete()` (permanent; snapshots survive until expiry) |
| Multi-user | `sandbox.createUser()/asUser()/createGroup()` — per-agent Linux users with private homes (JS SDK only) |
| Usage metering | per-session `activeCpuUsageMs`, `networkTransfer {ingress, egress}`, cumulative totals — usable for per-run cost attribution |

Sources: [JS SDK Reference](https://vercel.com/docs/sandbox/sdk-reference), [Python SDK Reference](https://vercel.com/docs/sandbox/python-sdk-reference), [CLI Reference](https://vercel.com/docs/sandbox/cli-reference), [Concepts](https://vercel.com/docs/sandbox/concepts).

## 2. Base images / runtimes; Docker and arbitrary tooling

- Isolation: one **Firecracker microVM per sandbox, dedicated kernel**, full root (`sudo`), millisecond-class startup; snapshot resume is faster than fresh boot. Region: **`iad1` only**.
- [Vercel Managed Images](https://vercel.com/docs/sandbox/concepts/images) (nightly rebuilds, open source):
  - `vercel/sandbox/universal:latest` (default): Ubuntu 26.04, Node.js 24 LTS, Python 3.14, Bun, pnpm 11, uv, **git + git-lfs, gh CLI**, and preinstalled coding agents: **Claude Code (`@anthropic-ai/claude-code`), OpenAI Codex CLI (`@openai/codex`), OpenCode (`opencode-ai`), Pi** (verified in the [universal Dockerfile](https://github.com/vercel/sandbox/tree/main/images/universal)); plus curl, jq, ripgrep, tmux, rsync, netcat, etc.
  - `vercel/sandbox/node:22|24|26`, `vercel/sandbox/python:3.14`, `vercel/sandbox/arch:latest`, `vercel/sandbox/ubuntu:latest`.
- **Custom OCI images** via Vercel Container Registry (VCR): any Dockerfile, pushed with `vercel vcr build … --push`; must be prepared as optimized `linux/amd64` before use (`image_not_ready` retry state). Images shareable across teams / public. **`ENTRYPOINT`/`CMD` are not executed** — start processes with `runCommand`.
- **Docker-in-sandbox: explicitly supported** ("container runtimes: run Docker and other container engines inside the sandbox"), along with VPN clients and FUSE mounts — run with `sudo`. Caveat: containers don't inherit the sandbox's per-VM proxy CA, so if firewall transformation rules terminate TLS, the CA must be mounted into the container's trust store.
- Arbitrary repo tooling (Playwright browsers, Postgres/MySQL/Redis servers, compilers) is viable: full apt/root Ubuntu VM, 32 GB NVMe disk. In-sandbox Postgres works normally; *external* hosted Postgres through a domain-allowlist firewall requires TLS (`sslmode=require`; no GSSAPI, no credential brokering on Postgres).
- S3-style remote storage mountable via FUSE ([Mount remote storage](https://vercel.com/docs/sandbox/mount-remote-storage)); **Drives** (persistent block storage, ≤ 1 TiB, default 100 GiB) are in **private beta**.

## 3. Network policy / egress controls ([firewall docs](https://vercel.com/docs/sandbox/concepts/firewall))

- Three modes, settable at create and **updatable live on a running sandbox** without restart: `allow-all` (default), `deny-all` (blocks everything incl. DNS), and user-defined.
- User-defined = deny-by-default plus: domain allowlist (SNI-based, wildcard `*.example.com` support), `subnets.allow` / `subnets.deny` CIDR lists (deny takes precedence).
- **Credential brokering**: per-domain `transform` rules inject headers (API keys) into egress at the proxy so secrets never enter the sandbox — directly relevant to giving an agent scoped GitHub/AI-gateway access without exposing tokens.
- **Request proxying**: per-domain `forwardURL` routes traffic to your own HTTP proxy with a Vercel-signed OIDC token identifying team/project/sandbox (`defineSandboxProxy` helper).
- Matchers on path/method/query/headers (exact / startsWith / RE2 regex); first-match-wins.
- Sharp edges documented by Vercel: domain rules and subnet rules are enforced **independently** (a broad `subnets.allow` bypasses domain filtering, SNI filtering, and brokering); `subnets.allow` alone leaves DNS open (DNS exfiltration possible unless a domain allowlist or `deny-all` is set); plain-HTTP can only be filtered by IP; SNI-less TLS bypasses per-domain transforms under a `*` catch-all.
- Inbound: only via explicitly exposed ports (public URLs — anyone with the URL can reach them; no documented port auth).

## 4. Resource limits, durations, concurrency ([pricing & quotas](https://vercel.com/docs/sandbox/pricing))

| Limit | Hobby | Pro | Enterprise |
| --- | --- | --- | --- |
| Max vCPUs / sandbox (2 GB RAM per vCPU, default 2) | 4 | 8 | 32 |
| Max memory | 8 GB | 16 GB | 64 GB |
| Disk (ephemeral NVMe, fixed) | 32 GB | 32 GB | 32 GB |
| Open ports | 15 | 15 | 15 |
| Max session duration (default timeout 5 min, extendable) | 45 min | **24 h** | 24 h |
| Concurrent sandboxes / team | 10 | **10,000** | 10,000 |
| vCPU allocation rate (dynamic quota) | 20→40 /min | 150→5,000 /min | 150→5,000 /min |
| Control-plane ops (exec, file reads…) | 1,000 req/min | 10,000 req/min | 100,000 req/min |
| Deletions | 20 req/s | 20 req/s | 20 req/s |

- vCPU allocation ramps with sustained usage (Pro: idle start 150 vCPU/min ≈ 18×8-vCPU sandboxes, +500/min ramp to 5,000/min; resets after 10 idle minutes) — matters for burst-provisioning many runs at once.
- Snapshots expire 30 days after last use by default (configurable, `0` = never).
- Region: `iad1` only.

## 5. Auth model ([authentication docs](https://vercel.com/docs/sandbox/concepts/authentication))

- **OIDC tokens** (recommended): automatic when running on Vercel; local dev via `vercel link` + `vercel env pull` (`VERCEL_OIDC_TOKEN`, 12 h expiry).
- **Access tokens** (the path for a non-Vercel server like Windkeel's control plane): set `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` env vars or pass to `Sandbox.create()`. Sandboxes are project-scoped (names unique per project; images resolve per project).
- REST API available for anything the SDKs don't cover.

## 6. Pricing and cost of a 20-minute run

Rates (Pro/Enterprise, usage-billed; Hobby has fixed free allotments then pauses):
- Active CPU **$0.128 / vCPU-hour** (I/O wait not billed) · Provisioned memory **$0.0212 / GB-hour** (1-min minimum) · Creations **$0.60 / 1M** · Egress **$0.15 / GB** (downloads into the sandbox — packages, git clones — are free; exposed-port traffic billable both ways) · Snapshot storage **$0.08 / GB-month**.

20-minute engineering run estimates:

| Shape | Memory cost | CPU cost @100% | Total @100% | Realistic (agent ≈ 25–50% active CPU) |
| --- | --- | --- | --- | --- |
| 2 vCPU / 4 GB | $0.028 | $0.085 | ~$0.11 | **~$0.05–0.07** |
| 4 vCPU / 8 GB | $0.057 | $0.171 | ~$0.23 | **~$0.10–0.14** |

(Vercel's own example: 30-min 4-vCPU build-and-test ≈ $0.34 at full utilization.) Coding-agent workloads are mostly waiting on LLM calls, so Active CPU billing works in Windkeel's favor. Watch snapshot storage: persistent-by-default means every stopped sandbox leaves a snapshot billed at $0.08/GB-month until expiry.

## 7. Can a coding-agent CLI run inside one?

**Yes — this is a promoted use case.** The default `universal` image ships Node 24, Python 3.14, git/gh, and preinstalls **OpenAI Codex CLI, Claude Code, and OpenCode**. Vercel publishes guides for running [OpenCode with restricted egress](https://vercel.com/kb/guide/running-opencode-securely-with-the-vercel-sandbox), [Claude Agent SDK](https://vercel.com/kb/guide/using-vercel-sandbox-claude-agent-sdk), [Devin Outposts](https://vercel.com/kb/guide/devin-outposts-vercel-sandbox), Herdr, and Hermes ([ecosystem page](https://vercel.com/docs/sandbox/ecosystem)). **OpenHands has no dedicated guide**, but nothing blocks it: it's pip/uv-installable, and its Docker-runtime mode is viable since Docker runs in-sandbox (its default docker-based sandboxing would nest inside the microVM). Package installs (npm/pip/apt) work out of the box; private repo cloning is supported via `source.git` credentials or gh auth. Agent API keys can be kept out of the sandbox entirely via credential brokering.

## 8. Fit with planned `SandboxProvider { create, exec, putFiles, getFiles, exposePort?, snapshot?, destroy }`

The interface maps cleanly; five details would shape it:

1. **`getFiles` has no bulk primitive.** SDK reads are single-file (`readFile`/`downloadFile`). A `getFiles(paths[])` or directory-diff retrieval must be built as `tar`-via-`exec` + single-file read. Fine, but it's provider-side glue, not a native call.
2. **`snapshot()` is terminal.** `sandbox.snapshot()` stops the VM; you cannot checkpoint and continue the same session. If the interface promises "snapshot mid-run, keep running", it must be implemented as snapshot → auto-resume (persistent sandboxes resume on next call, so this is cheap but not instantaneous or atomic-with-continuation).
3. **Port exposure is declarative-at-create** (or via `update({ ports })` replacing the full list), and `domain(port)` URLs are public with no built-in auth. `exposePort?` should be modeled as "ensure port in desired set", and Windkeel must treat exposed services as internet-reachable.
4. **`destroy` is two concepts**: `stop()` (session ends, auto-snapshot persists and bills storage) vs `delete()` (sandbox gone, snapshots linger until expiry). One-shot factory runs should use `persistent: false` and/or explicit `delete()` to avoid snapshot-storage accretion; the interface should decide which semantic `destroy` means.
5. **`create` can subsume repo cloning**: `source: { type: 'git' }` clones (with depth/revision/credentials) before the first command, which may make a separate "clone" step in the run pipeline unnecessary for this provider.

Also worth encoding in the provider abstraction: `env` at create + per-exec `env`; `networkPolicy` at create and live updates (a natural fit for a phase-based policy: allow-all during install → locked-down during agent execution); `timeout`/`extendTimeout` keep-alive; per-run usage metrics from `stop()` for cost attribution.

## Decision inputs

- **No hard blockers** for the factory workload (clone → agent CLI → tests → teardown) on Pro/Enterprise.
- Isolation: Firecracker microVM per sandbox, dedicated kernel, root — strictly stronger than container-based options; Docker/Playwright/DBs run inside.
- Runtime envelope: ≤ 8 vCPU/16 GB (Pro) or 32 vCPU/64 GB (Enterprise), fixed 32 GB disk, 24 h max, 10k concurrent, `iad1` only (US-East latency/data-residency constraint).
- Cost: ~**$0.05–0.23 per 20-min run** depending on size and CPU activity; ~free creation; ingress free; snapshot storage is the main lingering cost with persistence on.
- Server-driven from outside Vercel: supported via access token + team/project IDs; JS and Python SDKs + REST API.
- Egress firewall with live policy updates + credential brokering is a differentiator for running untrusted agent output; but subnet/domain rule composition has documented bypass sharp-edges that Windkeel's policy layer must not misuse.
- Interface deltas: no bulk file download; terminal snapshot semantics; declarative public ports; stop-vs-delete split; native git-clone-at-create.
- Watch items: Drives (persistent storage) still private beta; custom images must be VCR-hosted `linux/amd64` and don't run ENTRYPOINT/CMD; Hobby plan is unusable for production (45 min cap, 10 concurrent, hard pause on quota).

## Sources

- https://vercel.com/docs/sandbox (overview; last updated 2026-08-04)
- https://vercel.com/docs/sandbox/sdk-reference (JS SDK)
- https://vercel.com/docs/sandbox/python-sdk-reference (Python SDK)
- https://vercel.com/docs/sandbox/cli-reference (CLI)
- https://vercel.com/docs/sandbox/pricing (pricing, quotas, limits)
- https://vercel.com/docs/sandbox/concepts (isolation, lifecycle, security model)
- https://vercel.com/docs/sandbox/concepts/firewall (network policy, brokering, proxying)
- https://vercel.com/docs/sandbox/concepts/images (managed + custom images)
- https://vercel.com/docs/sandbox/concepts/authentication (OIDC / access tokens)
- https://vercel.com/docs/sandbox/ecosystem (coding agents)
- https://github.com/vercel/sandbox (SDK/CLI + image Dockerfiles; universal image contents verified)
- https://vercel.com/changelog/vercel-sandbox-now-supports-10-000-concurrent-sandboxes-and-5-000-vcpus-per-minute-5GbcfioHgigIJbrduCJehB/f6b2298042 (Aug 2026 quota changes)
