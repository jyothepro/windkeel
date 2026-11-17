# Formal models

TLA+ models of Windkeel's design, checked exhaustively by the TLC model checker.

| Model | What it proves (within its bounds) |
| --- | --- |
| [RunLifecycle.tla](RunLifecycle.tla) | A run's lifecycle with the verifier gate, bounded repairs, stalled executions and the stalled-run sweep |
| [CreditLedger.tla](CreditLedger.tla) | One credit account: billed overage never passes the cap, compute is rounded once per run, steps start only when admitted and always finish, verification always finishes |

Run: `npm run formal:check` (needs Java 11+; downloads the pinned `tla2tools.jar` once into
`~/.cache/windkeel-tla`). CI runs it in the `formal` job.

## RunLifecycle

Checked with `MaxRepairs = 2`, `MaxReclaims = 2` ([RunLifecycle.cfg](RunLifecycle.cfg)).

Safety (every reachable state):

- `NoPRWithoutPass`: no PR exists, and nothing is merged, unless the verifier passed the code as it
  stands. New code (re-entering `VERIFYING`) voids the old verdict.
- `CompletedWasVerified`: a merged run was verified at least once.
- `RepairsBounded`, `BlockedRemembers`, `ExecutionsOnlyDriveDrivenStates`.
- `StepsAreLegal`: every step obeys the transition table. `TerminalIsAbsorbing`.

Liveness (with fair scheduling, once people stop acting):

- `EventuallyQuiet`: every run ends terminal, waiting on a person, or with no execution left.

### Tying the model to the code

- [test/formal-model-sync.test.js](../test/formal-model-sync.test.js) parses the model's transition
  table and compares it with `isLegalTransition` for every `(from, to, blockedFrom)`. Change one
  without the other and the test fails.
- [test/run-state-machine.property.test.js](../test/run-state-machine.property.test.js) checks the
  same safety properties on the real code with random traces (fast-check).

### Known gap: `NoRunStranded`

[RunLifecycle.stranded.cfg](RunLifecycle.stranded.cfg) checks the stronger property that a run the
factory drives is never left with no execution. It does **not** hold: when the step at `CREATED`
or `PR_READY` stalls more than `MaxReclaims` times, the sweep finishes the binding but `FAILED` is
not legal from those states, so the run stays put with nothing driving it. `CREATED` is picked up by
the stranded-created-runs sweep; `PR_READY` is not. This config is not in CI; run it by hand:

```sh
cd formal && java -cp ~/.cache/windkeel-tla/tla2tools-1.8.0.jar tlc2.TLC -deadlock -config RunLifecycle.stranded.cfg RunLifecycle.tla
```

## CreditLedger

ADR-0040 as amended by #439. Checked with 2 prepaid credits, caps 0–3, charges of 1–2 and at most 5
of them, 2 ticks a second ([CreditLedger.cfg](CreditLedger.cfg)). An admin can turn overage on or
off and set any cap at any moment.

Safety:

- `BilledWithinCap`: billed overage never exceeds the highest cap ever set; `NeverBillsPastTheCapInForce`:
  no charge bills more than the cap in force leaves.
- `SpendIsConserved`: everything spent is prepaid credit, billed overage or unbilled overage.
- `RoundedOnce`: a run's billed seconds are always one ceiling of its total time, however it was split.
- `StepsStartOnlyWhenAdmitted`.

Liveness: `StepsAlwaysFinish` (a step under way is never stopped for credits) and
`VerificationAlwaysFinishes`.

Mutants each fail it (2026-11-09): billing overage without the clamp breaks `BilledWithinCap`;
rounding per charge breaks `RoundedOnce`; ending a step only while admitted breaks `StepsAlwaysFinish`.

[test/credit-ledger-properties.test.js](../test/credit-ledger-properties.test.js) holds the model's
clamp and rounding to the code (`billableOverageMicro`, `priceCostLines`) on the model's domain, and
checks the same invariants on the real functions with generated and enumerated inputs.

## Adding a model

Put `X.tla` and `X.cfg` here, add them to `MODELS` in `scripts/formal-check.mjs`, and add a sync test
for any table the model copies from the code.
