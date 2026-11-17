# AgentStep

One action the agent took — read a file, ran a command, edited, searched — collapsed to a line, expandable to its output.

| `data-state` | Looks | Means |
| --- | --- | --- |
| `done` (default) | quiet gray row | Finished; output behind the chevron. |
| `running` | cyan fill, spinner | Happening now. Only one step is running at a time. |
| `failed` | red icon and verb | The tool errored (not the same as a test failing inside it). |
| `waiting` | dashed amber border | Needs a person's approval before it runs. |

## The consumer provides

- `details.oq-step[data-state]` with `summary.oq-step__summary` containing: an `svg.oq-icon` for the tool (or a `Spinner` while running), `span.oq-step__verb` (*read*, *run*, *edit*, *search* — lowercase, one word), `span.oq-step__target` (the path or command), optional `span.oq-step__meta` (duration, line counts), and `svg.oq-step__chevron`.
- Optional `div.oq-step__detail` with the output — usually a `Terminal` or `DiffView`. Without it the chevron hides.
- Consecutive quiet steps (several reads) may be grouped by the app into one row: *read 4 files*.

## Don't

- Don't paraphrase the target; show the real path or command so it can be copied.
