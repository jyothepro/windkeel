

import { registerIntakeSource } from "@windkeel/factory/intake";
import { createWebhookIntakeSource } from "@windkeel/factory/intake";
import { webhookSigningKeyFromEnv } from "@windkeel/factory/intake";
import { registerLinearIntakeSource } from "./linear-intake.js";
import { registerJiraIntakeSource } from "./jira-intake.js";
import { registerSlackIntakeSource } from "./slack-intake.js";
import { registerSentryIntakeSource } from "./sentry-intake.js";
import { intakeStartRun as startRun } from "./intake-enqueuer.js";

export function registerDeploymentIntakeSources(): void {

  registerIntakeSource(createWebhookIntakeSource({ signingKey: () => webhookSigningKeyFromEnv(), startRun }));
  registerLinearIntakeSource();
  registerJiraIntakeSource();
  registerSlackIntakeSource();
  registerSentryIntakeSource();
}
