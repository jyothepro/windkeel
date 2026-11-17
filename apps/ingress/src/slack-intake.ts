

import { registerIntakeSource } from "@windkeel/factory/intake";
import { createSlackIntakeSource } from "@windkeel/factory/intake";
import { startSlackMentionFeedback } from "@windkeel/factory/workflow";
import { intakeStartRun } from "./intake-enqueuer.js";

export function registerSlackIntakeSource(): void {
  registerIntakeSource(
    createSlackIntakeSource({
      startRun: intakeStartRun,
      startFeedback: (deliveryKey) => startSlackMentionFeedback(deliveryKey),
      feedbackEnabled: () => Boolean(process.env["WINDKEEL_CONNECT_SLACK"]?.trim()),
    }),
  );
}
