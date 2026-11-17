# packages/ — rules

| Package | What |
| --- | --- |
| `verification/` (`@windkeel/verification`) | The verification engine: stages, evidence package, verdict, attestation |
| `cli/` (`windkeel`, published; also installs `windkeel`) | The command line: local gate (`verify`, `verify-package`, `sign`) and factory client (`submit`, `watch`, …) |
| `api-contract/` (`@windkeel/api-contract`) | Types for the control-plane API, shared by ingress, console and CLI |

- **verification is the gate.** It imports nothing from `src/` (the factory) and nothing
  maker-side. The verdict is a pure function of the package and must stay recomputable offline
  (`verify-package`). Don't add inputs that only exist at run time.
- A stage that cannot run records itself as skipped **with a reason**; never silently absent.
- Evidence format changes (`dev.orqon.evidence/vN`) are breaking for anyone holding old packages:
  bump the version and keep reading the old one.
- **One API contract.** New endpoint types go in `api-contract`, then are imported by
  `apps/ingress`, `apps/console/lib` and `packages/cli`. `apps/console/lib/types.ts` may declare at
  most 10 local API types (`npm run arch:check`).
- The CLI is public: keep flags and exit codes backward-compatible, and update `README.md` usage.
- Tests drive the CLI binary (`test/helpers.js` `runCli`), not internal modules.
