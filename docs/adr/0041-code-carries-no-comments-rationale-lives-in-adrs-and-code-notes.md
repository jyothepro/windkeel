# ADR-0041: Code carries no comments; rationale lives in ADRs

- Status: Accepted
- Date: 2026-11-01
- Relates: [ADR-0005](0005-monorepo-split-lands-with-the-control-plane.md) (the boundary tests this extends),
  [ADR-0003](0003-factory-domain-model-and-run-state-machine.md) (the transition rule `windkeel/no-direct-run-status-write` enforces)

## Context

About a quarter of the TypeScript lines in `src/`, `packages/` and `apps/` were comments, most of them
design rationale with ADR references. Comments drift from the code they sit on, nothing checks them,
and an agent writing code reads them as instructions. The maintainer decided to ban them outright and
migrate the existing ones, rather than only blocking new comments.

Several bug classes in this repository were already written down in comments and enforced by nothing:
a direct `updateEngineeringRun({ status })` that skips the transition check, a runtime import in a
`"use workflow"` module, a clock read in a module that promises to be pure, a factory import in the
browser console, and a reviewer output budget too small to finish thinking.

## Decision

1. ESLint (flat config, `eslint.config.js`) runs over `src/`, `packages/`, `apps/` and `tools/` with a local
   plugin, `tools/eslint-plugin-windkeel`. `npm run lint` fails on any violation. The existing `checks` job in
   `.github/workflows/ci.yml` runs lint on every pull request. `prelint` builds the workspace
   declarations through typecheck before ESLint reads them.
2. `windkeel/no-comments` bans line, block and JSX comments. The only allowed comments are tool directives that
   change what a tool does: a shebang, `eslint-disable*`/`eslint-enable`, `@ts-expect-error`, `@ts-ignore`, and
   `/// <reference>`. No license requires per-file headers (Apache-2.0), so there is no header allowance.
3. Code that needs explaining gets a better name, an extracted function or constant, or a test. Design rationale
   goes in an ADR. The comments that existed when the ban landed were moved, verbatim, to
   `docs/code-notes/<source path>.md`, keyed by the declaration each one sat on.
4. Every bug class found from now on becomes a rule in the plugin, with RuleTester cases in
   `test/eslint-plugin-windkeel.test.js`.

## Consequences

- Rationale is one click away from the code instead of inline. A code note goes stale like a comment does,
  so a change that makes a note wrong updates or deletes it in the same pull request.
- Generated files (`src/sandbox/human-workspace-server-files.ts`, `src/sandbox/maker-browser/windkeel-browse-source.ts`,
  `apps/console/next-env.d.ts`) and build output are excluded from lint. `test/`, `bench/`, `research/`, `design/`
  and `docs/` are outside the lint scope for now.
- Adding a rule is cheap; turning one off needs an ADR.

## Amendment 2026-11-06: code notes removed

`docs/code-notes/` (the verbatim comments moved there by decision 3) is deleted. It was a migration record
that nobody read and that went stale. Rationale now lives only in ADRs, tests and names. The old comments
stay recoverable from version history: `docs/code-notes/<source path>.md` as of commit `43e0d45`. Decision 3
now ends after "Design rationale goes in an ADR". The Consequences bullet about code notes no longer applies.
