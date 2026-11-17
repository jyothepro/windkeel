# Toast

Confirms something the person just did — *Pull request opened*, *Link copied* — and gets out of the way.

## The consumer provides

- A fixed `div.oq-toast-region` with `aria-live="polite"`, bottom-right; toasts stack inside it.
- Each `div.oq-toast` with optional `data-intent` (colors only the icon), an `svg.oq-icon`, `span.oq-toast__text`, and optionally one ghost `oq-button--sm` action (*View*, *Undo*).
- Dismissal after ~5s, paused while hovered or focused.

## Don't

- Don't put errors that need action in a toast; they disappear. Use a Banner.
- Don't write *Success!* — say what happened, in past tense.
