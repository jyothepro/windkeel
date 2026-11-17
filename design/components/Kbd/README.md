# Kbd

Shows one key of a keyboard shortcut, in menus, tooltips and empty states.

## The consumer provides

- One `<kbd class="oq-kbd">` per key; put combinations side by side with a thin gap (`oq-row` with `--gap: var(--space-0_5)`), no `+` between them.
- Mac glyphs (⌘ ⌥ ⇧ ↵) on macOS, words (Ctrl, Alt) elsewhere.

## Don't

- Don't use it for code or values — that's inline `code`.
