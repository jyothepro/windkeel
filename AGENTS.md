# Agents

Windkeel is a software factory with an independent verifier: a **maker** agent implements a task in
one sandbox, a **verifier** from another vendor checks it in a fresh sandbox, and the result is a
draft PR carrying an **evidence package**. Vocabulary: [CONTEXT.md](CONTEXT.md). Decisions:
[docs/adr/](docs/adr/README.md). All docs: [docs/README.md](docs/README.md).

## Reporting style

When reporting information to the user, be extremely concise and sacrifice grammar for the sake of concision.

## Commands

Node ≥ 22.12, npm workspaces. Run from the repo root.

| Do | Run |
| --- | --- |
| Install | `npm ci` |
| Build everything | `npm run build` |
| Typecheck | `npm run typecheck` |
| Lint (no source comments, ADR-0041) | `npm run lint` |
| Architecture gate | `npm run arch:check` (`scripts/arch-check.mjs`) |
| ADR invariants | `npm run invariant:check` (`scripts/invariant-check.mjs`) |
| All tests | `npm test` (clean + build + `node --test test/*.test.js`) |
| One test file | `npm run build && node --test --test-force-exit test/<name>.test.js` |
| Local Postgres + MinIO | `docker compose up -d && cp .env.example .env` |
| Apply migrations | `npm run db:migrate` (add `-- --dry-run` to only list) |
| CLI / admin CLI | `npm run windkeel -- …` / `npm run windkeel-admin -- …` |

CI (`.github/workflows/ci.yml`) runs `arch:check`, `invariant:check`, `lint` (including
`typecheck`), the console checks, `test:ci`, the skip budget and the bench. Before saying work
is done, run at least `arch:check`, `invariant:check`, `lint` and the test files you touched. The invariants themselves are listed in [CONTEXT.md](CONTEXT.md).

## Repo map

| Path | What | Rules |
| --- | --- | --- |
| `src/factory/` | Run state machine, stages, stores, sweeps, tenancy, workflow engine | [src/factory/AGENTS.md](src/factory/AGENTS.md) |
| `src/sandbox/` | Where untrusted code runs: providers, egress phases, credentials | [src/sandbox/AGENTS.md](src/sandbox/AGENTS.md) |
| `src/{worker,github,intake,integrations,billing,batches,schedules}/` | Factory subsystems | same as factory |
| `src/public/` | The factory's public exports (`@windkeel/factory/<name>`). Apps import only these | |
| `packages/verification/` | The verification engine (the gate). Never imports maker-side code | [packages/verification/AGENTS.md](packages/verification/AGENTS.md) |
| `packages/cli/` | The published `windkeel` CLI (alias `windkeel`) | [packages/AGENTS.md](packages/AGENTS.md) |
| `packages/api-contract/` | The one API contract shared by ingress, console and CLI | [packages/AGENTS.md](packages/AGENTS.md) |
| `apps/ingress/` | The control-plane API on Vercel (`orqon-backend`) | [apps/ingress/AGENTS.md](apps/ingress/AGENTS.md) |
| `apps/console/` | Next.js console (`orqon-frontend`) | [apps/console/AGENTS.md](apps/console/AGENTS.md) |
| `apps/site/` | Marketing site for windkeel.dev (`windkeel-site`). Static; never imports product code | [apps/site/AGENTS.md](apps/site/AGENTS.md) |
| `migrations/` | Forward-only numbered SQL | [migrations/AGENTS.md](migrations/AGENTS.md) |
| `test/` | `node:test` suites, run concurrently | [test/AGENTS.md](test/AGENTS.md) |
| `docs/adr/` | Architecture decisions | [docs/adr/README.md](docs/adr/README.md) |
| `research/`, `docs/archive/` | Historical. Don't treat as current | |

## Things you won't guess

