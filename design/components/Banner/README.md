# Banner

States something about the region it sits in that the reader should know before going on — an unmet criterion, a stage that needs a person, a base branch that's red.

## The consumer provides

- `div.oq-banner` with `data-intent` (`info` default, `success`, `warning`, `danger`, `agent`) and `role="status"` (or `role="alert"` for danger that just appeared).
- Children in order: an `svg.oq-icon` matching the intent, a text block with `strong.oq-banner__title` and `p.oq-banner__body`, then optional `div.oq-banner__actions` with at most two small Buttons.
- A title that states the fact (*Criterion can't be satisfied*) and a body that says what happens next or what to do.

## Don't

- Don't stack banners; merge them or move the lesser one into the content.
- Don't use a banner for transient confirmation (*Saved*) — that's a Toast.
