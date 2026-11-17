<!-- windkeel:run:11111111-2222-3333-4444-555555555555 -->

## Windkeel verification

```text
WINDKEEL RESULT

Task: Uploader retries are missing

Acceptance criteria       —/2
Blocking findings         not recorded
Advisory findings         0
Repair attempts           0 of 3 allowed
Residual risk             not scored (0 advisory, 0 unsatisfied)
Verdict of record         —
Overall verdict           —

Run state                 FAILED (terminal)
Stopped because           spend_cap — the run reached its spend cap
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

_(none yet)_

</details>

<details>
<summary>Repair history</summary>

### Repair history

_(none)_

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