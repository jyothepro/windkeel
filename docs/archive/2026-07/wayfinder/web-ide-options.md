# Web IDE Options for In-Browser Sandbox Takeover

**Ticket:** jyothepro/windkeel#5
**Date:** 2026-07-25
**Question:** For in-browser user takeover of a running cloud sandbox (user pauses the agent, gets terminal + editor + browser control, then hands back): compare **code-server** vs **OpenVSCode Server** vs **Monaco-editor-only** vs **embedding vscode.dev**, across licensing, embedding/auth effort, terminal support, resource footprint (~4vCPU/8GB sandbox), and maintenance burden.

---

## TL;DR

**Recommendation: OpenVSCode Server** as the full-IDE takeover surface, behind Windkeel's own auth proxy — MIT-licensed, closest tracking of upstream VS Code, connection-token auth designed for exactly this reverse-proxy embedding pattern, full integrated terminal, and fits in ~0.5–1 GB of an 8 GB sandbox.

**Fallback ladder (ship in this order):**
1. **Tier 0 — xterm.js terminal-only takeover** (ship first): xterm.js + a PTY WebSocket bridge (`node-pty` or `ttyd`) inside Windkeel's own UI. Tiny (~tens of MB), fully under Windkeel's auth, covers the highest-value takeover action (poke at the sandbox shell).
2. **Tier 1 — Monaco editor + xterm.js**: add file browsing/editing in Windkeel's UI with Monaco (MIT, ~5 MB of JS, no server process). Good enough for "fix one file and hand back."
3. **Tier 2 — full IDE via OpenVSCode Server**: launch on demand inside the sandbox when the user clicks "Open IDE," reverse-proxied with a per-session connection token; kill it on hand-back.
4. **(Rejected) vscode.dev / VS Code Server**: proprietary license explicitly forbids combining it with your own application for others to use; requires Microsoft/GitHub tunnel auth; not embeddable. Do not build on it.

---

## Option-by-option analysis

### 1. code-server (Coder)

