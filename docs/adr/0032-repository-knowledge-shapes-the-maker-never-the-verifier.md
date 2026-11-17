# ADR-0032: Repository knowledge shapes the maker, never the verifier, and learned lessons are risk-tiered

- Status: Accepted
- Date: 2026-10-21

## Context

Every run starts from zero.

## Decision

- §1 — Knowledge feeds the maker's first prompt and nothing else: One bounded section, `## Repository knowledge`, after the task's description and before a playbook's section and the acceptance criteria (the order is knowledge, playbook, criteria — ADR-0033).
- §2 — Every entry carries provenance.
- §3 — Frozen per run: What was injected is copied into `run_knowledge` when a fresh maker session starts, append-once per note, and a redelivery renders that snapshot instead of selecting again.
- §4 — Three sources: Notes people write (repository or organization scope, optional path globs, versioned, attributed, `knowledge.manage` to write — Admin and Member, and an admin permission a token carries only when asked for by name).
- §5 — Learned lessons are risk-tiered by a deterministic classifier: (`knowledge-risk.ts`), the maintainer's rule of 2026-10-21:
- §6 — Knowledge never fails a run: A store that cannot be read leaves the prompt as it always was, and the failure is logged.

§1's "never the verifier" is enforced by `npm run invariant:check` (`scripts/invariant-check.mjs`, check `adr-0032-verifier-no-knowledge`).

## Consequences

- A low-risk lesson reaches the next run without a person reading it.
- The classifier is conservative and will call some harmless facts high risk ("the auth module lives in `src/auth/`" names auth).
- Pull request review events are learned from, as suggestions only (#432; the maintainer's decision of 2026-10-27 to subscribe the App to **Pull request review** and **Pull request review comment**, `docs/github-app.md`).
- The selector is a seam (`selectKnowledge`): ordering, path globs and a character budget today; relevance or embeddings later without touching the store, the renderer or the stage.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Milestone: M12 — Repository / organization memory (`research/MILESTONES.md`)
- Leaves unchanged: [ADR-0004](0004-verification-runs-in-a-fresh-independent-sandbox.md) (the gate),
  [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (the verifier stays the gate)
- Applies: [ADR-0014](0014-sandbox-secrets-brokered-keys-scoped-tokens-phased-egress.md) (the maker is hostile),
  [ADR-0027](0027-the-maker-harness-is-chosen-with-the-maker-model-and-frozen-per-run.md) (frozen per run)
- Arises from: [#388](https://github.com/jyothepro/orqon/issues/388) and the maintainer's decision of 2026-10-21

### Context

Every run starts from zero. The maker is told the task's title, description and criteria
(`buildMakerPrompt`), and nothing about the repository: not that tests run with `pnpm -w test`, not
that `legacy/` is off limits, not the check the verifier caught it skipping last week. So it repeats
mistakes the independent verifier already caught, and each repeat costs a repair cycle (ADR-0011).

Remembering is cheap; remembering *safely* is the design problem, because two invariants are in the
way:

- **The verifier is the gate** (ADR-0004, ADR-0029). Anything that changed what it checks, skips or
  accepts would be a path around verification.
- **The maker is hostile** (ADR-0014). Lessons learned from a run are learned from text the maker
  influenced — findings quote its code and comments — so "the agent saves its own memory" is a
  prompt-injection channel into every later run on the repository.

### Decision

1. **Knowledge feeds the maker's first prompt and nothing else.** One bounded section,
   `## Repository knowledge`, after the task's description and before a playbook's section and the
   acceptance criteria (the order is knowledge, playbook, criteria — ADR-0033). No
   knowledge module is imported by `packages/verification`, the VERIFYING or REPAIRING stages or
   the criteria gate, and no verifier-side module names a knowledge table
   (`test/verification-boundary.test.js`). Repair turns carry none either: `repairing.ts` keeps its
   single prompt renderer. Learning from the verifier's findings is one-way.
2. **Every entry carries provenance**, rendered as `source: …` — a person's note with its version
   and author, a learned lesson with its run and who accepted it, the digest with its commit — so a
   bad note can be found and removed. Note bodies cannot close the section (headings escaped,
   fences balanced).
3. **Frozen per run.** What was injected is copied into `run_knowledge` when a fresh maker session
   starts, append-once per note, and a redelivery renders that snapshot instead of selecting
   again. The run report and `GET /v1/runs/:id/knowledge` read it.
4. **Three sources.** Notes people write (repository or organization scope, optional path globs,
   versioned, attributed, `knowledge.manage` to write — Admin and Member, and an admin permission a
   token carries only when asked for by name). A codebase digest, deterministic and model-free, read
   from the pinned base commit rather than the working tree the install phase has run scripts in,
   allowlisted files only, capped and scrubbed of anything shaped like a credential. And lessons
   learned from repair packets when a run's repair loop ends.
5. **Learned lessons are risk-tiered by a deterministic classifier** (`knowledge-risk.ts`), the
   maintainer's rule of 2026-10-21:
   - *low risk* — a descriptive fact about layout, conventions or where tests live — is applied
     automatically (`active`), shown with its provenance, and deletable (a tombstone keeps it
     deleted);
   - *high risk* — anything that changes commands run, touches secrets, network or egress, skips or
     weakens tests, or mentions the verifier or checker — is `suggested` and never injected until a
     person accepts it;
   - *unclassifiable is high risk.* `low` is earned by matching a descriptive pattern and tripping
     no high-risk rule, so the classifier is an allowlist, not a denylist. It folds compatibility
     characters, removes invisible ones, maps leetspeak and checks a letters-only form, so spacing,
     punctuation and look-alikes do not launder a word; non-Latin scripts, encoded runs, markup and
     instruction-shaped text are high. No model is consulted: a model deciding whether the
     attacker's text is safe would be one more prompt the attacker's text reaches.
6. **Knowledge never fails a run.** A store that cannot be read leaves the prompt as it always was,
   and the failure is logged. `WINDKEEL_KNOWLEDGE=off` turns all of it off for a deployment.

### Consequences

- A low-risk lesson reaches the next run without a person reading it. That is the maintainer's
  trade, and its blast radius is bounded by construction: the text is a short description that
  matched an allowlist, it can only reach the maker (whose output the verifier still judges against
  unchanged criteria), and it is visible, attributed and deletable.
- The classifier is conservative and will call some harmless facts high risk ("the auth module lives
  in `src/auth/`" names auth). A false high costs one click; a false low costs a prompt injection.
- Pull request review events are learned from, as suggestions only (#432; the maintainer's
  decision of 2026-10-27 to subscribe the App to **Pull request review** and **Pull request review
  comment**, `docs/github-app.md`). A review submitted with `changes_requested`, a `commented` review
  with text, or an inline review comment, on a pull request a Windkeel run opened (matched by the
  run's `pr_number`), becomes one `source_kind = 'pr_review'` note that is **always `suggested`**,
  whatever the classifier says: a person's words about one change are not a fact about the
  repository until a person says so. Bots, Windkeel's own App among them, are ignored. The reviewer's
  text is quoted as a blockquote under a fixed sentence saying it is data, not instructions, and the
  title is Windkeel's template, never the reviewer's words. The source ref records the run, pull
  request, review and comment ids, path, line, author and delivery; a delivery is idempotent on its
  id and on the review or comment id (`src/factory/knowledge-review.ts`). As with every source,
  nothing here reaches the verifier.
- The selector is a seam (`selectKnowledge`): ordering, path globs and a character budget today;
  relevance or embeddings later without touching the store, the renderer or the stage.
