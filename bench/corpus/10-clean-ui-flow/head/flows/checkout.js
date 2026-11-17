// Stub flow driver: see 09-broken-ui-flow. This one completes, so the control proves a
// green flow reaches a pass rather than only proving a red flow blocks.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("test-results", { recursive: true });
writeFileSync("test-results/checkout-confirmation.png", "screenshot placeholder\n");
writeFileSync("test-results/trace.txt", "goto /cart\nclick #checkout\nfill #card\nclick #place-order\n");
process.stdout.write("checkout: 4 of 4 steps ran\n");
process.stdout.write("checkout: order confirmation rendered\n");
