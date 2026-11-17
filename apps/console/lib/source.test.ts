import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSource } from "./source.ts";
import { lastOutcomeText } from "./schedules.ts";
import { previewTimes } from "./fixtures.ts";

const task = (sourceType: string, sourceReference = "", sourceContext: Record<string, unknown> = {}) => ({ sourceType, sourceReference, sourceContext });

test("each source has its badge, and a link back where its context allows", () => {
  assert.deepEqual(describeSource(task("github_issue", "jyothepro/windkeel#260")), {
    kind: "github",
    label: "GitHub",
    detail: "jyothepro/windkeel#260",
    href: "https://github.com/jyothepro/windkeel/issues/260",
    external: true,
  });

  const slack = describeSource(task("slack", "slack:T1:C2:1.2", { teamId: "T0ACME", channelId: "C0123", threadTs: "1790000000.000100" }));
  assert.equal(slack.label, "Slack");
  assert.equal(slack.href, "https://slack.com/app_redirect?team=T0ACME&channel=C0123");
  assert.equal(slack.detail, "#C0123");

  const linear = describeSource(task("linear", "linear:o:i", { identifier: "ENG-142", url: "https://linear.app/acme/issue/ENG-142" }));
  assert.equal(linear.href, "https://linear.app/acme/issue/ENG-142");
  assert.equal(linear.detail, "ENG-142");

  const jira = describeSource(task("jira", "jira:c:OPS-88", { cloudId: "c", issueKey: "OPS-88", siteUrl: "https://acme.atlassian.net/" }));
  assert.equal(jira.href, "https://acme.atlassian.net/browse/OPS-88");

  const tabs = ["general", "tokens", "schedules", "webhooks"];
  assert.deepEqual(describeSource(task("schedule", "schedule:s:t", { scheduleId: "s" }), tabs), {
    kind: "schedule",
    label: "Schedule",
    detail: null,
    href: "/settings/schedules",
    external: false,
  });
  assert.equal(describeSource(task("webhook", "webhook:e:x"), tabs).href, "/settings/webhooks");
  assert.deepEqual([describeSource(task("api")).label, describeSource(task("api")).href], ["API", null]);
  assert.equal(describeSource(task("local")).label, "Local");
  assert.equal(describeSource(task("carrier_pigeon")).label, "carrier_pigeon");
});

test("a Schedule or Webhook badge links only to a tab the viewer can open", () => {
  const member = ["general", "tokens", "integrations", "schedules"];
  assert.equal(describeSource(task("schedule"), member).href, "/settings/schedules");
  assert.equal(describeSource(task("webhook"), member).href, null);
  assert.equal(describeSource(task("webhook"), member).label, "Webhook");
  assert.equal(describeSource(task("schedule")).href, null);
});

test("Jira links use only the site's origin; Linear links only Linear's hosts", () => {
  const jira = (siteUrl: string) => describeSource(task("jira", "", { issueKey: "OPS-88", siteUrl })).href;
  assert.equal(jira("https://acme.atlassian.net/some/path?x=1#frag"), "https://acme.atlassian.net/browse/OPS-88");
  assert.equal(jira("https://acme.atlassian.net"), "https://acme.atlassian.net/browse/OPS-88");
  const linear = (url: string) => describeSource(task("linear", "", { url })).href;
  assert.equal(linear("https://linear.app/acme/issue/ENG-1"), "https://linear.app/acme/issue/ENG-1");
  assert.equal(linear("https://evil.example/linear.app/issue"), null);
  assert.equal(linear("https://linear.app.evil.example/x"), null);
});

test("a link is offered only when the context allows one, and only over https", () => {
  assert.equal(describeSource({ sourceType: "linear", sourceReference: "linear:o:i" }).href, null);
  assert.equal(describeSource(task("slack", "", { teamId: "T1" })).href, null);
  assert.equal(describeSource(task("jira", "", { issueKey: "OPS-1" })).href, null);
  assert.equal(describeSource(task("linear", "", { url: "javascript:alert(1)" })).href, null);
  assert.equal(describeSource(task("linear", "", { url: "http://linear.app/x" })).href, null);
  assert.equal(describeSource(task("jira", "", { issueKey: "OPS-1", siteUrl: "javascript:alert(1)//" })).href, null);
  assert.equal(describeSource(task("jira", "", { issueKey: "../../evil", siteUrl: "https://acme.atlassian.net" })).href, null);
  assert.equal(describeSource(task("github_issue", "not a reference")).href, null);
});

test("a schedule's last outcome, in words", () => {
  assert.deepEqual(lastOutcomeText(null), { text: "Hasn't fired yet", intent: "neutral" });
  assert.equal(lastOutcomeText("created").intent, "success");
  assert.match(lastOutcomeText("ignored:previous_run_in_flight").text, /previous run is still open/);
  assert.equal(lastOutcomeText("ignored:repository_not_granted").intent, "danger");
  assert.match(lastOutcomeText("failed:503").text, /503/);
  assert.equal(lastOutcomeText("something_new").text, "something_new");
});

test("sample mode's cron preview reads the zone it is given", () => {
  const berlin = previewTimes("0 3 * * *", "Europe/Berlin", 3);
  assert.equal(berlin.length, 3);
  for (const t of berlin) {
    const hour = new Date(t).toLocaleString("en-US", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" });
    assert.equal(Number(hour), 3);
  }
  assert.equal(previewTimes("*/15 * * * *", "UTC", 2).length, 2);
  assert.throws(() => previewTimes("61 * * * *", "UTC", 1), { code: "invalid_cron" });
  assert.throws(() => previewTimes("* * *", "UTC", 1), { code: "invalid_cron" });
  assert.throws(() => previewTimes("0 3 * * *", "Mars/Olympus", 1), { code: "invalid_timezone" });
});

test("a batch child's badge links to its batch in the console", () => {
  const id = "0b8a2f1e-1111-4222-8333-944445555666";
  assert.deepEqual(describeSource(task("batch", `batch:${id}:0`, { batchId: id, ordinal: 0 })), {
    kind: "batch",
    label: "Batch",
    detail: null,
    href: `/batches/${id}`,
    external: false,
  });
  assert.equal(describeSource(task("batch", "batch:x:0", { batchId: "javascript:alert(1)" })).href, null);
});
