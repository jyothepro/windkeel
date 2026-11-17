# Windkeel

**An independent verifier for AI-written pull requests.** Your coding agent should not grade its
own homework. Windkeel checks every change in a fresh sandbox the author cannot touch, and leaves
behind a signed evidence package that anyone can recompute.

```sh
npx windkeel verify --gate            # verify this checkout, write .windkeel/evidence, exit 1 on fail
npx windkeel verify-package .windkeel/evidence --gate   # recompute an existing package's verdict
```

In GitHub Actions, add the [two-job workflow](#in-github-actions) and every pull request gets a
verdict (`pass`, `warn` or `fail`) with the evidence attached as an artifact.

| | What it is | Where it runs | Cost |
| --- | --- | --- | --- |
| **Windkeel Gate** | The verifier: a CLI (`windkeel`, alias `windkeel`) and a GitHub Action | Your CI, your model keys, no servers | Free for personal and noncommercial use; [commercial use](COMMERCIAL.md) needs a plan or a license |
| **Windkeel factory** | A maker agent implements a task, the gate verifies it, failures go back for repair, and you get a verified draft PR | The managed service, or your own Vercel and Supabase | [Credit plans](https://console-two-gamma.vercel.app/pricing), invite-only for now |

**Links:** [How verification works](#windkeel-gate) · [The evidence package](#the-evidence-package) ·
[Running the factory](docs/running-the-factory.md) · [All docs](docs/README.md) ·
[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[Commercial use](COMMERCIAL.md)

Contributing (people or agents): [CONTRIBUTING.md](CONTRIBUTING.md) to start, then
[AGENTS.md](AGENTS.md) for the commands, repo map and conventions and [CONTEXT.md](CONTEXT.md)
for the vocabulary.

## Windkeel Gate

An agent-neutral PR gate. An independent verifier checks a pull request — whoever or
whatever authored it — and leaves behind a portable **evidence package**: what was
checked, the transcripts, the findings, provenance naming the authoring agent, and a
verdict that anyone can recompute offline.

Zero servers: `windkeel` (also installed as `windkeel`) is a CLI that runs in your own CI on your own keys.

Spec: [#14](https://github.com/jyothepro/orqon/issues/14). Built so far: the evidence
package format and CLI, the repo-checks stage, the adversarial review stage, and intent
mapping, the GitHub Action, Sigstore sealing, security scanning, and browser QA. A stage
that does not run is recorded in the package as consciously skipped with a reason, never
silently absent.

## In GitHub Actions

The pull request is **untrusted**: its checks are code it wrote, and it may have been written by
a prompt-injected agent. So the recommended setup is two jobs — one that runs the candidate's
checks and holds nothing worth stealing, and one that signs and gates and never runs the
candidate:

```yaml
permissions: { contents: read }

jobs:
  verify:                                   # runs candidate code — no id-token here
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }   # base..head; no token in .git/config
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - uses: jyothepro/windkeel@<pinned-sha>
        with:
          mode: verify
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

  seal:                                     # never checks out or runs the candidate
    needs: verify
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - uses: jyothepro/windkeel@<pinned-sha>
        with:
          mode: seal
          gate: "true"
```

`verify` uploads the package unsigned as `windkeel-evidence-unsigned`. `seal` downloads it,
re-verifies it (`windkeel sign` refuses a package whose hashes, transcript bindings or recomputed
verdict do not hold, or that is about a different commit than the PR's head), keyless-signs it
with this workflow's identity, publishes the annotations and job summary, uploads the signed
package as `windkeel-evidence`, and gates with `verify-package --require-signature` against an
**anchored** identity (`^https://github.com/OWNER/REPO/.github/workflows/`). What fails the job
is a recomputation from the artifact you can download, not the verdict a step printed.

`mode: all` (the default, and the only shape before this) still works — one job that verifies,
signs and gates — and logs a warning every run, because it puts the signing identity in the same
job as candidate code.

**What the Action does about candidate code, whatever the mode:**

- **Checks see an allowlisted environment** — `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `TERM`,
  `LANG`/`LC_*`, `TZ`, `CI` and the stage's own variables. The model keys, the runner's
  `ACTIONS_ID_TOKEN_REQUEST_*`/`ACTIONS_RUNTIME_*` tokens and the `GITHUB_ENV`/`GITHUB_PATH`/
  `GITHUB_OUTPUT` channels are not in it. A repo whose tests genuinely need a variable (a service
  container's `DATABASE_URL`) names it in the `check-env` input — set by the workflow author,
  never read from the checkout; the tokens and file-command channels above are refused even
  there. The model keys are read in-process by the reviewer/mapper and never handed to a child.
- **Checks come from the base commit**, not the PR — see [Which checks run](#which-checks-run).
- **A check cannot outlive itself easily**: each runs in its own process group, which is killed
  when it returns; the Verify step then kills any process of the job's user that did not exist
  before `verify` started, and fails if anything wrote the runner's file-command files.
- **The gate's own code is pinned**: before any candidate code runs, the Action records the
  absolute path of `node` and a digest of the node binary, cosign, and the built CLI and engine.
  Annotate, Sign and Gate re-check that digest, run node by that path under `env -i`, and refuse
  to run if anything changed.

**What a single job cannot guarantee**, and why `seal` is a separate job: everything above is a
mitigation against code running as the same Unix user — and on GitHub-hosted runners that user
has passwordless `sudo`. Such code can read another process's environment
(`/proc/<pid>/environ`), double-fork out of any process group, or replace binaries the digest
does not cover. Only a job boundary removes the OIDC token and the gate's later steps from its
reach. Even then, the `verify` job's package is produced next to candidate code: `seal` proves the
package is self-consistent and about the right commit, and signs *that*; it cannot prove a
root-capable candidate did not rewrite it consistently before upload. The model key in `verify`
is reachable the same way — give that job a key scoped and budgeted for it, and none for PRs
from forks. Finally, `pull_request` runs the workflow file as the PR has it: for a gate a PR
cannot edit away, require the workflow through a repository ruleset from a protected ref and pin
the action to a commit, not `./` or `@main`.

Windkeel gates its own PRs with this action ([`.github/workflows/windkeel-gate.yml`](.github/workflows/windkeel-gate.yml)).

## Usage

```sh
npm install && npm run build

# Verify a checkout and write an evidence package
node packages/cli/dist/cli.js verify --repo . --out .windkeel/evidence --gate

# Re-verify an existing package (recomputes hashes and verdict)
node packages/cli/dist/cli.js verify-package .windkeel/evidence --gate

# Also refuse to pass a change whose criteria nobody could settle
node packages/cli/dist/cli.js verify-package .windkeel/evidence --gate=criteria
```

Exit codes: `0` clean, `1` gating (with `--gate`), `3` integrity failure, `2` usage error.

### Gate levels

`--gate` decides what a *caller* does with a verdict. It does not change the verdict.

| flag | exits 1 on |
|---|---|
| `--gate`, `--gate=fail` | a `fail` verdict. The historical meaning, unchanged. |
| `--gate=criteria` | a `fail` verdict, **or** any criterion the evidence could not settle. |
| `--gate=warn` | anything that is not a clean `pass`. |

A criterion the evidence could not settle is `unknown`, and an `unknown` *warns* rather than
fails ([#241](https://github.com/jyothepro/orqon/issues/241)). Inside the factory that is
right: failing it would hand the repair loop a task no edit could complete, and ADR-0003
reserves `warn` for verdicts that need a person — which is what a draft pull request gets it.
A CI gate has no person, and "nobody checked whether this meets its stated criteria" is not a
thing to merge, so `--gate=criteria` stops it and **names each criterion with the mapper's
reason**.

`criteria` and `warn` are separate levels on purpose. A non-blocking finding or an incomplete
stage is a judgement somebody made; an unsettled criterion is a judgement nobody made.
Collapsing them into one flag would decide that quietly, so the flag decides it out loud.

`verify-package` separates the last two by what it was pointed at. A path that holds none
of the four spine files (`manifest.json`, `intent.json`, `mapping.json`, `verdict.json`) —
including one that does not exist or is not a directory — was never a package, so it is a
usage error (`2`). From the first spine file onwards the path *is* a package, and a missing
sibling, malformed JSON, a hash mismatch, or a bad attestation are all integrity failures
(`3`). A pipeline branching on `3` is being told the evidence is untrustworthy, never that
someone mistyped a path.

In GitHub Actions the PR number, title, body, head/base SHAs, and author identity are
read from the event payload; locally they come from git and from `--pr-body` /
`--issue-body` files.

## Which checks run

`windkeel.config.json` when present, otherwise the repo's own conventions, per ecosystem. The
gate re-runs your checks; it does not define them.

| Ecosystem | Discovered from | Checks |
| --- | --- | --- |
| npm | `package.json` scripts | `typecheck`, `lint`, `tests` |
| Go | `go.mod` | `go-build`, `go-vet`, `go-tests` |
| Python | a tool configured in `pyproject.toml`, `pytest.ini`, `setup.cfg`, `ruff.toml`/`.ruff.toml`, `mypy.ini`/`.mypy.ini` | `py-lint` (ruff), `py-typecheck` (mypy), `py-tests` (pytest) |

A polyglot repo gets the union — both trees are the repo's own. Python tools are reached
through `uv run` or `poetry run` when a `uv.lock` or `poetry.lock` says where they live, and
through `python -m` otherwise. Python discovery is deliberately conservative: a tool is
discovered only where the repo has *configured* it, never from a dependency list, a tox/nox
session, or a Makefile target — a discovered check that does not exist fails the gate over a
non-problem. Anything not covered declares `checks` explicitly, which always wins.

```json
{
  "checks": [
    { "name": "tests", "command": "pnpm test" },
    { "name": "typecheck", "command": "pnpm typecheck" }
  ]
}
```

A failing check becomes a **blocking finding**, so the verdict function alone decides the
gate.

**The checks come from the base commit, not the change.** A pull request must not choose the
checks that judge it — `{"checks":[{"name":"tests","command":"true"}]}` or `"test": "exit 0"` used
to turn the stage green. So `windkeel.config.json` and the `package.json` scripts discovery reads are
taken from the base revision (`git show <base>:<file>`). And because a package manager resolves a
script against the `package.json` on disk, when the head changes `scripts` the checks and flows
run against the head's `package.json` with the **base's `scripts` block** swapped in, restored
afterwards — so `npm test`, `npm t`, `npm run-script x -- --ci`, `pnpm x`, `yarn run x`, a script
calling `npm run other`, and `pre`/`post` hooks all resolve to the base's. (Workspace packages'
own `package.json` files are not overlaid.) If the change edits the configuration anyway, a
`check_config` evidence item says how, and that "checks ran from base":

- removing a check or flow, or switching `checks.required` off, is **blocking** — it would weaken
  every later gate once merged, so a person ratifies it rather than it riding in on a green run;
- any other edit (a command changed, a check added, any `scripts` entry changed) is **non-blocking**,
  so the verdict is `warn` and an ordinary test-script edit does not fail the PR;
- a base revision that cannot be read (a shallow clone — use `fetch-depth: 0`) is **blocking**,
  since the alternative is the head defining its own checks.

This closes the configuration bypass, not the general fact that checks execute the candidate's
code: a change can still edit the test files or the code a script calls. That is what the
adversarial review is for. Check and flow names must be plain filenames (`^[A-Za-z0-9._-]+$`,
not `.`/`..`) because they become paths in the package; a flow's `artifacts` must be a relative
path inside the checkout, and symlinks in it are not followed. A refused declaration is a
blocking finding. A caller that injects real policy (the factory's `policy`) bypasses all of this
— that override is the caller's, never the checkout's.

A repo where discovery finds **zero** checks never gates green. The stage records a
`no_checks_discovered` evidence item — warning status, with what discovery looked for and
where to declare checks — so the package verdict is `warn` and the summary says *"no repo
checks were discovered — nothing was verified by the checks stage."* That is evidence with
a reason, not a skip: "not applicable" and "this repo declared nothing verifiable" are
different claims.

Absence of checks is repo maturity rather than a defect, so warn is the default and
strictness is opt-in — `checks.required` turns the same condition into a blocking finding
and a `fail` verdict:

```json
{
  "checks": {
    "required": true,
    "commands": [{ "name": "tests", "command": "pnpm test" }]
  }
}
```

`commands` may be omitted to keep discovering checks while requiring that some exist. The
array form above stays valid and keeps the warn default, so configs written before this key
existed are unaffected.

## The adversarial reviewer

The reviewer sees the diff and the stated acceptance criteria — never the author's
transcript — and is prompted to refute the change. Blocking findings fail the gate;
non-blocking ones only warn.

Independence is enforced at the provider boundary: a provider from the same vendor as the
authoring agent is never selected. If that is the only credential available the stage
emits a blocking `F-independence` finding, rather than a review that merely looks
independent.

```sh
ANTHROPIC_API_KEY=... node packages/cli/dist/cli.js verify --repo .   # reviewer runs
node packages/cli/dist/cli.js verify --repo .                         # no key → not reviewed: verdict is at best warn
```

A change with a diff that no reviewer read is `warning` evidence (`no_reviewer_configured`, or
`diff_unavailable` when the base commit is missing from a shallow clone), never a skip: until
this was so, a run with no key passed on the repo's own checks alone — checks the candidate
controls. Only a genuinely empty diff is `skipped`.

`WINDKEEL_REVIEW_MODEL` overrides the model. `WINDKEEL_FAKE_REVIEWER` / `WINDKEEL_FAKE_MAPPER`
point at a scripted JSON response — the pipeline's single test double, which is how CI
keeps model-driven verdicts deterministic and free.

## Intent mapping

Acceptance criteria are extracted from the PR description and linked issue (checklist
items anywhere, bullets under an *Acceptance criteria* heading), then each is mapped to
the evidence that demonstrates it. **A criterion without satisfying evidence fails the
gate** — that is the check against intent that was stated but never implemented or never
tested.

Silence never satisfies a criterion: one the mapper skips, or that cites evidence absent
from the package, is recorded `unsatisfied` with the reason. With no model configured every
criterion is recorded `unknown` — nothing judged it — so the verdict is at best `warn`, and
`--gate=criteria` names each one. (It used to be recorded without gating at all, so a run with
no key passed with criteria nobody had looked at.)

A criterion the evidence neither demonstrates nor refutes is `unknown`, which is not a softer
`unsatisfied`: it is a claim about the *evidence*, and it warns rather than failing so the
change reaches a person. Run it under [`--gate=criteria`](#gate-levels) when the caller is CI
and there is no person to reach.

### Criteria that need something to be run

*"The documented command works from a clean checkout."* *"The script exits 0."* These can only
be settled by **running** something, and the verifier runs exactly one set of commands: the
checks the repository declares in its own `windkeel.config.json`. It does not run a command taken
from a criterion — a criterion is author prose on a GitHub issue, and executing it would let
anyone who can file an issue run a command inside the verifier sandbox, which holds a
`contents: read` token (ADR-0014 §2) and sits inside the phased egress boundary (ADR-0014 §3).

So the mapper is shown the commands that actually ran, with their exit codes, and a criterion
naming one of them is settled by citing it:

```
COMMANDS THIS VERIFICATION EXECUTED (the repository's own declared checks — the only
commands that ran, and the only execution evidence that exists):
- ev-01: `npm test` — declared as "tests", exited 0 (passed)
```

A criterion that names none of them stays `unknown` — **this class remains undemonstrable by
design** — but its reason now says why and what to do instead: declare the command as a check
and restate the criterion in terms of it, or restate it as an outcome the evidence can show.
The criteria generator is steered away from writing one in the first place.

For a local branch with no PR to read, supply intent yourself:

```sh
node packages/cli/dist/cli.js verify --intent ./acceptance.md    # markdown, parsed like a PR body
node packages/cli/dist/cli.js verify --intent ./intent.json      # {"criteria": [{"id": "AC1", "text": "..."}]}
```

## Security scanning

`gitleaks` (secrets), `osv-scanner` (dependency advisories), and `semgrep` (dangerous
patterns) are run when present on the runner. Findings are normalised into the same
`findings` shape as everything else, so severity alone decides the verdict:

| scanner | blocking | advisory |
| --- | --- | --- |
| gitleaks | every hit — a committed credential is compromised regardless of the rest of the diff | — |
| osv-scanner | `CRITICAL`, `HIGH` | everything below |
| semgrep | `ERROR` | `WARNING`, `INFO` |

A scanner that is not installed is **named in the evidence and the stage warns** — it never
passes quietly, because "no findings" and "nobody looked" are different claims. With none
of the three available the stage is `skipped` with the reason. Presence is probed the way
each tool actually answers (`gitleaks version`, `--version` for the rest). The same applies
to a scanner that starts and cannot finish: no parseable report plus a failing exit is
recorded as **not run**, with the tool's own last words, never as a clean scan.

The scanners' configuration is the Gate's, never the scanned tree's: the change under review is
the head checkout, so a `.gitleaks.toml`, `.gitleaksignore`, `osv-scanner.toml` or
`.semgrepignore` in it would otherwise decide what its own scan may report. gitleaks runs its
built-in ruleset with an empty ignore list, osv-scanner an empty config, and semgrep its default
ignore list. A repository's own copies of those files are not consulted. Inline suppressions
(`gitleaks:allow`, `nosemgrep`) are still honoured and show up in the diff the reviewer reads.
Ignoring `.semgrepignore` needs semgrep's `--x-semgrepignore-filename`, which the pinned 1.177.0
has; an older semgrep on a CLI runner refuses the option and is recorded as not run.

In a factory verification the three are installed into the sandbox on every run, pinned to a
version *and* a sha256 — a release asset is mutable in practice, and a gate that installs
whatever arrives is a gate whose findings are worth what that download was worth. Two of them
also need data (`osv-scanner` queries `api.osv.dev`, `semgrep --config p/ci` fetches its
ruleset), which is fetched during the install phase while egress still reaches those hosts, so
the scan itself runs entirely offline. The cost — roughly 40 s and ~600 MB of sandbox disk,
paid on every verification because ADR-0004's sandbox is fresh — is measured per run and
recorded in the evidence; `WINDKEEL_INSTALL_SCANNERS=0` turns it off.

Both installs happen only where "into the sandbox" means something. A provider declares
`capabilities.isolatedFilesystem`, and the local `FakeSandboxProvider` declares it `false` —
it runs commands through `spawnSync` on the machine hosting the factory, so installing there
would put `gitleaks` in your own `/usr/local/bin` rather than in a sandbox, and destroying the
handle would not take it back. When it is false both installers run nothing and report that
they ran nothing, so a local run still says which scanner is absent instead of implying it
looked.

## System tools a repo's checks need

A repo whose tests shell out to a binary the image does not carry declares it, and the
verifier installs it during the install phase, before any check runs:

```json
{
  "tools": ["restic", { "package": "ffmpeg", "reason": "the encoder tests shell out to it" }]
}
```

Entries are **package names** for the image's own package manager (detected at run time —
`dnf`, `apt-get`, `apk`…), never URLs or commands: an entry must match
`^[a-z0-9][a-z0-9+._-]{0,63}$`, every install is argv-style rather than a shell string, and at
most eight are accepted. Anything else is *refused and reported*, never silently dropped.

A declared tool that could not be installed is a **blocking finding**, not a skipped check: the
gate has no evidence either way about code whose check could not run, so it blocks rather than
passing on an unknown. A scanner the *verifier* could not install is non-blocking and warns —
that one is the gate's own equipment, and it is not the candidate's fault.

The declaration comes from the repo under verification, so what it can cause is worth stating:
it can have the image's package manager install any package the image's archives carry, and a
distro package's maintainer scripts run as root — so a hostile config can get root **inside
that one sandbox**. That sandbox holds no model API key (ADR-0014 §1), its git token is
`contents: read` (§2), it is fresh per verification and destroyed after (ADR-0004), and its
egress narrows to the brokered model domain before any repo command runs (§3). It cannot name
a URL, run a command, reach a host off the install-phase allowlist, or change which scanners
the engine installs.

## Browser QA

Windkeel replays the UI journeys the repo declares; it does not invent them. A repo with no
`flows` is not a UI repo, and the stage is skipped with that reason rather than reporting
a clean UI run nobody performed.

```json
{
  "flows": [
    { "name": "checkout", "command": "npx playwright test tests/checkout.spec.ts",
      "artifacts": "test-results" }
  ]
}
```

A flow that fails is a blocking finding; one that passes while logging console errors
warns. Screenshots, traces, and console logs are copied into the package and hashed like
everything else — so a doctored screenshot fails `verify-package`. Anything over 5 MB is
recorded by digest only (`included: false`), keeping packages portable without letting the
evidence become unfalsifiable.

Every artifact digest is recomputed **when the artifact is present**, against the digest
the evidence item claims for it — so re-`seal`ing a package around a doctored screenshot
does not launder it, and an `included` artifact that has gone missing is an integrity
failure rather than a silent gap.

A flow is any command whose exit code and emitted artifacts the stage records; nothing
requires it to be Playwright. The corpus uses that to exercise the whole stage
hermetically — small deterministic scripts, no browser install, no network.

## Benchmark

Detection power is measured, not asserted. `windkeel bench` replays a corpus of cases — each a
two-commit checkout with a seeded defect or a deliberately clean change — through the real
pipeline and scores it:

```
$ node packages/cli/dist/cli.js bench bench/corpus
  ok   01-failing-test-seeded       seeded  expected fail, got fail (checks)
  ok   03-logic-bug-review          seeded  expected fail, got fail (review)
  ok   09-broken-ui-flow            seeded  expected fail, got fail (browser)
  ok   13-clean-reviewed-change     clean   expected pass, got pass
  ...

defect categories planted:
  ok   broken-ui-flow       1/1 caught
  ok   dangerous-pattern    1/1 caught
  ok   dependency           1/1 caught
  ok   intent-mismatch      1/1 caught
  ok   logic-bug            1/1 caught
  ok   repo-checks          1/1 caught
  ok   secret               1/1 caught
  ok   weakened-tests       1/1 caught

catch rate:           100.0%  (seeded defects that fail the gate)
false positive rate:  0.0%  (clean changes wrongly failed, over 5 control(s))
evidence completeness:42.3%  (stages producing evidence, not skips)
```

Thirteen cases: eight seeded defects, one per class the spec names, and five clean controls
spread across the review, security, browser, and intent stages. The per-category breakdown
is there so a headline "100% caught" cannot hide "of the one thing we planted".

The review cases are the ones worth reading: in `03-logic-bug-review` and
`05-weakened-tests` the repo's own checks **pass**. A boundary bug in a branch the tests
never reach, and a refactor that drops a validation branch along with the assertions
guarding it, are exactly the changes CI reports as green — the gate fails them on the
reviewer's blocking findings. `13-clean-reviewed-change` is the control on the other side:
the reviewer runs and returns nothing, so the plumbing cannot pass by manufacturing
findings out of a legitimate change.

Model-backed stages and the security scanners are scripted per case (`env` in `case.json`),
so scores are reproducible without API keys or installed scanners. `--min-catch` /
`--max-false-positive` turn the corpus into a gate: CI runs it on every PR, because a
regression in detection power is otherwise silent — the gate keeps passing PRs while
catching less. Completeness is deliberately reported unweighted: most corpus repos declare
no browser flows and the runner has no real scanners, and the score says so rather than
hiding it.

A case may declare the external tools it genuinely needs (`"requires": ["gitleaks"]`).
Where a tool is absent, the case is reported **unscored** rather than counted as a missed
defect — nobody looked, so nothing was missed — and the report says how much smaller the
corpus just got. `--require-tools` makes that an error instead, which is how CI refuses to
score a corpus it could not run in full. The shipped corpus scripts every scanner
boundary, so it requires none.

### Replayed OSS pull requests

The corpus proves the gate reacts to defects we planted, knowing the answer in advance.
[`windkeel replay`](bench/replay) asks the harder question against real merged pull requests
whose defects surfaced only afterwards — evidenced by the revert that backed each one out.
It needs network access and a reviewer credential, so it is observational and runs outside
CI. A case whose review stage did not run is reported as *not evaluated* and excluded from
the catch count: an unasked question is not a caught defect. Replays never run inside
`windkeel bench` either: a `kind: "replay"` case in the corpus is reported unscored rather
than cloned over the network — the bench run stays the hermetic regression suite CI
depends on.

**Evaluated for the first time on 2026-09-22** (`claude-sonnet-5`): **all three gates said
`fail`, and two of the three named the defect that actually reached users** — undici's
`#fragmentsBytes` never incremented in the decompression branch, and express's sync-stack guard
placed after `idx++` so the fetched layer is dropped. The third refused the axios change for a
different real reason (an added regression test the project's test commands never run), which is
a defensible block and not the defect the revert was about.

That distinction is the point: `caught` in the report means the gate returned `fail`, not that
the diagnosis was right. Read [`bench/replay/RESULTS.md`](bench/replay/RESULTS.md) for the run
verbatim, including the two cases that first came back as errors and why.

## The evidence package

Format `dev.orqon.evidence/v0` — a browsable directory, not a single file:

```
manifest.json      subject (repo, PR, SHAs, author provenance) + refs
intent.json        acceptance criteria with their sources
mapping.json       criterion → evidence, with a reason per criterion
verdict.json       computed, never hand-set
evidence/          per-stage evidence JSON + transcripts
hashes.json        sha256 of every file
attestation/       in-toto Statement in a DSSE envelope over sha256(hashes.json)
```

**The verdict is a pure function of the package:** `fail` iff any blocking finding or any
unsatisfied criterion; else `warn` iff any warning-status evidence or non-blocking
finding; else `pass`. `verify-package` recomputes it — a package whose stored verdict
disagrees with the recomputation is detectably tampered and exits 3.

**Transcripts are bound to the evidence that cites them.** Every evidence item carries the
sha256 of its transcript, and stages that run commands end each transcript with a producer
trailer — `--- orqon exit:<code> ---`. `verify-package` recomputes the digest and reads the
trailer back, cross-checking it against the item's recorded exit code and against status
coherence (exit 0 never sits under a `failed` item, a non-zero exit never under any other).
Swapping transcripts between items, editing one to agree with a doctored status, or
flipping a status and re-`seal`ing all fail as integrity errors, naming the incoherent item.

The honest residual: a rewrite that is consistent *everywhere* — evidence, transcript,
trailer, digest, verdict — and then re-`seal`ed still verifies on an **unsigned local**
package. That is by design. Sealing is not a signature; CI packages are Sigstore-signed and
that is the actual tamper boundary. What the bindings buy is that a partial rewrite — the
realistic one — no longer passes. A caller that needs the boundary itself enforced can pass
`--require-signature`, which turns "unsigned" from a note into an integrity failure.

Packages produced before the bindings existed (tool version < 0.2.0) are verified without
them: a digest is checked when present and never demanded, so older packages stay
verifiable.

## Signing

In CI the package is keyless-signed with Sigstore (GitHub OIDC → Fulcio → Rekor) over the
DSSE envelope, which covers `sha256(hashes.json)`, which covers every file — one signature
binds the whole package. The bundle lands at `attestation/bundle.sigstore.json` and is a
standard Sigstore bundle, so `cosign verify-blob` alone is enough; Windkeel is not needed to
check Windkeel's output.

Verification is offline — the bundle carries the Fulcio certificate and the Rekor
inclusion proof:

```sh
node packages/cli/dist/cli.js verify-package ./pkg --certificate-github-repo OWNER/REPO
# the same, spelled out:
node packages/cli/dist/cli.js verify-package ./pkg \
  --certificate-identity '^https://github\.com/OWNER/REPO/\.github/workflows/' \
  --certificate-oidc-issuer '^https://token\.actions\.githubusercontent\.com$'
```

cosign matches these regexes **unanchored**, so `https://github.com/OWNER/REPO` alone is
satisfied by a sibling repository whose name merely starts with yours (`OWNER/REPO-evil`) —
which anyone can create. `--certificate-github-repo` builds the anchored pair for you;
`verify-package` also anchors any identity or issuer regex at the start (`^`) before handing it
to cosign, but only you can anchor the end.

Without an expected signer the bundle is reported as unchecked rather than verified — any
Sigstore identity would satisfy an unconstrained check. A bundle that is present and
*fails* to verify is an integrity failure (exit 3).

**Packages from the deployed factory are unsigned.** That is a decision, not a fault
([ADR-0022](docs/adr/0022-evidence-package-signing-stays-best-effort-and-says-so.md)):
Fulcio's public-good instance does not list Vercel's OIDC issuer among the identities it
will certify, so a deployed run has no keyless path — and under single-tenancy the only
consumer of a verdict is the operator who already owns the store it came from, so what is
missing is provenance rather than integrity. The DSSE envelope still covers every file, and
`verify-package` still checks that chain. Both report surfaces say `unsigned` when it is
true, so nobody has to infer it from a missing bundle. ADR-0022 records what would change
the answer.

`--require-signature` turns "unsigned" and "signed but unchecked" from notes into integrity
failures, for callers that need to know who produced a package rather than only that it is
self-consistent. The action passes it whenever `sign` is on, so a package that silently went
unsigned — missing cosign, missing `id-token: write` — fails the gate instead of passing.

`seal` refuses to rewrite an attestation that an existing bundle signs, since the result
would look signed while attesting to a statement no longer in the package. Pass `--sign` to
re-sign, or `--force` to accept the stale bundle.

## Tests

The CLI boundary is the only test seam: tests invoke `windkeel` against fixture repos and
crafted packages and assert on the spine files, the recomputed verdict, and the exit
code — never on internal modules.

```sh
npm test
```

Tests that need a real Postgres (the factory schema, migration runner, run service, cost
ledger, and metrics views) are skipped unless `TEST_DATABASE_URL` is set — see
[Local development](#local-development) below.

### What the files share, and how a violation announces itself

`node --test test/*.test.js` runs files **concurrently**, in separate processes. They share a
Postgres server, a `/tmp`, and — for the seven suites that drive the real workflow backing — a
process-global queue transport. A red CI is only worth reading if interference cannot produce
one, so each of those is claimed explicitly rather than by convention:

- **Postgres** is isolated by schema, named per process and per case. `test/suite-isolation.test.js`
  fails the build if a suite creates a schema it cannot drop on the failure path, or names one
  that two concurrent files could collide on.
- **The workflow transport** (`WORKFLOW_LOCAL_BASE_URL`) is never left unset. Importing
  `test/workflow-runtime.js` points it at a refusal server that answers every request with a 503
  naming the problem, and `workflowRuntime()` / `closeWorkflowRuntime()` claim and release it.
  Left unset, `@workflow/world-local` resolves the queue by scanning the process's own listening
  ports and posting to whichever answers — which surfaced as `Unable to resolve base URL for
  workflow queue` in one suite and repeated `TypeError: fetch failed` in another, neither naming
  the cause.
- **The World store** is `.workflow-test-data-<pid>`, fixed at module import, because the
  library default is a single repo-root directory that the first suite to finish wipes.
- **The ingress build tree** is `WINDKEEL_VERCEL_OUTPUT_DIR`, per caller; the builder deletes its
  output directory on its first line.

The rule these follow: if two suites cannot share something, the failure must say so — not
present as a timeout in a third file.

## Ways to start work

Beyond the gate, Windkeel runs as a factory: work described somewhere becomes a task, a maker agent
implements it, a verifier from another vendor checks it, and the result is a verified draft PR.

It is becoming an integrated coding assistant in the cloud
([ADR-0029](docs/adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md),
proposed; [plan](docs/roadmap-integrated-assistant.md)). In the console you pick the agent and
model, watch the session live, take over in a workspace of your own and hand back, and merge as
yourself. Whoever writes a change — the agent, you, or both — it reaches the pull request only
through an independent verification in a fresh sandbox.

Work can reach it from eight places (Milestone 8, plus the console):

| From | Do this | You hear back |
| --- | --- | --- |
| The console | Describe the change in *New task* (agent, model and mode pickers are planned, ADR-0029) | The run page: live activity, the diff, evidence, then the draft PR |
| GitHub | Label an issue `windkeel` | Comments on the issue, then the draft PR |
| Slack | `/windkeel <title> -- <criteria>` or `@Windkeel …` in a mapped channel | A thread: started, then the PR link |
| Linear | Label an issue `windkeel` | Comments on the issue with the run and the PR link |
| Jira | Label an issue `windkeel` | Comments on the issue with the run and the PR link |
| Any system | `POST` a signed body to `/api/intake/webhook/{endpointId}` | `202` with the task and run ids |
| A script or CI | `windkeel submit …` or `POST /v1/tasks` (send `Idempotency-Key` to make retries safe) | `202`; follow the run with `windkeel watch` |
| A schedule | `windkeel schedule create --cron "0 9 * * mon" …` | A task per slot, as its own system actor |

Setup, environment variables and — before connecting anything — who can start work from each
source: [docs/integrations.md](docs/integrations.md). Endpoints:
[docs/control-plane-api.md](docs/control-plane-api.md).

## Local development

The factory (Milestone 1+) needs Postgres and S3-compatible object storage. Per
[ADR-0016](docs/adr/0016-local-development-hermetic-by-default.md), local dev is
hermetic by default:

```sh
docker compose up -d
cp .env.example .env
```

This starts Postgres and MinIO, creates the `evidence` bucket, and applies
`migrations/*.sql` via the same runner (`npm run db:migrate`) production uses — a fresh
clone reaches a working schema in one command. Point `TEST_DATABASE_URL` at the same
Postgres to run the database-backed tests:

```sh
export TEST_DATABASE_URL=postgresql://windkeel:windkeel@localhost:5432/windkeel
npm test
```

Real Vercel Sandbox, real webhooks (via a tunnel), and real model keys are opt-in
escape hatches for the cases that need them — see the ADR for the full picture.

## License

Windkeel is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE): free
for personal, research and other noncommercial use. Commercial use needs a paid plan on the
managed service or a commercial license; see [COMMERCIAL.md](COMMERCIAL.md).
