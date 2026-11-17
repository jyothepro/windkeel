# src/sandbox — rules

Where untrusted code runs: the maker's agent, the repository's install and tests, and the
verifier's checks. Treat everything inside a sandbox as hostile (ADR-0014). Terms:
[CONTEXT.md](../../CONTEXT.md). Factory rules: [src/factory/AGENTS.md](../factory/AGENTS.md).

| Path | What |
| --- | --- |
| `provider.ts` | `SandboxProvider` / `SandboxHandle`: the seam. Every handle has one `role`, maker or verifier |
| `vercel.ts` | The real provider (Vercel Sandbox). `fake.ts`: local temp clone, tests and local mode only |
| `lifecycle.ts` | `runInExecutionPhase`: the only way to run an untrusted command |
| `network-phase.ts` | The install-phase and execution-phase egress policies |
| `credential-broker.ts` | Attaches the maker's model key at the egress proxy, outside the sandbox |
| `git-credentials.ts` | Per-workspace, role-scoped GitHub App tokens |
| `git-hardening.ts` | Runs `git` over an agent-touched checkout without running repo-supplied config |
| `redact.ts` | Takes secret values out of sandbox output before it's stored |
| `environment-snapshot.ts` | Snapshot cache key (ADR-0031) |

- **No model key enters a sandbox** (ADR-0014 §1). The maker's key is brokered at egress; the
  checker's key never goes near one. Never add an env var, file or argument that carries a key.
- **Narrow egress before untrusted code starts** (ADR-0014 §3). Go through `runInExecutionPhase`,
  which applies the execution policy and confirms it took effect first. Never call the
  provider's exec directly for agent or repository commands.
- **The verifier cannot push.** Verifier tokens are `contents: read`; maker tokens are scoped to
  the one repository (ADR-0014 §2). Don't widen a token's permissions or reuse one across roles.
- **Maker and verifier share nothing** (ADR-0004): no disk, no handle, no cached state. A restored
  snapshot must come from the default branch before any maker ran (ADR-0031).
- **Git over a maker's checkout is hostile.** Hooks, `core.*`, filters and `include.path` are
  agent-writable; run git through `git-hardening.ts`.
- **Sandbox output is untrusted text.** Pass anything that will be stored or shown through
  `redact.ts` first; record secret names, never values (ADR-0014 §5).
- **Inside a Vercel deployment, never fall back to `FakeSandboxProvider`.** It runs code on the
  host with the deployment's environment.
- **No source comments** (ADR-0041, `npm run lint`).
- Tests: `test/sandbox-*.test.js` (network phase, credential broker, env, reattach egress, …) and
  `test/gate-isolation.test.js`. `test/sandbox-vercel.test.js` hits real Vercel; run it only on purpose.
