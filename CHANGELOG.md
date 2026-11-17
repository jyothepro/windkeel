# Changelog

All notable changes to the `windkeel` CLI, the GitHub Action and the verification engine.
The factory and the managed service are versioned by deployment, not here.

## 0.2.0 — first public release

The first release published to npm as `windkeel`, under the PolyForm Noncommercial License
1.0.0: free for noncommercial use, with commercial use by paid plan or license (COMMERCIAL.md). The command is `windkeel`; `windkeel` is kept as an
alias so existing scripts and workflows keep working.

### The gate

- `windkeel verify` runs the verification pipeline against a checkout and writes a portable
  evidence package: what was checked, transcripts, findings, provenance naming the authoring
  agent, and a verdict anyone can recompute offline.
- `windkeel verify-package` recomputes hashes and the verdict for an existing package, and checks
  its Sigstore bundle offline against an anchored signer identity.
- Gate levels: `--gate` (fail on `fail`), `--gate=criteria` (also fail on any criterion the
  evidence could not settle), `--gate=warn` (anything short of a clean pass).
- Stages: repo checks discovered per ecosystem (npm, Go, Python and more, or `windkeel.config.json`),
  adversarial review, intent mapping of acceptance criteria, security scanning, and browser QA.
  A stage that does not run is recorded as skipped with a reason.

### The GitHub Action

- Two-job setup: `mode: verify` runs the candidate's checks with no signing identity, and
  `mode: seal` re-verifies, keyless-signs and gates without ever running candidate code.
- Checks see an allowlisted environment, come from the base commit, run in their own process
  groups, and the gate's own binaries are digest-pinned before candidate code runs.

### Against a Windkeel factory

- `windkeel login`, `submit`, `watch`, `show`, `runs`, `usage` and the operator commands drive a
  deployed factory from a terminal, CI, or a coding agent.
