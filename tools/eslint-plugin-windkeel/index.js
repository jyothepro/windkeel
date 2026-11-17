import consoleNoServerImports from "./rules/console-no-server-imports.js";
import flowImportsOnlySleep from "./rules/flow-imports-only-sleep.js";
import noAmbientNondeterminism from "./rules/no-ambient-nondeterminism.js";
import noComments from "./rules/no-comments.js";
import noDirectRunStatusWrite from "./rules/no-direct-run-status-write.js";
import reviewerOutputFloor from "./rules/reviewer-output-floor.js";

export const rules = {
  "no-comments": noComments,
  "no-direct-run-status-write": noDirectRunStatusWrite,
  "flow-imports-only-sleep": flowImportsOnlySleep,
  "no-ambient-nondeterminism": noAmbientNondeterminism,
  "console-no-server-imports": consoleNoServerImports,
  "reviewer-output-floor": reviewerOutputFloor,
};

const plugin = { meta: { name: "eslint-plugin-windkeel", version: "0.0.0" }, rules };

export default plugin;
