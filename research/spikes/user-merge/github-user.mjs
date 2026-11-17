/**
 * Spike C (#370): the GitHub calls a person-authorized merge needs, with `fetch` injected so the
 * sequence can be tested offline against a fake (user-merge.test.mjs) and run live by harness.mjs.
 *
 * Promoted to `src/github/user-client.ts` by #371: the device flow, refresh, the user client, the PR
 * read, the file list and the mark-ready mutation are re-exported from the shipped module (build
 * first: `npm run build` at the repository root). Only the harness's own sequence — with its
 * deliberate wrong-SHA probe — stays here; the product's merge is `src/factory/user-merge.ts`.
 *
 * Tokens never leave these closures in a printable form: every error message is passed through
 * `redact`, and nothing here logs.
 */

import { changedPaths, MARK_READY_MUTATION, readPullRequest, rulesetBypass, rulesetBypassFacts } from "../../../dist/github/user-client.js";

export {
  changedPaths,
  deviceFlow,
  MARK_READY_MUTATION,
  PR_STATE_QUERY,
  readPullRequest,
  redact,
  refreshUserToken,
  rulesetBypass,
  userClient,
} from "../../../dist/github/user-client.js";

/**
 * The spike's sequence, after the person has a token: who am I → PR state → eligibility →
 * (mark ready → re-read) → stale-SHA probe → merge with the sha guard → merged_by.
 * `decide(prFacts)` returns the eligibility result; the sequence stops when it says no.
 * `dryRun` performs no mutation at all.
 */
export async function runMergeSequence({ client, repo, number, expectedSha, decide, dryRun = false, mergeMethod = "squash", probeStaleSha = true }) {
  const [owner, name] = repo.split("/");
  const steps = [];
  const log = (step, detail) => steps.push({ step, ...detail });

  const me = await client.call("GET", "/user");
  if (me.status !== 200) return { ok: false, steps: [...steps, { step: "whoami", status: me.status }] };
  const login = me.body.login;
  log("whoami", { status: 200, login });

  const read = async () => {
    const s = await readPullRequest(client, { owner, name, number });
    const f = await changedPaths(client, { owner, name, number });
    // ADR-0029 §5.1 (amended): whether the person can bypass an active ruleset on the base branch.
    const b = s.ok ? await rulesetBypass(client, { owner, name, branch: s.pr.baseRefName }) : { ok: false, status: s.status };
    return { s, f, b };
  };
  let { s, f, b } = await read();
  if (!s.ok) return { ok: false, login, steps: [...steps, { step: "read-pr", status: s.status, errors: s.errors }] };
  if (!f.ok) return { ok: false, login, steps: [...steps, { step: "read-files", status: f.status }] };
  if (!b.ok) return { ok: false, login, steps: [...steps, { step: "read-rulesets", status: b.status }] };
  log("read-pr", { pr: summarize(s.pr), changedFiles: f.paths.length, complete: f.complete });

  const facts = (pr) => ({
    state: pr.state,
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
    mergeStateStatus: pr.mergeStateStatus,
    viewerCanMergeAsAdmin: pr.viewerCanMergeAsAdmin,
    ...(b.ok ? rulesetBypassFacts(b) : {}),
    changedPaths: f.paths,
    changedPathsComplete: f.complete,
  });

  let verdict = decide(facts(s.pr), { markReady: true });
  log("eligibility", { eligible: verdict.eligible, flags: verdict.flags, rules: verdict.rules });
  if (!verdict.eligible) return { ok: false, login, refused: true, steps };

  if (s.pr.isDraft) {
    if (dryRun) {
      log("mark-ready", { skipped: "dry run" });
    } else {
      const m = await client.graphql(MARK_READY_MUTATION, { id: s.pr.id });
      log("mark-ready", m.ok ? { ok: true, isDraft: m.data.markPullRequestReadyForReview.pullRequest.isDraft } : { ok: false, status: m.status, errors: m.errors });
      if (!m.ok) return { ok: false, login, steps };
      // mergeStateStatus can be UNKNOWN briefly after a change; re-read a few times.
      for (let i = 0; i < 5; i++) {
        ({ s, f, b } = await read());
        if (s.ok && s.pr.mergeStateStatus !== "UNKNOWN" && s.pr.mergeStateStatus !== "DRAFT") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      log("re-read-pr", { pr: summarize(s.pr) });
      verdict = decide(facts(s.pr), { markReady: false });
      log("eligibility-after-ready", { eligible: verdict.eligible, rules: verdict.rules });
      if (!verdict.eligible) return { ok: false, login, refused: true, steps };
    }
  }

  const mergePath = `/repos/${owner}/${name}/pulls/${number}/merge`;
  if (dryRun) {
    log("merge", { skipped: "dry run" });
    return { ok: true, dryRun: true, login, steps };
  }

  if (probeStaleSha) {
    // A SHA that cannot be the head: GitHub must answer 409 and merge nothing.
    const bogus = "0".repeat(40);
    const p = await client.call("PUT", mergePath, { sha: bogus, merge_method: mergeMethod });
    log("stale-sha-probe", { status: p.status, message: p.body?.message, expected: 409 });
    // Only a 409 shows GitHub refused the mismatched sha; anything else proves nothing, so stop.
    if (p.status !== 409) {
      return { ok: false, login, steps, error: p.status === 200 ? "merged despite a wrong sha — the guard failed" : `the wrong-sha probe got ${p.status}, not 409 — the guard is unproven` };
    }
  }

  const m = await client.call("PUT", mergePath, { sha: expectedSha, merge_method: mergeMethod });
  log("merge", { status: m.status, merged: m.body?.merged, sha: m.body?.sha, message: m.body?.message });
  if (m.status !== 200) return { ok: false, login, steps };

  const after = await client.call("GET", `/repos/${owner}/${name}/pulls/${number}`);
  const mergedBy = after.body?.merged_by?.login ?? null;
  log("merged-by", { status: after.status, mergedBy, mergeCommitSha: after.body?.merge_commit_sha, attributedToPerson: mergedBy === login });
  return { ok: mergedBy === login, login, mergedBy, steps };
}

function summarize(pr) {
  return {
    state: pr.state,
    isDraft: pr.isDraft,
    headRefOid: pr.headRefOid,
    mergeStateStatus: pr.mergeStateStatus,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    viewerCanMergeAsAdmin: pr.viewerCanMergeAsAdmin,
    author: pr.author?.login,
  };
}
