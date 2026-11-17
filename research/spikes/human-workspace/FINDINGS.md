# Spike A: a token-gated human workspace in Vercel Sandbox (#367)

> **The shipped server is no longer this copy (#381).** `server/`, `package.json` and
> `package-lock.json` were promoted to `src/sandbox/human-workspace-server/`, which the factory
> embeds into its build and hash-checks before every launch. The copy here is frozen as the spike
> ran it, so this harness and its tests still reproduce the spike; fix bugs in the shipped copy.

ADR-0029 §3 and §4. Flip condition 1: *"A spike shows a terminal/editor server in a Vercel Sandbox
human workspace, gated by the capability token, usable from the console with acceptable latency
from `iad1`."*

**Status, 2026-10-17: built and verified locally. Not run live.** The agent that built this had no
Vercel credentials (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` and `VERCEL_OIDC_TOKEN`
were all unset), so there are **no live numbers in this document**. None of the figures below are
measurements of a sandbox. The harness runs with one command (see *Run it*), and the live run is
the only thing still missing.

## Run it

```sh
cd research/spikes/human-workspace
npm install                      # ws + xterm; @vercel/sandbox and playwright-core come from the repo root
npm test                         # 26 tests, no Vercel needed
node browser-check.mjs           # optional: real headless Chrome against a local server

# Live (Pro team; Hobby caps a session at 45 min). Writes results/<timestamp>.json:
VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… npm run measure
# Open it yourself in a browser (prints the URL the console would open; Ctrl-C revokes and deletes):
VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… npm run harness -- --editor
```

The default target is `https://github.com/expressjs/cors`. The candidate is its default-branch
head and the base is that commit's parent, resolved through the GitHub API. You can pass
`--repo/--base/--candidate` (and `--git-token-env NAME` for a private repo), `--vcpus`,
`--install "<cmd>"` or `--no-install`, `--editor`, and `--keep`. Run `measure` once from where
users are and once from a host in us-east-1, which gives the latency floor.

## What was built

All of it lives under `research/spikes/human-workspace/`. Nothing in `src/` was changed.

| File | What it does |
|---|---|
| `server/token-gate.mjs` | The gate, as a pure module with the clock injected. It handles token minting and validation, the exchange, cookie sessions, Origin rules, expiry, API renewal, revocation and security headers. |
| `server/server.mjs` | Listens on one exposed port (3000). It serves the PTY over WebSocket at `/__windkeel/pty`, the terminal page at `/__windkeel/term`, and an optional reverse proxy to an editor on loopback. Every request goes through the gate first. |
| `server/pty-bridge.py` | A PTY built on Python's stdlib `pty`, so no native Node module is needed. It handles resize through fd 3. |
| `server/public/` | `open.html` and `boot.js` exchange the fragment for a cookie. `term.html` and `term.js` are an xterm.js client with an RTT readout and an *End session* button. |
| `lib/workspace.mjs` | Stands in for the API. It creates the sandbox, clones at `base`, fetches `candidate` through hardened git, runs the install, sets up the server, mints the token and starts the server with only the token's hash. It also covers sleep and wake. |
| `lib/probe.mjs` | A scripted browser. It does the exchange, the PTY, app RTT and keystroke-echo RTT, the 14 negative gate checks and a revocation check. |
| `lib/cost.mjs` | Cost arithmetic from `research/vercel-sandbox/findings.md` §6. |
| `measure.mjs` / `harness.mjs` | The live measurement run and the interactive run. |
| `test/*.test.mjs` | 22 gate unit tests, 5 cost tests and 2 local end-to-end tests: PTY, probes, renewal, revocation, and the editor proxy with cookie stripping. |
| `browser-check.mjs` | Headless Chrome runs the real flow against a local server. |

### How the workspace is seeded (ADR-0029 §3.3, ADR-0004)

- `Sandbox.create({ source: { type: "git", revision: base }, ports: [3000], persistent: true, networkPolicy: { allow: await buildPhaseAllowMap(installPhasePolicy(), []) } })`.
  This uses Windkeel's own install allowlist, imported from `src/sandbox/network-phase.ts`, turned
  into the domain → rules record `@vercel/sandbox` 3.1 expects (`{ "github.com": [], … }`) by
  `buildPhaseAllowMap` from `src/sandbox/credential-broker.ts`, with no credential rules. The
  person keeps the install allowlist, as §3.5 says, and nothing is forked or restored from
  another sandbox.
- `assertSafeGitConfig` runs first. Then `git fetch --no-tags origin <candidate>`,
  `checkout --detach` and `rev-parse` run with `HARDENED_GIT_ARGS`/`HARDENED_GIT_ENV`, imported
  from `src/sandbox/git-hardening.ts`. Node ≥ 22.18 strips the types, so the spike can't drift
  from production.
- The install command is auto-detected (or passed in) and runs before anyone gets the URL.
  It runs **without repository secrets** (ADR-0029 §3.4, amended): the person gets root in the
  VM next, so anything an install path stashed would be readable. Before it runs, the spike strips
  any credential from the origin URL and refuses to install if a git credential is left in the
  checkout's or user's config or in `~/.git-credentials`. A repository whose install needs a
  secret gets a workspace without those dependencies.

### How the token works (ADR-0029 §4)

1. **Minted by the API, never put in the VM.** 256 bits from `crypto.randomBytes(32)`, encoded as
   base64url (43 chars). The server is started with `WINDKEEL_WS_TOKEN_SHA256` only. The token's
   hash is also stripped from the shell's environment: the end-to-end test asserts `env | grep
   WINDKEEL_WS_` returns 0 lines inside the PTY.
2. **Delivered in a fragment.** The console opens `https://<sandbox>.vercel.run/__windkeel/open#t=<token>`.
   Browsers never send fragments in requests, so no proxy log can capture one. `boot.js` runs
   `history.replaceState` to strip the fragment *before* it makes any request.
3. **Exchanged for a cookie that is not the token.** `boot.js` POSTs `{"token": …}` as
   `application/json` to `/__windkeel/session`. The server requires `Origin` to equal its own public
   origin and compares SHA-256 digests with `timingSafeEqual`. It then mints a separate 256-bit
   session id and sets
   `__Host-windkeel_ws=<id>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=<remaining>`. The
   `__Host-` prefix means no sibling host can set or shadow the cookie.
4. **Single-use token.** A second exchange of the same token gets 401 `token already used`, even
   from a fresh browser. A failed guess doesn't use up the token. A reopen from the same browser
   needs no token, because `/__windkeel/open` with no fragment does a same-site navigation and the
   Strict cookie goes with it.
5. **Query strings are never read.** `?t=<token>` gets 401, and so does the token used as a
   cookie value.
6. **Origin is enforced on every WebSocket upgrade and every state-changing request.** This blocks
   cross-site WebSocket hijacking (CSWSH) whatever the browser's SameSite behaviour. A
   cross-origin GET that carries an `Origin` is also refused.
7. **Expiry and renewal.** At `expiresAt` every request fails and every live socket is closed with
   code 4002. While the person is working, the API extends the sandbox and, in the same step,
   calls `POST /__windkeel/renew` with `Authorization: Bearer <token>` and `{ "expiresAt": … }` (the
   harness does this every 10 minutes, to now + 40 min), so an actively used session is not cut
   off at its initial TTL. Renewal is bearer-only (the person's cookie cannot renew), only extends,
   is capped at 60 min from now, cannot revive an expired or revoked gate, re-arms the server's
   socket-expiry timer, and re-issues the cookie with the new `Max-Age` on the next request.
8. **Revocation.** `POST /__windkeel/revoke` accepts `Authorization: Bearer <token>` from the API, or
   the session cookie plus the same Origin from the person's *End session* button. It is
   terminal: every request then gets 410 and live PTYs are closed with code 4001 and their shells
   get SIGHUP.
9. **Public routes are kept to a minimum.** Four routes are served without a session, and none of
   them serves anything that isn't static and identical for every caller: `GET /__windkeel/open`,
   `GET /__windkeel/boot.js`, `POST /__windkeel/session` and `POST /__windkeel/revoke`. The last two
   authenticate themselves. Everything else, including the terminal page, the xterm assets, the
   PTY socket and the whole editor, gets 401. This is the one place the spike reads the issue's
   "refuses every request lacking the token" loosely: the bootstrap page has to load *before* it
   can read the fragment.
10. **Headers.** Every response sets `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
    `frame-ancestors 'none'`, `script-src 'self'`, `connect-src` limited to the server's own
    `wss:` origin, and COOP/CORP `same-origin`.

### The editor

`--editor` downloads the latest OpenVSCode Server release into the VM and starts it with
`--host 127.0.0.1 --without-connection-token`, behind the gate's reverse proxy for both HTTP and
WebSocket. The spike **does not use OpenVSCode's own `--connection-token`**, because that token is
accepted as `?tkn=` in a query string, which §4 forbids. The proxy strips `__Host-windkeel_ws` before
forwarding, so the editor never sees the session id (asserted in the test). The proxy is tested
locally against a stand-in editor. Real OpenVSCode Server has not been run behind it: that needs
the live run, and `harness --editor` does it.

## What was verified, and where

| Claim | Verified |
|---|---|
| Gate logic (token format, constant-time match, single use, Origin, content type, duplicate-cookie refusal, expiry, renewal, both revocation paths, public-route list) | Unit tests, 22 passing |
| Server, Python PTY, shell I/O, resize, app ping, keystroke echo, all 14 negative checks, revocation closing a live PTY (4001) and later requests getting 410 | Local end-to-end test against a real server process |
| Editor proxy is gated for HTTP and WS, a foreign Origin on the editor WS is refused, and the editor never receives the gate cookie | Local end-to-end test with a stand-in editor |
| In a real browser: fragment stripped, cookie is `HttpOnly`/`Secure`/`SameSite=Strict`/`__Host-` and not readable by `document.cookie` and not equal to the token, xterm renders and runs a command, replaying the fragment in another browser fails, reopening without a fragment works, *End session* revokes, no CSP violations | `browser-check.mjs`, headless Chrome on `http://localhost` |
| Sandbox create with clone at `base`, hardened fetch of `candidate`, install, server reachable on the public `vercel.run` URL, **WebSocket upgrade through Vercel's port proxy**, latency from the person's location, sleep and wake | **Not verified.** Needs the live run (`npm run measure`). |

## Numbers

**Not run live. No sandbox numbers exist yet.** `measure.mjs` records every figure the issue asks
for, and the table shows where each one lands in `results/<timestamp>.json`:

| Metric | Field in the results | Live value |
|---|---|---|
| Cold start: create plus clone at base | `coldStart.createWithCloneMs` | not run |
| Fetch candidate (hardened) | `coldStart.fetchCandidateMs` | not run |
| Install | `coldStart.installMs` | not run |
| Server setup (write files, `npm ci` of 3 deps) | `coldStart.serverSetupMs` | not run |
| Server reachable on the public URL | `coldStart.serverReadyMs` | not run |
| **Total, from create to ready** | `coldStart.totalToReadyMs` | not run |
| Token exchange; WS open; **first PTY byte** | `firstPty.*` | not run |
| App round trip (to the server process), p50/p95 over 50 | `latency.appRoundTrip` | not run |
| **Keystroke echo** (through the shell), p50/p95 over 40 | `latency.keystrokeEcho` | not run |
| Sleep (`stop()`, which snapshots) | `sleepWake.stopMs` | not run |
| Wake (`Sandbox.get({resume:true})`), first command after wake | `sleepWake.resumeGetMs`, `firstCommandAfterResumeMs` | not run |
| Uncommitted work and `node_modules` survive sleep | `sleepWake.uncommittedWorkSurvived`, `installedDepsSurvived` | not run |
| Server process after wake (PID before sleep vs. `pgrep -f '[s]erver\.mjs'` after, a pattern that cannot match its own `sh -c`) | `sleepWake.serverPidBeforeSleep`, `serverPidsAfterWake`, `serverProcessSurvived` | not run |
| Server restart after wake (new token); **wake to first PTY byte** (one clock from before the wake to the first PTY byte, including the checks, restart and token exchange) | `sleepWake.restartServerReadyMs`, `wakeToFirstPtyByteMs` | not run |
| Same public origin after wake | `sleepWake.sameOriginAfterResume` | not run |
| Measured active CPU, egress, cost extrapolated per hour | `cost.measuredFirstSession` | not run |

For reference only, and not a sandbox figure: on loopback the app round trip was about 2 ms in
the browser check. That bounds the server's own overhead and says nothing about `iad1`.

### Cost per hour (calculated from published rates, not measured)

These figures use the Pro rates in `research/vercel-sandbox/findings.md` §6: $0.128 per vCPU-hour
of *active* CPU, $0.0212 per GB-hour of provisioned memory (2 GB per vCPU), and $0.15 per GB of
egress.

| 2 vCPU / 4 GB workspace | Memory | CPU | Total / hour |
|---|---|---|---|
| Idle (open, nobody typing) | $0.085 | $0.000 | **$0.085** |
| Light editing (5% active CPU) | $0.085 | $0.013 | **$0.098** |
| Building and testing now and then (25%) | $0.085 | $0.064 | **$0.149** |
| Fully busy (100%) | $0.085 | $0.256 | **$0.341** |

- **Asleep costs no compute, only snapshot storage** at $0.08 per GB-month. A 2 GB snapshot that
  sleeps for a day is about $0.005. This is why §3's 30-minute idle sleep matters: an hour of idle
  memory costs about $0.085, which is roughly 17 days of storing that snapshot.
- **Egress through the exposed port is billed in both directions.** Terminal traffic is
  negligible. An OpenVSCode workbench load is about 10–30 MB of assets, so less than $0.005 per
  open.
- A 24-hour `HUMAN_EDITING` cap at a light-editing profile with 30-minute sleeps comes to well
  under $1 per session. `measure.mjs` replaces this table with the measured active-CPU fraction.

## Threats

1. **The port is public.** `sandbox.domain(3000)` is reachable by anyone on the internet, and
   Vercel puts no authentication in front of it (findings §3). The server treats it that way:
   only the four routes above answer without a session. Remaining exposure:
   - Unauthenticated callers can reach the bootstrap and the exchange. Brute force is pointless
     against 256 bits, but nothing in the spike stops volume (body ≤ 4 KB, no rate limit,
     unbounded PTYs per session). Production should cap PTYs per session and connections per
     IP.
   - The hostname is not secret. Assume it is enumerable.
   - Nothing else may listen on an exposed port. Only 3000 is exposed. The editor (3001) and the
     person's own dev servers are on loopback or unexposed ports, and a preview has to go through
     the same gate (§4). The spike does not build a preview.
2. **Ways the token can leak, and what limits each one.**
   - *Browser history and sync.* The navigation commits once with the fragment before `boot.js`
     strips it, so the URL with the token can end up in the browser's global history, session
     restore or a synced profile. Mitigations: the token is **single-use** (verified), short-lived
     and revocable. A copied link fails once the tab has used the token.
   - *The console.* The console's JavaScript holds the token for one navigation. An XSS in the
     console steals it, as it would steal anything else. The API response that delivers the token
     must be `no-store` and must not be logged. That belongs to production, not the spike.
   - *Proxies and the Referer header.* Fragments are never sent. The page sets `no-referrer`, and
     the exchange is a same-origin POST body. **Open: whether Vercel's port proxy logs request
     `Cookie` headers.** If it does, the session id (not the token) is in a Vercel log, scoped to
     one sandbox and one session.
   - *Inside the VM.* The server holds only the token's hash. It does hold **live session ids in
     memory**, and repository code runs as the same user with passwordless sudo. Any code the
     person runs (an `npm install` script, a dev server) can read the server's memory, steal a
     session and hand an outside party a live shell until the session expires. It could equally
     kill the server, bind :3000 and serve an ungated shell. The person is trusted, but the code
     they run is not. What limits the damage is what ADR-0029 already requires: **no Windkeel
     credential is ever in this VM**, so a hijack gets the repository and whatever the person
     types, and nothing of Windkeel's.
   - *The harness* prints the open URL to the terminal, by design for a spike. Production never
     prints or logs it.
3. **Sudo in the VM.** The image's default user has passwordless sudo
   (`src/sandbox/vercel.ts`, `terminateStrayProcesses`). The `inVm.sudoWithoutPassword` field in
   the results records it live. In practice:
   - Root in the VM cannot widen egress. The firewall is Vercel's proxy, outside the VM.
   - **Root can read anything left in the VM**, so a secret that was present during install could
     not be made to leave reliably (any file, surviving process or `.npmrc`). This is why ADR-0029
     §3.4 was amended so the human workspace installs with no repository secrets at all.
   - **§3.6's sweep-then-push has the same residual as the maker's.** A root process started from
     the person's terminal survives an unprivileged sweep and can capture the just-in-time push
     token. For a person that is acceptable (they could push anyway). For a malicious dependency
     they ran under sudo, it is not. The clean fix is the ADR-0014 follow-up: the push token never
     enters this VM, and the API pulls the person's commit out (for example as a `git bundle` via
     `readFile`) and pushes it from outside. This is input for flip condition 3, the security
     sign-off.
   - Running the person's shell as a separate non-sudo user (`sandbox.createUser()/asUser()`),
     with the server owning the PTY as another user, would close the server-memory and port-takeover
     paths. Whether people accept a workspace without sudo is a product question.
4. **Framing and the console.** `frame-ancestors 'none'` blocks clickjacking, and it also means
   **the console cannot embed the workspace in an iframe**. Third-party-cookie blocking would
   break an iframed `SameSite=Strict` cookie anyway. The console has to open the workspace in a
   new tab or window. That belongs in `docs/ui/console-ux.md`'s ADR-0029 sections. Embedding
   would need a partitioned (CHIPS) cookie with `SameSite=None` and a weaker CSRF story.
5. **Same-site boundaries.** `vercel.run` is on the Public Suffix List (checked 2026-10-17), so
   every sandbox subdomain is its own site. A sandbox someone else controls cannot ride the
   person's Strict cookie, and `__Host-` stops cookie tossing. The Origin check would hold even if
   that were not the case.
6. **Workspace lifetime and process loss.** Sleep keeps the filesystem, not processes. After a
   wake the server has to be restarted with a **newly minted token**. The old token's hash dies
   with the process, which is a free revocation. The console then reopens with the new fragment.
   *Sleeping — opens again when you type* is therefore an API round trip (wake, start the server,
   mint, reopen) rather than something the existing tab can do on its own.

## Open questions (the live run answers the first four)

1. **Does Vercel's exposed-port proxy pass WebSocket upgrades, and what is its idle timeout?** The
   whole design depends on it. `measure` fails at `openPty` if it doesn't. The client sends a
   ping every 5 s, which keeps an idle terminal alive under most proxy timeouts.
2. Keystroke-echo latency from real user locations to `iad1`. Proposed bar for *acceptable*:
   p50 ≤ 100 ms and p95 ≤ 200 ms from the target user region.
3. Cold start for a realistic repository. The spike's `serverSetupMs` (npm ci of ws and xterm)
   and the editor download should drop to near zero with a custom VCR image or a pre-maker base
   snapshot. ADR-0004 allows caching state that predates any maker involvement.
4. Whether the public origin stays the same across sleep and wake (`sameOriginAfterResume`). If it
   changes, the cookie is lost and the person must reopen from the console, which they have to do
   after a wake anyway (threat 6).
5. **`sandbox.openInteractive()`.** `@vercel/sandbox` 3.1 has a platform-native interactive PTY
   that returns `{ url, token }`. It could replace the terminal half with platform-minted
   credentials. Unknowns: how its token travels (if it goes in a query string, §4 rules it out),
   whether a browser can use it directly, and its lifetime. It does not cover the editor or a
   preview, so it would at most replace `/__windkeel/pty`. Worth 30 minutes in the live run.
6. OpenVSCode Server behind the proxy: whether webviews load from a third-party origin
   (`*.vscode-cdn.net` in stock VS Code web), and whether extensions are wanted. `open-vsx.org` is
   not on the install allowlist.
7. Whether the person's shell should run without sudo (threat 3), and whether the push should
   leave the VM entirely. Both feed flip condition 3.

## Verdict on ADR-0029 flip condition 1

**Not yet met. It is blocked on one live run, not on any design or feasibility problem found here.**

What the spike shows: the mechanism §4 describes can be built as specified, with these
properties.

- A terminal server and an editor reverse proxy refuse every non-bootstrap request without a
  session derived from a 256-bit, single-use, expiring, revocable capability token.
- The token travels only in a fragment and a same-origin POST body, never in a query string, and
  is exchanged for an `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie on the sandbox origin.
- The workspace is seeded at base plus candidate through Windkeel's own hardened git.

All of this works end to end in a real browser against the real server code. Two halves of
condition 1 are still unshown: *"in a Vercel Sandbox"* (with Vercel's port proxy carrying the
WebSocket) and *"acceptable latency from `iad1`"*. Both come out of `npm run measure` with
credentials. Mark condition 1 met when a committed `results/*.json` shows:

- all gate checks and the revocation check passing on the public URL;
- a first PTY byte;
- keystroke echo within the bar in open question 2, from the target region;
- a wake that preserves uncommitted work.

The one result that would send this back to the ADR is the port proxy refusing or prematurely
dropping WebSocket upgrades. That would leave either `openInteractive()` (open question 5) or the
always-on relay §4 rejected.
