<!-- windkeel:run:11111111-2222-3333-4444-555555555555 -->

## Windkeel verification

```text
WINDKEEL RESULT

Task: Uploader retries are missing

Acceptance criteria       1/2
Blocking findings         1
Advisory findings         1
Repair attempts           1 of 3 allowed
Residual risk             not scored (1 advisory, 1 unsatisfied)
Verdict of record         FAIL
Overall verdict           FAIL

Run state                 MAX_REPAIR_ATTEMPTS_REACHED (terminal)
Stopped because           repair_cap — the repair attempts allowed for this task's risk level were used up
Cost                      $0.6200 of $25
```

Per-stage results (tests, security, independent review, browser QA) are in the evidence package — this summary reports only what the run's own rows record, so that it stays true after a package is pruned (ADR-0015).

<details>
<summary>Acceptance criteria</summary>

### Acceptance criteria

**Stated in the issue** by its author, used verbatim.

- `AC1` — retries a 500 three times with backoff
- `AC2` — gives up after the third and reports the failure

</details>

<details>
<summary>Verification cycles</summary>

### Verification cycles

| # | candidate | verdict | evidence | |
|---|---|---|---|---|
| 1 | `aaaaaaaaaaaa` | FAIL | pruned by policy `sha256:001122334455` | superseded |
| 2 | `bbbbbbbbbbbb` | FAIL | stored `sha256:8899aabbccdd` | verdict of record |

</details>

<details>
<summary>Repair history</summary>

### Repair history

- **Attempt 1**
  - asked to fix: criteria AC2; checks npm test; findings REV-1
- **Attempt 2** — not taken; the run stopped first
  - asked to fix: criteria AC2; findings REV-2

</details>

<details>
<summary>Agent and model provenance</summary>

### Agent and model provenance

| role | worker/model | candidate | model cost |
|---|---|---|---|
| implementer | `codex/gpt-5-codex` | `aaaaaaaaaaaa` | $0.4200 |

</details>

<details>
<summary>Cost</summary>

### Cost

| model | sandbox | total |
|---|---|---|
| $0.4200 | $0.2000 | $0.6200 |

</details>

<sub>Run `11111111-2222-3333-4444-555555555555` — windkeel</sub>