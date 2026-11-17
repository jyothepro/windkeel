# Tabs

Switches between views of the same object — a run's *Transcript*, *Changes* and *Evidence*.

## The consumer provides

- `div.oq-tabs[role=tablist]` containing `button.oq-tab[role=tab]`, exactly one with `aria-selected="true"`, each with `aria-controls` naming its panel.
- Arrow-key navigation between tabs (roving `tabindex`).
- **When the tab belongs in the URL** (a run's `?tab=cost`, so it survives reload and can be shared): `nav.oq-tabs` with an `aria-label`, holding `a.oq-tab` links, exactly one with `aria-current="page"`. No `role="tab"` — a link that navigates is not a tab widget, and Tab/Shift-Tab move between links as usual. Looks identical.
- Optional count: a small Badge after the label (`oq-badge oq-badge--sm`), or, quieter, `span.oq-tab__count`.
- `oq-tabs--pills` draws the same tabs as rounded chips with no rule under them — for a page's top-level views (*Needs you 2 · In progress 3 · All 8*). The selected one is neutral, like the selected nav row.

## Don't

- Don't use tabs for filters that combine; use a SegmentedControl or chips.
- Don't exceed ~6 tabs; the row scrolls, but nobody scrolls tabs.
