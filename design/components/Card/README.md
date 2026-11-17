# Card

Groups one thing on a surface — a run in a list, a settings group, a stage's detail.

## The consumer provides

- `div.oq-card` (or `a.oq-card` when the whole card opens something).
- Any of `div.oq-card__header` (an `h3.oq-card__title` and optional `span.oq-card__meta` or Badge), `div.oq-card__body`, `div.oq-card__footer` (right-aligned Buttons).

## Don't

- Don't nest cards. Inside a card, separate with spacing or a divider.
- Don't wrap the transcript or a whole panel in a card — the app shell already separates regions with borders.
- Don't add shadows to resting cards; the border is enough. `shadow-sm` is only for something being dragged.
