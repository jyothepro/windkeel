

import { registerIntakeSource } from "@windkeel/factory/intake";
import { createSentryIntakeSource } from "@windkeel/factory/integrations";
import { intakeStartRun } from "./intake-enqueuer.js";

export function registerSentryIntakeSource(): void {
  registerIntakeSource(createSentryIntakeSource({ startRun: intakeStartRun }));
}
