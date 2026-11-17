# StatusDot

Shows the verdict of a run or a stage — pass, warn, fail, skipped, running — as a small mark and its word. In run lists it can instead show where a run is: queued, or waiting on you.

These are the evidence package's own verdicts, so the words are fixed: use them as written.

| `data-verdict` | Mark | Means |
| --- | --- | --- |
| `pass` | green circle | The stage ran and its checks held. |
| `fail` | red square | The stage ran and found a blocking problem. |
| `warn` | amber circle | Nothing blocks, but something could not be settled: a non-blocking finding, a warning, or a criterion the evidence could not decide. |
| `skipped` | hollow gray circle | Consciously not run, with a recorded reason. |
| `running` | pulsing cyan circle | The agent is on it now. |

Green and red have the same lightness, so the marks differ in **shape** as well (circle vs square), and the word is always there.

## Run marks

A run that has no verdict yet still needs a mark in a list. These go on `data-run`, not `data-verdict`, because they are not verdicts: they say where the run is.

| `data-run` | Mark | Means |
| --- | --- | --- |
| `queued` | dashed gray ring | Accepted, not started. Nothing is working on it, so it must not be cyan. |
| `waiting` | amber ring with a center dot | Stopped until a person acts: criteria to approve, a pull request to review, a block to clear. |

A live run with neither is `data-verdict="running"`.

## The consumer provides

- `<span class="oq-status" data-verdict="pass">pass</span>` — the text is the verdict or a short result (*1 unmet*).
- For a dot with no visible word (dense nav rows), add `oq-status--dot-only` and put the verdict in `aria-label` or visually hidden text.

## Don't

- Don't invent new verdicts. A new state belongs in the evidence format first.
- Don't use a run mark on a stage, or next to a verdict it could be mistaken for.
