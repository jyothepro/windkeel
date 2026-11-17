# Replayed OSS pull requests

The seeded corpus in [`bench/corpus`](../corpus) proves the gate reacts to defects we planted.
It cannot tell us whether the gate would have caught a defect *nobody* saw — the corpus author
already knew the answer when they wrote the fixture.

These cases are the other half. Each one is a real pull request that was merged into a widely
used open-source project and whose defect surfaced only afterwards, evidenced by the revert or
follow-up fix commit that backed it out. Human reviewers approved these diffs. The question the
replay puts to the gate is whether an independent reviewer, given the same diff and nothing
else, would have refused it.

## Running

```sh
node dist/cli.js replay                      # bench/replay/cases
node dist/cli.js replay --json --out /tmp/replay-packages
```

Needs network access to fetch the upstream commits, and a reviewer credential
(`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) to be more than a harness check. It is therefore
observational and does not run in CI — the deterministic corpus is the CI regression suite.

## What a case is, and what it is not

For each case the harness fetches exactly the two upstream commits named in `case.json`,
rebuilds the change as a two-commit history (base tree, then head tree), and runs the pipeline
over it. The reconstructed diff is the upstream diff; the upstream author and commit subject
carry into the package's provenance, and the commit body stands in for the PR description that
intent extraction reads.

Two limits are deliberate, and both are recorded in every package rather than assumed:

- **The upstream test suite is not re-run.** Dependencies are not installed, so the replay
  writes `windkeel.config.json` with `"checks": []`. The checks stage then records
  `no_checks_discovered` at warning status — the package says plainly that nothing was
  executed — instead of a toolchain failure reaching the same `fail` verdict a caught defect
  would. Every one of these defects passed its project's own CI anyway; that is what makes
  them interesting.
- **A replay package is not an upstream package.** Its `head_sha` names the reconstruction, not
  the upstream commit. Only the replay report ties the two together.

A case whose review stage did not run is reported as **not evaluated** and is excluded from the
catch count. An unasked question is not a caught defect.

## Cases

| Case | Upstream | Merged change | How the defect surfaced |
| --- | --- | --- | --- |
| `undici-3284-permessage-deflate` | nodejs/undici#3284 | `websocket: pre-calculated length` | Reverted in `fcfa4db6` — "broke permessage-deflate support" |
| `express-4891-sync-stack` | expressjs/express | `Fix handling very large stacks of sync middleware` | Fixed in `7ec5dd2b` after shipping in 4.18.0 |
| `axios-7257-strict-json` | axios/axios#7257 | `fix: silentJSONParsing=false should throw on invalid JSON` | Reverted two days later in `a4230f55` |

See [`RESULTS.md`](RESULTS.md) for the most recent recorded run.
