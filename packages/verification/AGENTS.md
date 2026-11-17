# packages/verification — rules

The verification engine (`@windkeel/verification`): **the gate**. Everything here decides whether a
change reaches a pull request, so every rule below makes verification stronger or keeps it
honest, never weaker. Terms: [CONTEXT.md](../../CONTEXT.md). General package rules:
[packages/AGENTS.md](../AGENTS.md).

| Path | What |
| --- | --- |
| `src/engine/` | Runs the stages, produces the verdict and the maker's `RepairPacket` |
| `src/stages/` | One file per stage (build, tests, review, mapping, security, …) |
| `src/evidence/` | Evidence package format, `hashes.json`, verdict, the gate |
| `src/exec/` | Where commands run; `candidate-env.ts` decides what env candidate code sees |
| `src/providers/` | Checker model clients (review, criteria mapping) |
| `src/attest/` | DSSE signing and Sigstore |
| `src/playbook-policy.ts` | The one playbook merge: strengthen-only (ADR-0033) |
| `src/secret-names.ts` | Names a customer secret may never take |

- **Zero runtime dependencies, nothing outside this package** (ADR-0005). No import from `src/`,
  `apps/` or another package, and no `dependencies` in `package.json`. `invariant:check`
  fails otherwise.
- **Nothing maker-side comes in** (ADR-0032/0033/0035/0036). No knowledge, maker instructions,
  maker screenshots, batches or guidance. The only thing the verifier takes from the maker is the
  candidate commits. `invariant:check` and `test/verification-boundary.test.js` enforce it.
- **Fresh sandbox per verification** (ADR-0004). Never reuse maker state; a restored environment
  snapshot must predate any maker (ADR-0031).
- **Candidate code sees almost no env.** `CANDIDATE_ENV_ALLOWLIST` plus the trusted
  `WINDKEEL_CHECK_ENV` opt-in, minus `NEVER_PASSED`. Every key a harness reads must be in
  `NEVER_PASSED` and `RESERVED_SECRET_KEYS`; `invariant:check` checks that against
  `src/worker/descriptor.ts`. Add to these lists; don't take away.
- **Playbooks only strengthen.** A requirement may add checks or raise thresholds, never remove
  or weaken one. The merge lives only in `playbook-policy.ts`; tests in
  `test/playbook-policy.test.js` must stay unskipped.
- **A stage that can't run says so**: skipped with a reason, never silently absent. No checker
  configured is a named outcome, not a pass.
- **The verdict is recomputable offline** from the package alone (`windkeel verify-package`). Don't
  add inputs that only exist at run time.
- **Evidence format** (`dev.orqon.evidence/vN`): a change is breaking for anyone holding old
  packages. Bump the version and keep reading the old one.
- **No source comments** (ADR-0041, `npm run lint`). Rationale goes in an ADR.
- Tests: `test/gate-isolation.test.js`, `test/verification-boundary.test.js`,
  `test/playbook-policy.test.js`, and the CLI-driven suites (`runCli` in `test/helpers.js`).
