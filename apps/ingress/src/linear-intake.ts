

import { registerIntakeSource } from "@windkeel/factory/intake";
import { createLinearIntakeSource } from "@windkeel/factory/intake";
import { VercelConnectTokenSource } from "@windkeel/factory/integrations";
import { intakeStartRun } from "./intake-enqueuer.js";

export function registerLinearIntakeSource(): void {
  registerIntakeSource(
    createLinearIntakeSource({
      startRun: intakeStartRun,
      tokenSource: new VercelConnectTokenSource(),
    }),
  );
}
