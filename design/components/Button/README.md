# Button

Triggers an action: sending a message, opening a pull request, stopping a run.

## Variants

| Class | When |
| --- | --- |
| `oq-button` | Default (secondary). Most buttons. |
| `oq-button oq-button--primary` | The one action the screen exists for — *Open pull request*, *Send*. One per region. |
| `oq-button oq-button--danger` | Destructive and immediate — *Stop run*, *Delete workspace*. Confirm in a Dialog unless undoable. |
| `oq-button oq-button--ghost` | Toolbar and inline actions that shouldn't compete — *Copy*, *Collapse*. |

Sizes: `--sm` (28px) in toolbars and dense rows, default 32px, `--lg` (40px) for empty-state and dialog calls to action. `--icon` makes it square; always give it `aria-label`.

## The consumer provides

- A `<button type="button">` (or `<a>` for navigation) with the classes above.
- A verb as the label: *Open pull request*, not *OK*. Sentence case.
- Optional leading icon: `<svg class="oq-icon">` before the label.
- While working: a `Spinner` in place of the icon and `aria-busy="true"`. Keep the label — don't swap it for "Loading…".
- Optional shortcut hint: `<span class="oq-button__hint">⌘↵</span>` after the label.

## Don't

- Don't put two primary buttons side by side; demote one to default.
- Don't use danger for "cancel" — cancelling is default or ghost.
- Don't color a button with a status intent to mean a result; results are Badges.
