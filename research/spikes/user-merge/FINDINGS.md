# Spike C — merging with a GitHub App user-to-server token (#370)

Flip condition 2 of [ADR-0029](../../../docs/adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md):
*"the GitHub App user-to-server token merging a draft PR under branch protection, with the merge
attributed to the person."*

**Status: not run live.** No App client id was present in the environment (variable names only
were checked), so there is **no live result** here. Everything below is either confirmed by
GitHub's documentation (linked) or marked *to confirm live*. The harness is one command for a
person to run (§ Running it); that run is what flips condition 2. The harness supports
**github.com only**; GitHub Enterprise Server (different device-flow, REST and GraphQL bases) is
not supported.

## Contents

| File | What |
|---|---|
| `eligibility.mjs` | Pure function: ADR-0029 §5's merge rules plus two this spike adds, each `{ok, blocking, checked, reason}` |
| `eligibility.test.mjs` | 20 node tests for the rules |
| `github-user.mjs` | Device flow, refresh, PR read, ruleset bypass read, mark-ready, merge with `sha` guard, `merged_by` check; `fetch` injected; errors redacted; github.com only |
| `user-merge.test.mjs` | 14 offline tests of the call order against a scripted fake GitHub (mark ready → re-check → wrong-sha probe → guarded merge → attribution; dry run; refusals, including bypass-capable viewers and a probe that does not answer 409; no token in output). They prove the harness, not GitHub |
| `harness.mjs` | The live CLI |

`node --test research/spikes/user-merge/*.test.mjs` → 34 pass. (Not part of `npm test`.)

**Promoted by #371.** `eligibility.mjs` and the client half of `github-user.mjs` now re-export
`src/factory/merge-eligibility.ts` and `src/github/user-client.ts`, so these tests run against the
code that ships — run `npm run build` at the repository root first. The product's merge sequence is
`src/factory/user-merge.ts`; this harness keeps its own (with the deliberate wrong-SHA probe).

## What GitHub's docs confirm / contradict in ADR-0029 §5

### Confirmed

1. **A user-to-server token is the intersection of the person and the App.** "A GitHub App user
   access token only has permissions that both the user and the app have", and only in accounts
   where the App is installed. [gen], [obo], [perm]. So §5.5's collaborator check comes free: a
   read-only collaborator's token cannot merge.
