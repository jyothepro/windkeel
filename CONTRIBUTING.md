# Contributing to Windkeel

Thanks for helping. Windkeel is an independent verifier for AI-written pull requests, and a
factory that pairs a coding agent with that verifier. Contributions from people and from agents
are both welcome, under the same rules.

## Before you start

- **Read [CONTEXT.md](CONTEXT.md).** It is one page, and it defines the words the code and the
  issues use: maker, verifier, run, evidence package.
- **Read [AGENTS.md](AGENTS.md).** It has the commands, the repo map, and the things you will not
  guess, such as why the old name `windkeel` is still in identifiers.
- **For anything bigger than a fix, open an issue first.** Architectural decisions live in
  [docs/adr/](docs/adr/README.md). A change that reverses one needs a new ADR.
- **Security issues go through [SECURITY.md](SECURITY.md)**, never a public issue.

## Setting up

Node 22.12 or later, and Docker for the local database.

```sh
npm ci
docker compose up -d
cp .env.example .env
npm run build
```

Database-backed tests skip unless `TEST_DATABASE_URL` is set, for example
`postgresql://windkeel:windkeel@localhost:5432/windkeel` with the compose database. Never point it at a
real deployment.

## Before you open a pull request

```sh
npm run arch:check
npm run invariant:check
npm run lint
npm run build && node --test --test-force-exit test/<the files you touched>.test.js
```

CI runs the whole suite. Windkeel also gates its own pull requests with its own verifier, so your
PR will get an evidence package and a verdict. If you think the verdict is wrong, say so in the PR;
that is useful feedback too.

## Rules that are easy to miss

- **The verifier is the gate.** Nothing on the maker side may weaken verification. See ADR-0032
  and ADR-0033.
- **No comments in source code.** Rationale goes in ADRs and code notes (ADR-0041). `npm run lint`
  enforces it.
- **Migrations are forward-only and additive.** Merging to `main` migrates production.
- **The CLI is public.** Keep flags and exit codes backward-compatible.

## Contributor license

Windkeel is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), and is
also licensed commercially (see [COMMERCIAL.md](COMMERCIAL.md)). So that a contribution can ship
in both, every pull request needs this line in its description:

> I license my contribution to the project's maintainer under the PolyForm Noncommercial License
> 1.0.0, and grant the maintainer a perpetual, worldwide, irrevocable, royalty-free right to
> relicense it under any terms, including commercial ones. I wrote it, or otherwise have the
> right to submit it.

A first-time contributor's pull request is not merged without it.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
