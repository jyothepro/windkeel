# SegmentedControl

Picks one of two to four options that change how the same content is shown — *Unified / Split* diff, *Light / Dark / System* theme.

## The consumer provides

- `div.oq-segmented[role=group]` with an `aria-label`, holding `button.oq-segmented__item` with `aria-pressed`; exactly one pressed.
- Short labels (one word) or an icon plus `aria-label`.

## Don't

- Don't use it for navigation between different content; that's Tabs.
- Don't use it for more than four options; use a select.