2. **Installed permissions already suffice for the happy path.** `PUT /repos/{o}/{r}/pulls/{n}/merge`
   needs **Contents: write**, user access tokens (UAT) allowed [preq]; ADR-0009 already grants
   Contents RW + Pull requests RW. Mark-ready is GraphQL `markPullRequestReadyForReview(pullRequestId)`
   [gql]; REST `PATCH /pulls/{n}` has no `draft` field [rest], so GraphQL is the only documented
   route. *To confirm live:* the mutation succeeds with Pull requests: write on a UAT (GraphQL docs
   don't publish per-mutation App permissions).
3. **The head guard exists in both APIs.** REST merge takes `sha` ("SHA that pull request head must
   match to allow merge") → **409** on mismatch [rest]; GraphQL `mergePullRequest` has
   `expectedHeadOid` [gql]. So §5.2 "only the verified candidate" can be enforced **atomically by
   GitHub**, not just by Windkeel's read-then-merge. The harness also sends a deliberately wrong SHA
   first and aborts unless GitHub answers exactly 409.
4. **Attribution.** With a user access token, "the GitHub UI will show the user's avatar photo
   along with the app's identicon badge as the author"; audit logs name the user as actor, access
   type "GitHub App user-to-server token" [obo]. `merged_by` on `GET /pulls/{n}` [rest] is the
   harness's check. *To confirm live:* `merged_by.login` is the person, not `<app>[bot]`.
5. **Protection/rulesets apply to the person's token** because they're evaluated for the actor;
   protection rules and rulesets "are enforced" together, most restrictive wins [rulesets]. So
   required reviews, required checks, conversation resolution gate the merge call. `windkeel/verification`
   on `warn` is `neutral`, documented as "treated as a success for dependent checks in GitHub
   Actions" [status] — *to confirm live* that a required `windkeel/verification` at `neutral` lets the
   merge through.
6. **Token lifetime.** With *Expire user authorization tokens* on: access token **8 h**, refresh
   token **6 months**; refresh is single-use — "Once you use a refresh token, that refresh token and
   the old user access token will no longer work" [refresh]. Device flow needs only the client id,
   no secret [gen], [cli].

### Contradicted / missing

**A. An admin's token silently bypasses protection — contradicts §5.1.** §5.1: *"Windkeel never
bypasses protection and never offers an admin override."* GitHub: "By default, the restrictions of a
branch protection rule don't apply to people with admin permissions to the repository or custom
roles with the 'bypass branch protections' permission" unless *Do not allow bypassing the above
settings* is on [protected]; "Repository owners and administrators can merge a pull request even if
it hasn't received an approving review" [approve]; ruleset bypass lists can name roles/teams/apps
[rulesets]. The REST merge has no "don't bypass" flag, so an admin's token merging a PR with missing
reviews may just succeed — Windkeel would have *made* an admin override without *offering* one. Using
the person's token does not by itself keep §5.1's promise.
**Fix (in `eligibility.mjs`), two rules:**
- `no-bypass` (ADR-0029 §5.1, amended after review of #372): **refuse to merge as anyone GitHub
  reports can bypass** — GraphQL `viewerCanMergeAsAdmin` [gql], or any ruleset on the base branch
  whose `current_user_can_bypass` is not `never` (`GET /repos/{o}/{r}/rules/branches/{base}`, then
  `GET /repos/{o}/{r}/rulesets/{id}`) [rulesets]. The console says: *"The repository lets you bypass
  its protection; turn on 'Do not allow bypassing' to merge from Windkeel."* An unknown answer (GitHub
  won't describe the rulesets) refuses too. Reading the merge state is not enough for these people:
  a review can be dismissed or a check fail between Windkeel's read and the `PUT` **without moving the
  head SHA**, so the `sha` guard doesn't fire and GitHub merges on their bypass. Only a repository
  that enforces its protection for admins (classic *Do not allow bypassing the above settings*, or
  an empty ruleset bypass list) makes them eligible.
- `protection`: for everyone else, read `mergeStateStatus` with the person's token; merge only on
  `CLEAN`, `HAS_HOOKS`, `UNSTABLE`; refuse `BLOCKED`, `BEHIND`, `DIRTY`, `UNKNOWN`. After
  mark-ready, re-read before merging (`DRAFT` hides the real state).

Residual: for a person who cannot bypass, a state change between the read and the `PUT` is
harmless — GitHub enforces what's configured at merge time and refuses. *To confirm live:* that
`viewerCanMergeAsAdmin` is `false` for an admin once *Do not allow bypassing* is on, and that
`current_user_can_bypass` is readable with a user token holding the App's current permissions.

**B. "`workflow` scope" is the wrong mechanism, and it collides with "permissions don't change".**
Consequences: *"may need the person's token to carry `workflow` scope"*. GitHub App user tokens have
**no OAuth scopes** (`scope` comes back empty; `github-user.mjs` records it) — they carry the
permission intersection. The gating permission is the App's **Workflows** repository permission:
"If your app specifically needs to access or edit Actions files in the `.github/workflows`
directory, request the 'Workflows' repository permission" [perm]; the permissions table lists
Workflows: write as an additional requirement on contents/git-refs writes [preq]. The docs don't
list the merge endpoint under Workflows, but in practice App merges of workflow-touching PRs are
refused (403 "Resource not accessible by integration") until the App gets Workflows — Kodiak fixed
exactly this by requesting it ([kodiak], secondary source). So the person's token **cannot** carry
it unless the App's installed permissions change, contradicting *"its installed permissions don't
change"* (ADR-0029 Consequences, the ADR-0009 amendment note, `docs/github-app.md`). Two consistent
options:
- **(recommended, first slice)** Keep the App as is; eligibility **blocks** a workflow-touching PR
  with *"merge it on GitHub"*. This is `eligibility.mjs`'s default; a truncated file list (GitHub
  caps at 3000) counts as touching.
- Add **Workflows: write** to the App: a real widening — ADR-0009's list changes, every installation
  must re-approve ("the owner of each account where the app was installed will be prompted to approve
  the new permissions" [perm]), and the *installation* token could then push workflow files too, so
  ADR-0014's per-role minting must exclude it explicitly (`InstallationPermissions` in
  `src/github/client.ts` makes that expressible).

Side effect worth knowing: Windkeel's maker can't push `.github/workflows/*` today (installation token
without Workflows), and neither could §3's human-workspace push (also a scoped App token). So a
workflow-touching Windkeel PR only arises if someone pushes outside Windkeel — at which point head ≠
verified SHA anyway. *To confirm live:* exact status/message on a workflow-touching merge with a UAT.

**C. Required reviews are weaker than they look when the App opens the PR.** "Pull request authors
cannot approve their own pull requests" [approve] — but the author is `windkeel[bot]`, so the one person
who merges can also be the one required approver; *Require approval of the most recent reviewable
push* doesn't help (last pusher is the App) [protected]. Not a §5 contradiction, but the console
shouldn't imply GitHub's required reviews are two-person control; Windkeel's verifier is the independent
party.

**D. Merge queues.** A branch requiring a merge queue is expected to reject a direct merge; docs don't
state the REST response [mq]. §5 is silent. The `protection` rule would see `BLOCKED`; a later slice
could enqueue (GraphQL `enqueuePullRequest`) instead. *To confirm live.*

**E. Supabase GitHub sign-in ≠ this token.** Console sign-in is Supabase's GitHub OAuth identity; a
GitHub App user token comes only from the App's own authorization (web/device flow). So the merge
authorization is a separate explicit step (as §5.1 implies, "obtained when the person authorizes
merging"), and Windkeel must check that the token's GitHub user id equals the signed-in principal's
linked GitHub identity — otherwise a person could authorize as a second GitHub account and merge as it.

## Token storage and refresh plan (sealed like ADR-0026)

- **Row** `github_user_authorization` (one per principal): `principal_id`, `github_user_id`,
  `github_login`, `sealed_access_token`, `sealed_refresh_token`, `access_expires_at`,
  `refresh_expires_at`, `keypair_id`, `status` (`valid | needs_reauth | revoked`), timestamps.
  No field ever returns a token (ADR-0026 §1).
- **Sealing:** sealed box v2 (`sealSecretV2`, `src/factory/secret-box.ts`) with AEAD context
  `github_user_token:<principal_id>:<github_user_id>:access` / `…:refresh`, so a ciphertext moved to
  another principal's row, or access/refresh swapped, fails to open (ADR-0026 §2).
- **Obtaining:** console uses the **web flow** with `state` bound to the session and PKCE S256 [gen].
  The callback exchanges the code (client secret), immediately seals both tokens with the public key,
  calls `GET /user`, and refuses a `github_user_id` that isn't the principal's linked identity (E).
  Device flow is for this spike/CLI only.
- **Using:** `POST /runs/{id}/merge` records an intent; a one-step workflow on the stage side (as
  ADR-0026's as-built credential validation) does the merge — only ids cross the step boundary, never
  a token (ADR-0026 §3). Inside one handler call: open → re-evaluate eligibility on live PR state →
  mark ready if asked → merge with `sha` = verified candidate → write `run_merge` → plaintext out of
  scope. Opened values registered with the redactor.
- **Refresh — lazy and serialized.** Refresh only when a merge needs the token and
  `access_expires_at` is < 5 min away (merges are rare; a background refresher only multiplies
  exposure). Refresh tokens are single-use [refresh], so refresh under `SELECT … FOR UPDATE` on the
  row and re-seal the new pair in the same transaction before using the new token. If GitHub succeeds
  but the write fails, both old tokens are dead → `needs_reauth` (the only safe state). Expired or
  rejected refresh (6 months, `bad_refresh_token`) → `needs_reauth`; the console asks to re-authorize.
- **Keep expiry on.** Don't opt out of *Expire user authorization tokens*: an 8 h access token bounds a
  leaked plaintext; a non-expiring token is a long-lived merge credential for every admin who clicked
  Authorize.
- **Revocation:** on "stop merging from Windkeel" or principal removal, delete the row and revoke the
  grant at GitHub (`DELETE /applications/{client_id}/grant`, Basic client id/secret — *to confirm*
  for GitHub Apps). A user revoking on github.com shows up as a 401 at merge → `needs_reauth`.
- **Residual risk** is ADR-0026's: the private key is in the one deployment, so code execution there
  opens every user token — and these can merge, which is worse than a model key. The per-org *Allow
  merging from Windkeel* flag and `runs.merge` bound whose tokens exist at all; M14's KMS is the real fix.

## Verdict on flip condition 2

**Not met yet, and not meetable from docs.** Docs support the mechanism — permission intersection,
Contents: write for merge, `sha`/`expectedHeadOid` guard, attribution to the user — and nothing found
makes condition 2 unachievable. But two parts of §5 should be amended before Accepted, independent of
the live run:

1. **§5.1** gains the `no-bypass` and `protection` rules (A): refuse anyone GitHub reports can
   bypass unless the repository enforces protection for admins, and otherwise merge "only when
   GitHub reports the PR mergeable without bypass" — or an admin's token turns every Windkeel merge
   into a potential silent override. (§5.1 has since been amended this way.)
2. **Consequences:** replace "`workflow` scope" with the App's Workflows permission (B), and choose:
   block workflow-touching PRs (recommended) or widen the App and update ADR-0009 + `docs/github-app.md`.

Condition 2 flips when a person runs the harness against a protected branch and the results file
shows `stale-sha-probe: 409`, `merge: 200`, `merged-by.attributedToPerson: true`. Second run on a
workflow-touching PR: refused before any call. Optional third, as admin on a PR missing a review:
refused by `protection`.

## Running it

### 1. App settings (once)

GitHub → Settings → Developer settings → GitHub Apps → *your Windkeel App* → **General** [register]:

- **Callback URL:** any URL is fine for this spike (device flow doesn't redirect); for the console it
  will be `https://<console-host>/api/github/user-authorization/callback`.
- **Expire user authorization tokens:** leave **checked** (8 h / 6 months).
- **Request user authorization (OAuth) during installation:** optional — prompts installers to
  authorize at install time; not needed for the harness.
- **Enable Device Flow:** **check** — the harness uses it.
- Note the **Client ID** (`Iv23…`). The harness needs no client secret.
- **Permissions:** unchanged (ADR-0009). Do **not** add Workflows for the first run.

### 2. A test repository

- Install the App on a test repo; the person running the harness has write (or higher) on it.
- Protect the default branch (classic or ruleset): require a PR with 1 approval, require
  `windkeel/verification` (or any passing check), and for the main run enable **Do not allow bypassing
  the above settings**.
- Open a **draft** PR (by Windkeel, or by hand for the spike); get it approved (second account, or
  yourself if the App opened it — finding C). Note its head: `gh pr view N --json headRefOid -q .headRefOid`.

### 3. Run

```sh
cd research/spikes/user-merge
export GITHUB_APP_CLIENT_ID=Iv23xxxxxxxxxxxx

# look first: authorize, evaluate, change nothing
node harness.mjs --repo OWNER/REPO --pr N --sha HEAD_SHA --dry-run

# then: mark ready → wrong-sha probe (expect 409) → merge with sha guard → merged_by check
node harness.mjs --repo OWNER/REPO --pr N --sha HEAD_SHA
```

It prints a code to enter at `https://github.com/login/device` as the person who should be the
merger. Results go to stdout and `results-<timestamp>.json` (git-ignored): logins, statuses, SHAs,
token *shape* (expiry, refresh issued, scope) — never a token. Exit 0 = merged and `merged_by` is you.

Optional:
- `--pr <workflow-touching PR>` → expect a `workflows` refusal, no mutation. To record GitHub's own
  answer, run once with `--workflows-permission write` (without actually granting it) → the 403.
- As an admin with *Do not allow bypassing* **off** → expect a `no-bypass` refusal
  (`viewerCanMergeAsAdmin: true`) even with the approval present; turn it **on** and the same
  person is eligible. Same for a ruleset that lists you as a bypass actor.

## Sources

[gen]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
[refresh]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
[obo]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user
[perm]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
[preq]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28
[rest]: https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28
[gql]: https://docs.github.com/en/graphql/reference/pulls
[protected]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
[rulesets]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
[approve]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews
[status]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks
[mq]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
[register]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
[cli]: https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-cli-with-a-github-app
[kodiak]: https://github.com/chdsbd/kodiak/issues/641

- gen — Generating a user access token (web/device flow, PKCE, `state`, poll errors)
- refresh — Refreshing user access tokens (8 h / 6 months, single-use refresh)
- obo — Authenticating on behalf of a user (access limits, attribution)
- perm — Choosing permissions (Workflows; intersection; re-approval on change)
- preq — Permissions required for GitHub Apps (merge = Contents: write; Workflows table)
- rest — REST pulls (merge `sha`, 405/409, `merged_by`; no `draft` on update)
- gql — GraphQL pulls (`markPullRequestReadyForReview`, `expectedHeadOid`, `mergeStateStatus`, `viewerCanMergeAsAdmin`)
- protected — About protected branches (admin bypass; most-recent-push approval)
- rulesets — About rulesets (bypass lists; layering)
- approve — Approving with required reviews (authors can't self-approve; admins can merge without approval)
- status — About status checks (`neutral`)
- mq — Managing a merge queue
- register — Registering a GitHub App (Callback URL, Expire user authorization tokens, Request user authorization during installation, Enable Device Flow)
- cli — Building a CLI with a GitHub App (device flow, client id only)
- kodiak — secondary, not GitHub docs: Kodiak #641, workflow-touching merge refused until the App had Workflows
