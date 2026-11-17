# Terminal

Shows command output — tests, builds, git — exactly as the sandbox printed it.

## The consumer provides

- `div.oq-terminal`, optionally with `div.oq-terminal__header` (a `span.oq-terminal__title` with the command or cwd, then a Badge or ghost Buttons like *Copy*), and `pre.oq-terminal__body`.
- Output as text; ANSI colors mapped to spans: `__cmd` (the command line; the `$` is added), `__ok` green, `__err` red, `__warn` amber, `__dim` gray, `__link` for paths and URLs.
- Long output clipped to the last ~200 lines with a *Show all* ghost button in the header.

## Don't

- Don't wrap lines; alignment in output matters. The body scrolls sideways.
- Don't recolor output the tool didn't color.
