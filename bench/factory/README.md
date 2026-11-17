# The factory benchmark

`windkeel bench` scores the verifier alone, over a seeded corpus. `windkeel bench-factory` scores the
**factory**: it submits whole tasks to a deployment, follows each run to the end, reads what the
factory recorded, and then runs **hidden tests** against what was delivered. The hidden tests are
ground truth that neither the maker nor the verifier ever saw, which is what makes it possible to
measure the number [ADR-0029] rests on — how often the verifier passes a change that is wrong.

It is **observational, not CI** ([ADR-0016]). A run needs a deployment, model keys, GitHub App
installations on the scratch repositories, and money. The offline parts — task validation, the
scoring, the report, the loop against a real Postgres factory with scripted agents — are covered
by `test/bench-factory*.test.js` and `test/e2e-bench-factory.test.js`, and none of them touches a
real service.

## What it reports

Per task: the run id, final state, the verifier's verdict of record and its first verdict, the
hidden tests' outcome, repair turns, cost from the ADR-0013 ledger, wall time, and the PR.

| metric | definition |
|---|---|
| `success_rate` | verdict of record `pass` **and** hidden tests pass, over tasks scored |
| `verified_false_accept_rate` | verdict `pass`, hidden tests **fail** — over verdict `pass` |
| `verified_false_reject_rate` | verdict not `pass` (fail, warn, stuck, capped), hidden tests **pass** — over those |
| `repair_conversion_rate` | first verification `fail`, verdict of record `pass` — over first `fail` |
| `cost_per_task_usd` | mean, p50, p90 of each scored task's ledger total |
| `cost_per_success_usd` | total scored cost over successes; `null` with none |
| `wall_seconds_per_task` | mean, p50, p90, submit to settled |
| `excluded` | every task left out of the scores, with the reason |

`counts` carries every numerator and denominator. A rate over an empty denominator is `0` in the
JSON and `n/a` in the text, so "no false accepts" and "nothing was accepted" never read alike.

