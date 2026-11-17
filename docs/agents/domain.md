# Domain docs

How skills should use this repo's domain documentation.

## Before exploring, read

- **[`CONTEXT.md`](../../CONTEXT.md)** — the vocabulary.
- **[`docs/adr/README.md`](../adr/README.md)** — the index; then the ADRs that touch your area.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name),
use the term as `CONTEXT.md` defines it, and none of the synonyms it lists under *Avoid*.

A concept you need that isn't there is a signal: either you're inventing language the project
doesn't use (reconsider), or there's a gap — add the term to `CONTEXT.md` in the same PR.

## Flag ADR conflicts

If your output contradicts an ADR, say so rather than silently overriding it:

> _Contradicts ADR-0032 (knowledge never shapes the verifier) — worth reopening because…_

A change that reverses a decision needs a new ADR (`.claude/skills/write-adr`).
