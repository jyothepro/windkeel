---
name: prod-e2e
description: Run a Windkeel end-to-end test against production. Use when the user says "e2e in prod", "test prod", "prove it live", or wants to confirm a deploy works end to end.
---

# Production end-to-end test

The prod e2e is a real issue in **jyothepro/content-machine** that production Windkeel
(orqon.vercel.app, via the `orqon-content-machine` GitHub App) picks up and turns into a draft PR.
`test/deployed-round-trip.test.js` is **not** this; it is for throwaway projects only.

Opening the issue is visible to others: confirm with the user first.

1. **Write the issue.** Title `[windkeel test] <small change>`, label `windkeel`. Body: the problem,
   `## What to do` (docs-only or similarly tiny, with what not to touch), `## Acceptance criteria`
   as an author-written `- [ ]` checklist (author-written criteria skip the approval pause), and
   `## Why this issue exists`. Copy content-machine#98.
   ```sh
   gh issue create -R jyothepro/content-machine --label windkeel --title "[windkeel test] …" --body-file issue.md
   ```
2. **Watch.** The issue gets comments, then a draft PR (about 5 minutes when healthy). Check
   `/v1/health` reports `schema: current` first if the deploy was recent.
3. **Diagnose** with read-only SQL against production (ask before using any production URL):
   `engineering_run`, `run_state_transition`, `workspace`, `verification_run`, `repair_attempt`
   (the repair packet). Logs: Better Stack, source `orqon-backend`; search `stage threw` and
   `stage ended the run`.
4. **Report**: run id, verdict, criteria met, PR link, time taken. A `warn` can come from tools
   the sandbox couldn't install (e.g. semgrep); name the cause.

Env var changes on Vercel need the user (`vercel env` is blocked for agents) and a redeploy.
