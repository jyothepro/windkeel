// A stub flow driver stands in for `npx playwright test` so the corpus stays deterministic
// and dependency-free. What the browser stage contracts on is this script's exit code and
// the artifacts it leaves behind, and both are exercised faithfully here.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("test-results", { recursive: true });
writeFileSync("test-results/checkout-step-3.png", "screenshot placeholder\n");
writeFileSync("test-results/trace.txt", "goto /cart\nclick #checkout\nfill #card\n");
process.stdout.write("checkout: 3 of 4 steps ran\n");
process.stdout.write("checkout: FAILED at step 4 - order confirmation never rendered\n");
process.exit(1);