- **The product is Windkeel; the old name `windkeel` is still in live identifiers.** Prose and UI say
  Windkeel. Left on purpose until each has a migration: `WINDKEEL_*` env vars, the `windkeel` DB schema and
  role, the `windkeel-admin` command (the CLI is now `windkeel`, with `windkeel` kept as an alias), `@windkeel/*` packages, `windkeel.config.json`, `.windkeel/`,
  the `windkeel` trigger label, `/windkeel` and `@Windkeel` in Slack, `X-Windkeel-*` headers, `windkeel/…` branches,
  `<!-- windkeel:… -->` markers, `windkeel_*` MCP tools, the `Windkeel Factory` git author, the Vercel
  projects and the GitHub repo. Don't rename any of these in passing.
- **Local test DB.** CI and README use `postgresql://windkeel:windkeel@localhost:5432/windkeel` (from
  `docker compose`). A machine with a plain local Postgres may have no `windkeel` role; there use
  e.g. `TEST_DATABASE_URL=postgresql://localhost:5432/windkeel_test`. Never point tests at `.env`'s
  `DATABASE_URL` — that can be production. DB tests skip when `TEST_DATABASE_URL` is unset.
- **Shared database, `orqon` schema.** Production Supabase is shared with other products. Every
  Windkeel table and view lives in the `orqon` schema, reached through `search_path`. SQL uses
  **unqualified** names — never `public.x` or `orqon.x`. Avoid generic table names (`user`,
  `role`). A row in `auth.users` grants nothing in Windkeel (ADR-0024).
- **Merging to `main` migrates production** (`.github/workflows/migrate.yml`). Never hand-apply
  migrations. Migrations must be additive and backward-compatible. A deployment that is behind
  answers `503 schema_behind`; `/v1/health` reports `schema: current|behind`.
- **Numbers collide.** New migrations and ADRs take the next free number on `main` *at merge
  time*. Re-check before merging parallel PRs.
- **Vercel projects.** `orqon-backend` builds `apps/ingress` (orqon.vercel.app). `orqon-frontend`
  is the console (console-two-gamma.vercel.app). A third project, `orqon-sandbox`, also exists. Env changes need
  a redeploy; use `npx -y vercel@latest`, not a global `vercel`.
- **The old name, orqon, is still load-bearing in a few places.** Env vars are `WINDKEEL_*`, but
  each entry point imports `env-compat` first, which copies any `ORQON_*` into its `WINDKEEL_*`
  name when that is unset, so production's `ORQON_*` settings keep working. Kept on purpose:
  the `orqon` DB schema, `orqon_app` role and `orqon.*` settings; the `key_source = 'orqon'`
  value; Vercel Workflow ids (`orqon*Flow`); the evidence format (`dev.orqon.evidence/v0`,
  its subject name and transcript trailer); `orqonseal` prefixes; hash seeds and lock keys;
  `SYSTEM_ACTOR` in the audit chain; the Vercel project and domain names. Old user-side names
  are still read: `orqon.config.json`, the `orqon` issue label, `/orqon` commands and
  `~/.config/orqon`.
- **Prod end-to-end test** = a `windkeel`-labelled issue in `jyothepro/content-machine` (skill:
  `.claude/skills/prod-e2e`). `test/deployed-round-trip.test.js` is not that; run it only against a
  throwaway project.
- **The verifier is the gate.** Nothing maker-side (repository knowledge, playbooks' maker
  instructions, maker screenshots, batches) may weaken verification. See ADR-0032/0033/0035/0036.
- `apps/console/AGENTS.md` is rewritten by `next dev`; don't hand-edit inside its markers.

## Workflow

- Branch per change; PR into `main` (or a milestone integration branch when orchestrating).
  Subagents open PRs; the lead reviews (spec + standards) and merges. Never force-push shared
  branches.
- A decision that changes architecture gets an ADR (skill: `.claude/skills/write-adr`). If your
  change contradicts an ADR, say so explicitly.
- Repo skills live in `.claude/skills/`: `add-endpoint`, `add-migration`, `write-adr`, `add-test`, `prod-e2e`.
- `.claude/settings.json` runs `arch:check` and `invariant:check` whenever a Claude Code session stops
  (`scripts/hooks/stop-arch-check.sh`). A rule that can be checked belongs in
  `scripts/arch-check.mjs`, not only in prose.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on jyothepro/windkeel via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — label strings equal the five canonical role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
