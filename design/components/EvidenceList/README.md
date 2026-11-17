# EvidenceList

Summarizes an evidence package: the overall verdict, each stage with its own verdict, and the facts that make it checkable (author, verifier, digest).

## The consumer provides

- `section.oq-evidence` with `div.oq-evidence__header` (`h2.oq-evidence__title` and the overall verdict as a solid Badge — or an agent Badge with a StatusDot while verifying).
- `ol.oq-evidence__list` in the package's stage order; each `li > a.oq-evidence__stage` with a `StatusDot` (`--dot-only`), the stage name, and `span.oq-evidence__result` — the verdict word or a short result (*1 unmet*, *3 findings*).
- Skipped stages are listed, never hidden — the package records them on purpose.
- Optional `dl.oq-evidence__facts` with the provenance: author agent, verifier version, package digest.

## Don't

- Don't compute the overall verdict in the UI; show the package's.
