# Daytona capability validation against the SandboxProvider contract

**Ticket:** jyothepro/windkeel#3 · **Date:** 2026-07-25 · **Status:** Resolved

## TL;DR

Daytona supports **all six** assumed capabilities, but three of them are gated in ways that matter
for Windkeel's v1 interface design:

| Assumed capability | Daytona | Gate / caveat |
|---|---|---|
| Snapshot → fork of a sandbox | ✅ (since v0.165.0, Apr 2026) | CoW fork of a **running** sandbox is **VM-sandboxes only**; SDK surface is `_experimental_createSnapshot()`. Container sandboxes (the default class) only get **cold, filesystem-only** snapshots of a **stopped** sandbox. |
| Browser automation + VNC | ✅ | Computer Use API (mouse/keyboard/screenshot/recording/AT-SPI) + in-browser noVNC, on the **default image**. No provider-managed CDP endpoint yet (open issue #4456) — run Playwright/Chromium yourself inside the sandbox. |
| Per-sandbox network policy / domain allowlist | ✅ | `domainAllowList` (≤20 entries, wildcards), `networkAllowList` (≤10 IPv4 CIDRs), `networkBlockAll`. **Per-sandbox override + runtime update requires Tier 3+** (a $500 top-up); Tiers 1–2 are org-level policy only. |
| Port previews / preview URLs | ✅ | Ports 1–65535, `https://{port}-{sandboxId}.{proxy}`, token-auth by default, signed URLs (1 s–24 h) for iframes/sharing, optional `public` flag. |
| Pause with disk-only billing | ✅ (approximately) | Containers can't "pause"; the portable shape is **stop → archive** (filesystem to object storage, disk-only cost). VM sandboxes get true pause (memory preserved, CPU billing stops). Stopped containers still occupy disk quota until archived. |
| Idle auto-stop | ✅ | `autoStopInterval` default **15 min**; auto-archive default **7 days**; auto-delete disabled by default (`-1`); `autoPauseInterval` for VMs. |

**Conclusion for v1:** keep the interface, but demote **memory-preserving fork-of-running-sandbox**
and **VNC/computer-use** from core methods to optional capability flags, and define checkpointing
as *cold filesystem snapshot → new sandbox*, which all three backends (Daytona containers, E2B,
local Docker) can implement.

---

## 1. Snapshot → fork

- Daytona shipped **Sandbox Fork & Snapshot endpoints** in v0.165.0 (2026-04-14): copy-on-write
  forks of running sandboxes, snapshot capture, fork-tree visualization in the dashboard, and SDK
  support across TS/Python/Go/Java/Ruby.
  ([changelog](https://www.daytona.io/changelog/sandbox-fork-and-snapshot-endpoints),
  [SDK changelog](https://www.daytona.io/changelog/sandbox-forking-sdk-and-org-metrics))
- **But it is gated by sandbox class** ([Sandboxes doc](https://www.daytona.io/docs/en/sandboxes/)):
  - *"Forking is supported for VM sandboxes only."* Sandboxes run as **Linux containers by
    default**; VM sandboxes are a separate (dedicated Linux/Windows VM) class.
  - Container sandboxes: **cold snapshots** (filesystem only, sandbox stopped).
    VM sandboxes: **hot snapshots** (filesystem + memory, while running).
  - Parent sandbox cannot be deleted while it has active fork children (lineage tracking / fork
    trees; forks of forks allowed).
  - SDK method is still experimental-prefixed: `sandbox._experimental_create_snapshot()` /
    `_experimental_createSnapshot()`.
- **Terminology hazard:** in Daytona docs, "Snapshot" primarily means a **pre-built base
  image/template** used at `daytona.create()` time
  ([Snapshots doc](https://www.daytona.io/docs/snapshots/)) — not a checkpoint of a live sandbox.
  Windkeel's interface should not reuse the word ambiguously.

**Verdict:** fork-from-snapshot is real, but only on the VM class behind an experimental SDK
surface. Not a safe *core* assumption; safe as an optional capability.

## 2. Browser automation, VNC / remote desktop

- **Computer Use** ([doc](https://www.daytona.io/docs/en/computer-use/)): programmatic mouse,
  keyboard, screenshot (full/region, compression, cursor), screen recording, display ops, and
  AT-SPI accessibility-tree inspection. Start with `sandbox.computerUse.start()` — **no special
  image needed** beyond the default sandbox image. Linux + Windows; macOS in private alpha.
- **VNC** ([doc](https://www.daytona.io/docs/en/vnc-access/)): in-browser noVNC desktop, one click
  from the dashboard or via SDK/API; default image includes xvfb/xfce4/x11vnc/novnc (custom images
  must install these themselves).
- **CDP for Playwright/Puppeteer is not shipped**: exposing an authenticated CDP URL for a
  sandbox-local Chromium is an open enhancement
  ([daytonaio/daytona#4456](https://github.com/daytonaio/daytona/issues/4456), overhaul tracking in
  [#4445](https://github.com/daytonaio/daytona/issues/4445)). Today you run
  Playwright/Chromium *inside* the sandbox (headless or under the VNC desktop) yourself.

**Verdict:** yes for desktop-level automation and human-viewable VNC. Don't design the interface
around a provider-supplied CDP endpoint yet.

## 3. Per-sandbox network policies / domain allowlists

([Network Limits doc](https://www.daytona.io/docs/en/network-limits/))

- Three mutually exclusive creation-time options: `networkAllowList` (IPv4 CIDR, max 10 entries),
  `domainAllowList` (max 20 entries, wildcards like `*.daytona.io`, hostname only — no
  ports/paths/protocols), `networkBlockAll`.
- Runtime updates on a running sandbox via `updateNetworkSettings` — **Tier 3 and 4 only**.
  On Tiers 1–2, network policy is org-level; sandbox-level settings cannot override it.
  Essential services (registries, CDNs, Git hosts) reachable on all tiers.

**Verdict:** supported, but a solo builder on Tier 1/2 gets org-level policy only. The interface
should treat per-sandbox policy as a capability that may be unavailable, and prefer setting policy
at creation time (portable) over runtime mutation (tier-gated).

## 4. Preview URLs

([Preview & Authentication doc](https://www.daytona.io/docs/en/preview-and-authentication/))

- Any port 1–65535 (22222 reserved for web terminal): `https://{port}-{sandboxId}.{proxyDomain}`.
- Private by default: `x-daytona-preview-token` header (tokens reset on sandbox restart).
- **Signed URLs** `https://{port}-{token}.{proxyDomain}`: credentials in the URL, iframe/email
  embeddable, expiry configurable 1 s – 86,400 s (default 60 s), revocable, survive restarts.
- `public: true` makes previews unauthenticated. Interstitial warning page on first visit unless
  header/tier-upgrade/custom proxy.

**Verdict:** fully covers the interface assumption.

## 5. Pause with disk-only billing + idle auto-stop

([Sandboxes doc](https://www.daytona.io/docs/en/sandboxes/))

- **Container sandboxes** (default): `stop()` kills the process/memory, preserves filesystem;
  stopped sandboxes **still occupy disk quota (billed for disk) until archived**; `archive()`
  moves the filesystem to object storage and frees quota. True pause is **not supported** for
  containers.
- **VM sandboxes:** `pause()` freezes the VM (memory + filesystem preserved, CPU billing stops);
  stopping a VM offloads filesystem state and frees disk quota without a separate archive step.
- **Lifecycle automation defaults:** auto-stop **15 min** of inactivity (0 disables); auto-archive
  **7 days** stopped; auto-delete disabled (`-1`), `0` = ephemeral delete-on-stop; auto-pause
  interval for VMs. ([TS SDK Sandbox reference](https://www.daytona.io/docs/typescript-sdk/sandbox/))

**Verdict:** "pause with disk-only billing" is really **stop/archive** on the default class. Idle
auto-stop is first-class and on by default.

## 6. Pricing and resource limits

- **Compute rates:** $0.0504 /vCPU-hr, $0.0162 /GiB RAM-hr, $0.000108 /GiB disk-hr
  (≈ $0.000014, $0.0000045, $0.00000003 per second) — corroborated by
  [Northflank's pricing comparison](https://northflank.com/blog/ai-sandbox-pricing) and
  [Blaxel](https://blaxel.ai/blog/daytona-dev-environment-pricing-alternatives); the official
  [pricing page](https://www.daytona.io/pricing) is JS-rendered but confirms **$200 free compute
  credit**, Windows at **$0.0858/vCPU-h**, storage priced per GiB after the first 5 free, and a
  startup program (up to $50k credits).
- **Default sandbox:** 1 vCPU / 1 GB RAM / 3 GiB disk; per-sandbox max 4 vCPU / 8 GB / 10 GiB.
- **Org tiers** ([Limits doc](https://www.daytona.io/docs/en/limits/)): shared pools —
  Tier 1 (email verified): 10 vCPU / 20 GiB RAM / 30 GiB disk;
  Tier 2 (card + $25): 100 / 200 / 300;
  Tier 3 ($500 top-up): 250 / 500 / 2,000;
  Tier 4 ($2,000 per 30 days): 500 / 1,000 / 5,000; Enterprise custom.
  API rate limits 10k–50k req/min; sandbox creation 300–600/min.

A Windkeel solo builder lands on Tier 1–2: ~10–100 concurrent 1-vCPU sandboxes, **no per-sandbox
runtime network mutation, and (practically) the container class** — which is what makes the
fork/VM caveats above design-relevant.

## 7. Gap coverage: E2B and local Docker

**E2B** ([persistence](https://e2b.dev/docs/sandbox/persistence),
[snapshots](https://e2b.dev/docs/sandbox/snapshots),
[internet access](https://e2b.dev/docs/network/internet-access),
[pricing](https://e2b.dev/pricing)):

- **Pause/resume with memory** on ordinary sandboxes (Firecracker microVMs): filesystem + memory +
  running processes preserved; `keepMemory: false` for filesystem-only; pause ≈ 4 s/GiB RAM,
  resume ≈ 1 s; paused sandboxes kept indefinitely until `.kill()`.
- **Snapshots → many sandboxes**: point-in-time capture of a *running* sandbox (filesystem +
  memory) that can spawn **multiple** new sandboxes — i.e. genuine fork-from-snapshot, without a
  separate "VM class" (requires template envd ≥ v0.5.0).
- **Network egress**: default allow-all; `allowInternetAccess: false`; fine-grained allow/deny
  rules by domain (SNI matching) and IPv4 CIDR, deny-precedence, **updatable at runtime without
  restart** — no tier gate.
- **Preview URLs** via `getHost(port)`; desktop/VNC available via the separate E2B Desktop
  sandbox template rather than the default image.
- **Pricing:** same unit rates as Daytona ($0.000014 /vCPU/s, $0.0000045 /GiB RAM/s). Hobby: free,
  $100 one-time credit, 1-h max session, 20 concurrent, 10 GiB storage. Pro: $150/mo + usage, 24-h
  sessions, 100 concurrent (expandable), 20 GiB. Session caps reset across pause/resume.
- **Gaps E2B covers:** memory-preserving pause and fork-from-running-snapshot on the *default*
  sandbox class; ungated runtime network rules. **Gaps E2B introduces:** session-length caps
  (1 h/24 h), $150/mo fixed cost for production posture, VNC not on the default template.

**Local Docker:**

- Cold checkpointing only: `docker commit` / image export (filesystem, container stopped or
  running but no memory). CRIU checkpointing exists but is experimental/fragile — do not build on
  it. No CoW fork trees; `commit` + `run` approximates cold fork.
- Network: per-container via custom networks/iptables or an egress proxy sidecar — DIY, no domain
  allowlist primitive.
- No preview URLs (needs a tunnel like cloudflared/ngrok); no billing concepts; `docker pause`
  keeps memory in host RAM (not durable). Fine as a free dev backend for the *cold* subset of the
  interface.

## 8. Recommendation: what v1 SandboxProvider should drop or defer

1. **Demote fork-from-running-snapshot to an optional capability** (`supportsHotFork` /
   `supportsMemorySnapshot`). It exists (Daytona VM class, E2B snapshots) but not on Daytona's
   default container class, is experimental in Daytona's SDK, and is impossible on plain Docker.
   Core checkpointing contract for v1: **cold snapshot = filesystem image of a (stoppable) sandbox
   → create new sandbox from it.** All three backends implement this (Daytona container cold
   snapshot / E2B `keepMemory:false` or template / `docker commit`). Design agent checkpoints so
   they never *require* preserved process memory — persist run state (conversation, task queue,
   scratch files) to disk before snapshot.
2. **Keep preview URLs in core** (Daytona and E2B both native; Docker backend returns a
   localhost/tunnel URL). Include token/signed-URL semantics in the interface.
3. **Keep idle auto-stop in core** (Daytona default 15 min; E2B session caps act as a cruder
   equivalent; Docker backend can implement a reaper). Model "pause with disk-only billing" as
   **stop + archive**, not memory pause.
4. **Network policy: creation-time only in v1.** Accept `{ blockAll | domainAllowList |
   cidrAllowList }` at create; document that runtime mutation is provider/tier-dependent
   (Daytona Tier 3+, E2B anytime, Docker DIY) and expose it behind a capability flag. Cap design
   at Daytona's limits (20 domains / 10 CIDRs) so the contract is portable.
5. **Drop VNC/computer-use from the core interface**; expose as an optional
   `desktop`/`computerUse` capability. For browser automation, standardize on *running
   Playwright/Chromium inside the sandbox* (works on all three backends) rather than assuming a
   provider CDP endpoint — Daytona's CDP exposure is still an open issue.
6. **Naming:** call the base image a `Template` and the checkpoint a `Checkpoint`/`SandboxSnapshot`
   to avoid colliding with Daytona's "Snapshot = base image" terminology.

## Sources

- https://www.daytona.io/docs/en/sandboxes/
- https://www.daytona.io/docs/snapshots/
- https://www.daytona.io/changelog/sandbox-fork-and-snapshot-endpoints
- https://www.daytona.io/changelog/sandbox-forking-sdk-and-org-metrics
- https://www.daytona.io/docs/en/computer-use/
- https://www.daytona.io/docs/en/vnc-access/
- https://github.com/daytonaio/daytona/issues/4456 and /issues/4445 (CDP browser automation, open)
- https://www.daytona.io/docs/en/network-limits/
- https://www.daytona.io/docs/en/preview-and-authentication/
- https://www.daytona.io/docs/en/limits/
- https://www.daytona.io/pricing
- https://www.daytona.io/docs/typescript-sdk/sandbox/ (lifecycle defaults)
- https://northflank.com/blog/ai-sandbox-pricing ; https://blaxel.ai/blog/daytona-dev-environment-pricing-alternatives (rate corroboration)
- https://e2b.dev/docs/sandbox/persistence ; https://e2b.dev/docs/sandbox/snapshots ; https://e2b.dev/docs/network/internet-access ; https://e2b.dev/pricing
