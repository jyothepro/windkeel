# NavItem

A row in the sidebar: a run (with its live status) or a destination (*Settings*, *Repositories*).

## The consumer provides

- `nav` holding `div.oq-nav-group`s, each with an optional `div.oq-nav-group__label` (*Active*, *Recent*) and `a.oq-nav-item` rows.
- Each row: a leading `StatusDot` with `oq-status--dot-only` and `aria-label` (runs) or an `svg.oq-icon` (destinations), `span.oq-nav-item__label`, optional `span.oq-nav-item__meta` (age, count).
- `aria-current="page"` on the open one — it takes `color-bg-active`, a neutral fill. Where you are isn't something to act on, so it isn't iris.

## Don't

- Don't wrap labels; they truncate. Put the full title in `title`.
