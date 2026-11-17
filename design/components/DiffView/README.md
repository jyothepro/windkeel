# DiffView

Shows what the agent changed in one file, as a unified diff with line numbers.

## The consumer provides

- `div.oq-diff` with `div.oq-diff__header` (`span.oq-diff__path`, then `span.oq-diff__stat-add` *+12* and `span.oq-diff__stat-remove` *−3*) and `div.oq-diff__body` holding `table.oq-diff__table`.
- One `tr` per line: `td.oq-diff__num` (old), `td.oq-diff__num` (new), `td.oq-diff__code`. Rows take `oq-diff__row--add`, `--remove` or `--hunk` (the `@@` line, one `td colspan=3`). The `+`/`−` sign is drawn for you — don't include it in the text.
- Word-level changes wrapped in `mark`.
- Syntax highlighting is optional and must use the text colors only; the add/remove backgrounds stay.

## Don't

- Don't use red/green for anything else near a diff; they mean removed/added here.
