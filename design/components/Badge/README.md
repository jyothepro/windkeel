# Badge

Labels a count, a state or a property: *2 passed*, *Sigstore sealed*, *draft*.

## Variants

- Intent via `data-intent`: `neutral` (default), `accent`, `agent`, `success`, `warning`, `danger`, `info`.
- `oq-badge--solid` fills with the intent's solid color. Reserve it for the single most important state in view — the verdict at the top of an evidence package.
- `oq-badge--sm` (18px) inside list rows and tabs.

## The consumer provides

- `<span class="oq-badge" data-intent="success">2 passed</span>`.
- One to three words, or a number. Lowercase unless it's a proper noun or a verdict (*Pass*, *Fail*).
- Optional leading `oq-icon`, or a `StatusDot` for live state.

## Don't

- Don't make badges clickable; use a Button or a Tab.
- Don't rely on color alone — the text must say the state.
