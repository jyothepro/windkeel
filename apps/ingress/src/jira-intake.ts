

import { registerIntakeSource } from "@windkeel/factory/intake";
import { createJiraIntakeSource } from "@windkeel/factory/integrations";
import { VercelConnectTokenSource } from "@windkeel/factory/integrations";
import { intakeStartRun } from "./intake-enqueuer.js";

export function registerJiraIntakeSource(): void {
  registerIntakeSource(
    createJiraIntakeSource({
      startRun: intakeStartRun,
      tokens: new VercelConnectTokenSource(),
    }),
  );
}