- **License:** MIT.¹ The repo maintains VS Code as a set of patches on top of `microsoft/vscode` rather than a fork with committed changes.²
- **Marketplace:** Cannot legally use the Microsoft Visual Studio Marketplace — Microsoft's Marketplace Terms of Use state "Marketplace Offerings are intended for use only with Visual Studio Products and Services" (the "In-Scope Products and Services" list covers only Microsoft's own builds).³ ⁴ code-server therefore ships pointed at **Open VSX** (Eclipse Foundation registry), which is explicitly fine for open-source platforms.² Consequence: Microsoft-proprietary extensions (Pylance, C/C++, Remote-*, Copilot) are unavailable — true for *every* non-Microsoft option here.
- **Embedding/auth:** Built-in password auth (`--auth password`, rate-limited, argon2-hashed option), built-in port proxy, heartbeat file for idle-timeout automation — genuinely useful for a pause/takeover/hand-back lifecycle.² Webviews need a secure context (HTTPS or localhost).² Historically code-server has needed care when iframed under a different origin; the usual pattern is serving it on a per-sandbox subdomain behind your proxy rather than deep iframe nesting.
- **Terminal:** Full VS Code integrated terminal (it *is* VS Code's workbench + server).
- **Footprint:** Official minimum 1 GB RAM / 2 vCPU (docs recommend 2 GB / 2 cores).¹ ⁵ Real-world reports: a few hundred MB idle per instance, with long-lived instances creeping upward (memory-growth issues reported).⁶ ⁷ Comfortable inside a 4vCPU/8GB sandbox alongside an agent.
- **Maintenance:** Coder rebases its patch set on each VS Code release; you inherit their release cadence plus their opinionated additions (auth, proxy, telemetry changes). Slightly more "product" than OpenVSCode Server, slightly more distance from upstream.

### 2. OpenVSCode Server (Gitpod)

- **License:** MIT.⁸ Explicit project scope: "minimal bits required to run VS Code in a server scenario" without changing VS Code itself — deliberately thin fork synced from `microsoft/vscode`, which keeps drift and maintenance burden minimal.⁸
- **Marketplace:** Open VSX, same Microsoft-Marketplace restriction as code-server.³ ⁸
- **Embedding/auth:** **No login UI by design** — auth is a `--connection-token` / `--connection-token-file` (since v1.64) that your reverse proxy injects.⁸ This is the cleanest shape for Windkeel: the platform already authenticates the user; the proxy adds the token; no second password to manage. Battle-tested as the embedded IDE in Gitpod (i.e., exactly the "web IDE inside an orchestrated cloud sandbox" architecture Windkeel needs).
- **Terminal:** Full VS Code integrated terminal.
- **Footprint:** Same workbench as code-server — expect ~0.5–1 GB RAM per active session, well within budget. (The repo's 4-core/6–8 GB numbers are for *building from source*, not running.)⁸ Ship the prebuilt release/Docker image; never build in the sandbox.
- **Maintenance:** Lowest of the full-IDE options — it tracks upstream tags closely and adds almost nothing, so upgrades are near-mechanical. Risk note: Gitpod's business pivot means release cadence should be watched; code-server is the drop-in fallback if the project stalls (both are MIT VS Code-server distributions with Open VSX, so switching cost is low).

### 3. Monaco editor only

- **License:** MIT (`microsoft/monaco-editor`) — it's a pure client-side JS library, no marketplace, no VS Code product terms involved at all. Cleanest licensing of any option.
- **Embedding/auth:** Trivial — it's a component in Windkeel's own frontend, so it sits behind Windkeel's existing auth with zero extra proxy surface. You must build everything around it: file tree, save/load API against the sandbox FS, search, git status.
- **Terminal:** **None.** Monaco is editor-only; terminal comes from pairing it with xterm.js + a PTY bridge (which Windkeel needs for Tier 0 anyway — xterm.js is itself MIT and is the very terminal component VS Code uses).
- **Footprint:** Best by far — ~5 MB of static JS in the browser; server side is just your file API + PTY daemon (tens of MB). Effectively free in a 4vCPU/8GB sandbox.
- **Maintenance:** Low for the library, but the *product* burden shifts to Windkeel: no extensions, no LSP out of the box (wiring language servers via `monaco-languageclient` is possible but is real ongoing work). Right choice for a "quick fix and hand back" tier, wrong choice as the terminal-plus-full-IDE endgame.

### 4. Embedding vscode.dev (with Remote Tunnels / VS Code Server)

- **Licensing — disqualifying:** vscode.dev and the VS Code Server/tunnel CLI are **proprietary Microsoft products** (the MIT-licensed `microsoft/vscode` source is not what ships). The VS Code Server license terms prohibit exactly Windkeel's use case: you may not "provide the software as a stand-alone offering or **combine it with any of your applications for others to use**," nor "host, share, publish, rent or lease the software."⁹ ¹⁰ For an open-source platform offering sandboxes to users, this is a hard no.
- **Embedding/auth:** Tunnels require the sandbox to authenticate with a **Microsoft/GitHub account** and route through Microsoft's tunnel relay¹⁰ — a third-party account dependency and data path Windkeel cannot impose on users; vscode.dev is also not built to be iframed under a third-party origin.
- **Terminal/footprint:** Fine technically (full VS Code, server piece is lightweight), which is irrelevant given the license.
- **Verdict:** Rejected. The only sanctioned "official VS Code in browser" paths are Microsoft-operated (vscode.dev, github.dev, Codespaces), none of which Windkeel can embed as a product feature.

---

## Comparison matrix

| | code-server | OpenVSCode Server | Monaco + xterm.js | vscode.dev embed |
|---|---|---|---|---|
| License | MIT ✅ | MIT ✅ | MIT ✅ | Proprietary, forbids embedding ❌ |
| MS Marketplace | No — Open VSX only | No — Open VSX only | N/A (no extensions) | Yes (but moot) |
| Embed + auth effort | Low-medium (own password layer to reconcile with platform auth) | **Low** (connection token behind Windkeel proxy) | Lowest for auth, **highest for build effort** | Blocked (MS/GitHub account, no iframe) |
| Integrated terminal | ✅ full | ✅ full | ❌ (pair with xterm.js) | ✅ (moot) |
| RAM in 4vCPU/8GB sandbox | ~0.5–1 GB, some creep reports | ~0.5–1 GB | ~negligible | n/a |
| Maintenance burden | Medium (patch-set distro) | **Low** (thin sync fork); watch project health | Low library / high product | n/a |

## Decision for Windkeel

- **Adopt the fallback ladder as the roadmap, not just a contingency.** Tier 0 (xterm.js terminal takeover) delivers most of the pause-and-poke value at ~1% of the integration cost and shares its PTY plumbing with everything above it. Tier 1 (Monaco) reuses the same panel for quick edits. Tier 2 (OpenVSCode Server, launched on demand per takeover session with a one-time connection token, reaped on hand-back) is the full-IDE endgame.
- **OpenVSCode Server over code-server** because tokenized reverse-proxy auth matches Windkeel's "platform already owns the session" model, and the thin-fork design minimizes upgrade churn; code-server remains a low-cost swap if Gitpod's fork goes stale.
- **Accept the Open VSX ecosystem** (and absence of Pylance/Copilot/Remote-*) as the unavoidable cost of any non-Microsoft distribution — this is a Marketplace-ToU constraint, not a technical one.³ ⁴
- **Never route through vscode.dev / VS Code Server / Remote Tunnels** in the product.⁹ ¹⁰

---

## Sources

1. code-server repo (MIT; 1 GB RAM / 2 vCPU requirement) — https://github.com/coder/code-server ; https://coder.com/docs/code-server/requirements
2. code-server FAQ (Marketplace ToU rationale, Open VSX, auth, heartbeat, port proxy, secure-context requirement, vs OpenVSCode Server) — https://coder.com/docs/code-server/FAQ
3. Microsoft Visual Studio Marketplace Terms of Use ("Marketplace Offerings are intended for use only with Visual Studio Products and Services") — https://cdn.vsassets.io/v/M190_20210811.1/_content/Microsoft-Visual-Studio-Marketplace-Terms-of-Use.pdf
4. VS Code license page (official product vs MIT source distinction) — https://code.visualstudio.com/license
5. Compute requirements discussion — https://github.com/coder/code-server/issues/232
6. Memory usage report — https://github.com/coder/code-server/issues/814
7. Memory-leak/creep report — https://github.com/coder/code-server/issues/5201
8. OpenVSCode Server repo (MIT, connection-token auth since v1.64, Open VSX, minimal-fork scope, build reqs) — https://github.com/gitpod-io/openvscode-server
9. Visual Studio Code Server License Terms (no combining with your applications for others to use; no hosting/sharing/publishing) — https://code.visualstudio.com/license/server
10. VS Code Server / Remote Tunnels docs (license acceptance on first run, vscode.dev tunnel URLs, MS/GitHub auth) — https://code.visualstudio.com/docs/remote/vscode-server ; https://code.visualstudio.com/docs/remote/tunnels
11. Monaco editor (MIT) — https://github.com/microsoft/monaco-editor ; xterm.js (MIT) — https://github.com/xtermjs/xterm.js
