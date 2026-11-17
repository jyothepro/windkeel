---
name: write-adr
description: Write a Windkeel architecture decision record in docs/adr/. Use when a change makes or reverses an architectural decision, contradicts an existing ADR, or the user asks for an ADR.
---

# Write an ADR

1. **Check what exists.** Read `docs/adr/README.md` and every ADR touching the area. If the new
   decision contradicts one, it must say `Amends:` or `Supersedes:` that ADR.
2. **Number**: next free number on `origin/main` at merge time
   (`git ls-tree --name-only origin/main docs/adr/ | sort | tail -2`).
3. **File**: `docs/adr/NNNN-the-decision-as-a-sentence.md`. The title states the decision, not the
   topic ("Batches group verified runs and never gate them", not "Batches").
4. **Template** (match `docs/adr/0039-*.md`; the leading Context/Decision/Consequences stay ≤ 500 words):
   ```markdown
   # ADR-NNNN: <decision as a sentence>

   - Status: Proposed | Accepted
   - Date: YYYY-MM-DD
   - Resolves: [#<issue> — <title>](https://github.com/jyothepro/orqon/issues/<issue>)
   - Amends: [ADR-XXXX](XXXX-....md) (what changes)

   ## Context
   ## Decision
   <one bold sentence, then numbered sections>
   ## Consequences
   ## Background   (optional: full reasoning, alternatives, dated amendments)
   ```
5. **Superseding**: change the old ADR's line to `- Status: Superseded by ADR-NNNN` and `git mv` it
   to `docs/adr/archive/` (it keeps its number). A partial change is "amended by", not superseded.
6. **Index**: add a row to `docs/adr/README.md` — `| [NNNN](NNNN-title.md) | Title | Status | Decision in one line |`
   — and update the old row (status, `archive/` link). New terms go in `CONTEXT.md`; a new
   invariant goes in its *Invariants* list, and in `scripts/invariant-check.mjs` if it can be checked.
7. `npm run arch:check` fails if the index and the files disagree.
