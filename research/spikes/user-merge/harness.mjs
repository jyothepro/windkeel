#!/usr/bin/env node
/**
 * Spike C (#370) live harness: device-flow user authorization → user-to-server token →
 * ADR-0029 §5 eligibility → mark ready → merge with the sha guard → merged_by is the person.
 *
 *   GITHUB_APP_CLIENT_ID=Iv23... \
 *   node research/spikes/user-merge/harness.mjs --repo owner/name --pr 12 --sha <verified head sha> [--dry-run]
 *
 * Options:
 *   --repo owner/name      repository the App is installed on (required)
 *   --pr N                 pull request number (required)
 *   --sha SHA              the "verified candidate" SHA; stands in for the verdict of record's (required)
 *   --verdict pass|warn    stand-in verdict of record (default pass)
 *   --ack id1,id2          acknowledgements for --needs-a-look items
 *   --needs-a-look a,b     stand-in Needs-a-look item ids for a warn
 *   --workflows-permission write   say the App holds Workflows: write (default: none, as ADR-0009)
 *   --merge-method squash|merge|rebase (default squash)
 *   --no-stale-probe       skip the wrong-sha 409 probe
 *   --dry-run              authorize and evaluate; perform no mutation
 *   --out FILE             write the results JSON there (default research/spikes/user-merge/results-<ts>.json)
 *
 * Env: GITHUB_APP_CLIENT_ID (required). GITHUB_APP_CLIENT_SECRET is not needed for device flow and
 * is never read here. github.com only: GitHub Enterprise Server is not supported (its device flow,
 * REST and GraphQL live at different bases).
 *
 * The token is held in memory for this process only. It is never printed, logged or written:
 * the results file carries logins, statuses and SHAs.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateMergeEligibility } from "./eligibility.mjs";
import { deviceFlow, redact, runMergeSequence, userClient } from "./github-user.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    pr: { type: "string" },
    sha: { type: "string" },
    verdict: { type: "string", default: "pass" },
    ack: { type: "string", default: "" },
    "needs-a-look": { type: "string", default: "" },
    "workflows-permission": { type: "string" },
    "merge-method": { type: "string", default: "squash" },
    "no-stale-probe": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const clientId = process.env.GITHUB_APP_CLIENT_ID;
if (!clientId || !values.repo || !values.pr || !values.sha) {
  console.error("usage: GITHUB_APP_CLIENT_ID=... node harness.mjs --repo owner/name --pr N --sha <verified sha> [--dry-run]");
  process.exit(2);
}

let token = null;
try {
  const set = await deviceFlow({
    clientId,
    onPrompt: ({ userCode, verificationUri, expiresIn }) =>
      console.error(`\nOpen ${verificationUri} and enter ${userCode} (expires in ${Math.round(expiresIn / 60)} min). Waiting...\n`),
  });
  token = set.accessToken;
  console.error(
    `Authorized. Token expires in ${set.expiresIn ?? "never (expiration opted out)"} s; refresh token ${set.refreshToken ? "issued" : "not issued"}; scope="${set.scope}".`,
  );

  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const stand = {
    verdictOfRecord: {
      candidateSha: values.sha,
      verdict: values.verdict,
      needsALook: list(values["needs-a-look"]).map((id) => ({ id })),
    },
    acknowledgements: list(values.ack),
    principal: { permissions: ["runs.merge"] },
    org: { allowMergingFromWindkeel: true },
    app: { workflowsPermission: values["workflows-permission"] ?? null },
  };

  const result = await runMergeSequence({
    client: userClient({ token }),
    repo: values.repo,
    number: Number(values.pr),
    expectedSha: values.sha,
    dryRun: values["dry-run"],
    mergeMethod: values["merge-method"],
    probeStaleSha: !values["no-stale-probe"],
    decide: (pr, { markReady }) => evaluateMergeEligibility({ ...stand, pr, markReady }),
  });

  const record = {
    spike: "#370",
    at: new Date().toISOString(),
    repo: values.repo,
    pr: Number(values.pr),
    standIns: { ...stand, note: "verdict/permission/org flag are stand-ins; PR state is live" },
    tokenShape: { expiresIn: set.expiresIn ?? null, refreshTokenIssued: Boolean(set.refreshToken), refreshTokenExpiresIn: set.refreshTokenExpiresIn ?? null, scope: set.scope },
    result,
  };
  const out = values.out ?? join(here, `results-${record.at.replace(/[:.]/g, "-")}.json`);
  const text = redact(JSON.stringify(record, null, 2), [token, set.refreshToken]);
  writeFileSync(out, text + "\n");
  console.log(text);
  console.error(`\nWrote ${out}`);
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(redact(err?.stack ?? String(err), [token]));
  process.exit(1);
}
