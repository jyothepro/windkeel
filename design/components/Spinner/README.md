# Spinner

Signals waiting: a ring (`oq-spinner`) for the UI waiting on a request, three dots (`oq-thinking`) for the agent reasoning before it acts.

The two look different on purpose. The ring inherits `currentColor`, so it matches whatever it sits in (a button, a row). The dots are always the agent's cyan — they mean *the agent*, not *loading*.

## The consumer provides

- `<span class="oq-spinner" aria-hidden="true"></span>` next to a label that says what is happening; set `aria-busy="true"` on the region.
- `<span class="oq-thinking"><span class="oq-thinking__dots" aria-hidden="true"><i></i><i></i><i></i></span>Thinking</span>` — the label can name what it's thinking about (*Reading run-service.ts*).

## Don't

- Don't show a spinner without a label for more than a second.
- Don't use the thinking dots for page loads.