A `warn` verdict is **not** an accept: it sends the change to a person rather than vouching for it.
A cost marked `+` is a floor: some model call had no known price ([#324]).

## Exclusions — infrastructure is not the agent getting it wrong

A task is excluded, never silently dropped, when:

- `budget:` — the run's ledger passed its `budget_usd`, whether the deployment's spend rail stopped
  it or the bench cancelled it on reading the ledger;
- `total_budget:` — what was spent plus every in-flight task's full budget plus this task's would
  pass the bench's total cap, so it was never submitted;
- `timeout:` — not settled within `timeout_minutes`; the bench cancels it;
- `infra:` — the submit failed, the run ended with no completed verification, its models could not
  be used, its criteria were never approved, or someone else cancelled it;
- `hidden_tests_not_run:` — the hidden tests could not give an answer: the clone or checkout
  failed, the head does not descend from `base_ref`, the command is missing or timed out;
- `refused:` — the task targets the factory's own repository;
- `unchecked_hidden_tests:` — before anything is submitted, a live run checks every task the way
  `--check-hidden` does; a task whose hidden tests do not fail on `base_ref` and pass on its
  known-good solution (or that cannot be checked at all) is never submitted and never scored.

Excluded tasks' spend is still in `total_cost_usd`: it was spent.

## Spend

The caps are the maintainer's decision on [#386]: **$2 per task, $50 per bench run.** Each task's
`budget_usd` is passed as the run's own spend cap and its `timeout_minutes` as its wall-clock cap
(ADR-0011 rails, enforced by the deployment); the bench also cancels a run whose ledger passes it.
The total is a reservation — a task is only submitted when its worst case still fits. `loadTasks`
refuses a task file with a budget over the per-task cap; `--task-cap-usd` / `--total-cap-usd` raise
them deliberately, on the command line, once numbers are stable.

## Honesty rules

- **Hidden tests stay hidden.** They live in `tasks/<id>/hidden/`, are copied into a throwaway
  clone after the run, and are never committed or pushed. A task whose title, description or
  criteria names a hidden test file is refused. Criteria are written from the issue text only.
- **It only reads outcomes.** It submits through the same API a person uses; every change still
  goes through the verifier. Nothing here can mark a run passed.
- **Not SWE-bench.** The upstream tasks are *SWE-bench-style* — real fixes from small, MIT-licensed
  repositories, with the upstream fix's test file as the hidden test. Never report these as
  SWE-bench numbers.
- **Hidden tests run candidate code on your machine.** The head is whatever the agent wrote. The
  command gets a scrubbed environment (no `WINDKEEL_API_TOKEN`, no model or cloud keys) and a
  throwaway `HOME`, which is a floor, not isolation — it still runs as your user: run the bench
  from a disposable VM or container. The clones before it use your own git credentials, which is
  how private scratch repositories are read.
- **Check the questions before paying for answers.** `--check-hidden` clones each task and checks
  its hidden tests fail on `base_ref` and pass on a known-good solution (`reference_patch`, or the
  upstream `fix_commit`). A task that fails the check is not a fair question.

## Tasks

`tasks/<id>/task.json` (type `FactoryBenchTask`, `packages/cli/src/commands/bench-factory.ts`):

```jsonc
{
  "id": "swe-slugify-69",
  "source": "swe-bench",                      // or "real-repo"
  "repository": "https://github.com/<owner>/bench-slugify",   // the scratch repository
  "windkeel_repository": "<owner>/bench-slugify",                // optional: as the deployment names it
  "base_ref": "<sha>",                        // the delivered head must descend from it
  "title": "…", "description": "…",           // what `windkeel submit` sends
  "acceptance_criteria": ["…"],               // appended as a "- [ ]" checklist
  "hidden_tests": { "command": "…", "files": ["test.js"], "timeout_seconds": 600 },
  "reference_patch": "reference/correct.patch",              // or upstream.fix_commit
  "upstream": { "repo": "…", "fix_commit": "…", "pull_request": "…", "license": "…" },
  "budget_usd": 2.0, "timeout_minutes": 45, "risk_level": "low"
}
```

Seeded:

| id | source | what | hidden tests checked |
|---|---|---|---|
| `swe-camelcase-112` | sindresorhus/camelcase | digits inside a word | **not yet** |
| `swe-decamelize-23` | sindresorhus/decamelize | all-caps word ending in a number | **not yet** |
| `swe-dot-prop-75` | sindresorhus/dot-prop | default value when the last segment is missing | **not yet** |
| `swe-pretty-bytes-88` | sindresorhus/pretty-bytes | integer digits rounded away | **not yet** |
| `swe-slugify-69` | sindresorhus/slugify | plural acronyms | **not yet** |
| `repo-scratch-duration-hours` | orqon-bench-scratch | hours in `formatDuration`; **the M5 demonstration task** | yes, offline in the suite |
| `repo-scratch-slug-diacritics` | orqon-bench-scratch | accents in `slugify` | yes, offline in the suite |
| `repo-scratch-csv-delimiter` | orqon-bench-scratch | a custom CSV delimiter | yes, offline in the suite |

**The five SWE-bench-style tasks are unverified**: nobody has yet run their hidden tests against
the base and the upstream fix. A live run checks them first and excludes any that do not check
out (`unchecked_hidden_tests:`), so they cannot produce a number before they are a fair question;
update this column once `--check-hidden` has passed on them.

The upstream tasks' hidden `test.js` is the upstream file at the fix commit, MIT, with the licence
beside it (`UPSTREAM-LICENSE`). Their hidden command installs the repository's dev dependencies, so
it needs the npm registry. The real-repo tasks need nothing but Node, and their hidden tests and
reference solutions are checked offline by `test/bench-factory-hidden.test.js`.

## Scratch repositories

Every task runs against a repository the GitHub App is installed on, that is **not** the Windkeel
repository, and that holds nothing the maker should not see.

**orqon-bench-scratch** (the real-repo tasks) is built deterministically from `scratch-repo/`, so
its commit SHA is the `base_ref` the tasks name (a test holds the two together):

```sh
bench/factory/seed-scratch-repo.sh /tmp/orqon-bench-scratch     # prints c5c7d8f7…
gh repo create <owner>/orqon-bench-scratch --private
git -C /tmp/orqon-bench-scratch push https://github.com/<owner>/orqon-bench-scratch.git HEAD:refs/heads/main
```

**bench-<name>** (the SWE-bench-style tasks): create a **new, empty** repository and push only the
base commit's history. **Do not use GitHub's fork button**, and do not push branches or tags: a
fork carries the upstream fix and its tests, and a maker that runs `git log --all` would find the
answer.

```sh
git clone https://github.com/sindresorhus/slugify /tmp/up-slugify
gh repo create <owner>/bench-slugify --private
git -C /tmp/up-slugify push https://github.com/<owner>/bench-slugify.git 2cc3aff7a4fc1d5159394c874cce2d0a778269a5:refs/heads/main
```

…and the same for camelcase, decamelize, dot-prop and pretty-bytes with each task's `base_ref`.
Then install the GitHub App on every scratch repository, and if your owner is not `jyothepro`,
change `repository` in the task files (or set `windkeel_repository`).

## Running it

```sh
npm run build
node packages/cli/dist/cli.js bench-factory bench/factory/tasks --dry-run      # validate, plan, spend nothing
node packages/cli/dist/cli.js bench-factory bench/factory/tasks --check-hidden # runs repo code, spends nothing

# live — a disposable machine, with the deployment's URL and an execute-scoped token:
export WINDKEEL_API_URL=https://<deployment> WINDKEEL_API_TOKEN=<token>
windkeel-admin doctor                                                             # all green first
mkdir -p /tmp/bf
node packages/cli/dist/cli.js bench-factory bench/factory/tasks --json --out /tmp/bf > /tmp/bf/stdout.json
jq '.success_rate, .verified_false_accept_rate, .cost_per_task_usd' /tmp/bf/report.json
windkeel reap --dry-run                                                           # nothing left billing
```

`--out` keeps `report.json` and each task's hidden-test result. `--only <id,…>` runs a subset;
`--concurrency <n>` runs several at once (default 1). Live runs refuse to start without
`WINDKEEL_API_URL` set explicitly — a credentials-file default is not enough to spend money on.

Record each live run in [`RESULTS.md`](RESULTS.md): the date, the deployment's commit, the maker
and checker models, the caps, the totals, and the report itself.

[ADR-0016]: ../../docs/adr/0016-local-development-hermetic-by-default.md
[ADR-0029]: ../../docs/adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md
[#324]: https://github.com/jyothepro/orqon/issues/324
[#386]: https://github.com/jyothepro/orqon/issues/386
