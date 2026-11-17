/**
 * The operator documentation names environment variables, and until now nothing checked those
 * names against what a deployable actually refuses to start without.
 *
 * The specific bug this exists to prevent is subtle and was very nearly shipped in the other
 * direction: grepping `apps/ingress/src` and `apps/ingress/api` for `process.env` finds only
 * `DATABASE_URL` and `GITHUB_WEBHOOK_SECRET`, which reads as proof that the
 * ingress does not want the App's credentials. It does. `apps/ingress/api/webhook.ts` calls
 * `githubClientFromEnv()` at module scope, and that reads `GITHUB_APP_ID` and
 * `GITHUB_APP_PRIVATE_KEY` through `loadGitHubConfig` — a name no file under `apps/ingress`
 * mentions. A grep-based check would have confirmed a false answer.
 *
 * So this test does not grep. It **initialises the built function**, once per variable, with
 * that variable removed, and asks the module itself whether it can start. The module scope is
 * where the ingress reads its configuration, and nothing there opens a socket (`new Pool` is
 * lazy, and the workflow provider is started on first use), so importing it is cheap and
 * exercises exactly the code path Vercel runs on a cold start.
 *
 * The assertion is two-directional, because both directions cost an operator real time:
 *
 * - A variable the table marks **required** that the function starts happily without is a
 *   document sending someone to hunt down a credential nothing reads.
 * - A variable the function refuses to start without that the table **omits** is a deployment
 *   that 500s on its first delivery, with GitHub retrying into a wall.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

/** The built Vercel entry point — the artefact that is actually deployed, not the source. */
const INGRESS_ENTRY = join(repoRoot, "apps", "ingress", "dist", "api", "webhook.js");

/**
 * A complete, syntactically valid environment. The private key must be a real one:
 * `normalizePrivateKey` parses it, so a placeholder string would fail for the wrong reason and
 * make every variable look required.
 */
function completeIngressEnv() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    DATABASE_URL: "postgresql://user:password@localhost:5432/windkeel",
    GITHUB_WEBHOOK_SECRET: "a-webhook-secret",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * Imports the entry point in a child process with exactly `env` set, and returns the error
 * message if module initialisation threw.
 *
 * A child process rather than a dynamic import in-process for two reasons: ESM caches a module
 * after its first evaluation, so the second variable would never be tested; and the parent's own
 * environment would leak in, which is the failure mode where a test passes on a laptop that
 * happens to have `GITHUB_APP_ID` exported and fails in CI.
 */
function initialiseIngress(env) {
  const script =
    `import(${JSON.stringify(INGRESS_ENTRY)})` +
    `.then(() => process.stdout.write("OK"))` +
    `.catch((error) => process.stdout.write("THREW:" + error.message))`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    // `env:` replaces rather than extends, which is the isolation this needs. PATH and HOME are
    // carried because node wants them; neither is configuration the ingress reads.
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    encoding: "utf8",
  });
  return output.startsWith("THREW:") ? output.slice("THREW:".length) : null;
}

/**
 * Parses `| \`NAME\` | yes |` / `| \`NAME\` | no |` rows out of the markdown tables in a
 * document section, keyed by the heading the section starts at. Returns `{ required, optional }`.
 */
function documentedVariables(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `heading not found: ${heading}`);
  const rest = markdown.slice(start + heading.length);
  const nextHeading = rest.search(/\n#{2,3} /);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const required = new Set();
  const optional = new Set();
  for (const line of section.split("\n")) {
    const row = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*(yes|no)\s*\|/.exec(line.trim());
    if (!row) continue;
    (row[2] === "yes" ? required : optional).add(row[1]);
  }
  assert.ok(required.size > 0, `no required variables parsed under "${heading}"`);
  return { required, optional };
}

const DOCS = [
  {
    file: join("docs", "github-app.md"),
    heading: "### The ingress (Vercel, `apps/ingress`)",
  },
  {
    file: join("docs", "webhook-ingress.md"),
    heading: "## Environment",
  },
];

/**
 * Determined once, from the deployable itself, and then compared against every document that
 * claims to describe it. This is the only place in this file that decides what is true.
 */
function ingressRequiredVariables() {
  const complete = completeIngressEnv();
  assert.equal(
    initialiseIngress(complete),
    null,
    "the ingress entry point does not initialise even with every documented variable set — " +
      "the test's environment is wrong, not the documentation",
  );

  const required = new Map();
  for (const name of Object.keys(complete)) {
    const withoutIt = { ...complete };
    delete withoutIt[name];
    const error = initialiseIngress(withoutIt);
    if (error !== null) required.set(name, error);
  }
  return required;
}

test("the ingress refuses to initialise without exactly the variables the docs call required", () => {
  const required = ingressRequiredVariables();

  // Recorded as an explicit list, not just compared doc-to-doc: two documents can agree with
  // each other and both be wrong, which is the state this test was written to end.
  assert.deepEqual(
    [...required.keys()].sort(),
    ["DATABASE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
    "the set of variables apps/ingress/dist/api/webhook.js will not start without has changed. " +
      "If that was deliberate, update docs/github-app.md §3 and docs/webhook-ingress.md in the " +
      "same commit — an operator who trusts either table and gets a 500 on every delivery has " +
      "no way to find out why.",
  );

  // Every message names its own variable. A cold start that fails saying only "config error"
  // is a Vercel log an operator cannot act on.
  for (const [name, message] of required) {
    assert.match(
      message,
      new RegExp(name),
      `initialising without ${name} failed with a message that does not name it: ${message}`,
    );
  }
});

for (const { file, heading } of DOCS) {
  test(`${file} lists exactly what the ingress requires`, () => {
    const markdown = readFileSync(join(repoRoot, file), "utf8");
    const { required: documented, optional } = documentedVariables(markdown, heading);
    const actual = ingressRequiredVariables();

    for (const name of actual.keys()) {
      assert.ok(
        documented.has(name),
        `${file} does not list ${name} as required, but the ingress will not initialise ` +
          `without it: ${actual.get(name)}`,
      );
    }
    for (const name of documented) {
      assert.ok(
        actual.has(name),
        `${file} marks ${name} required for the ingress, but the function initialises fine ` +
          "without it. Either it is optional (move it to a `no` row) or it belongs to the " +
          "worker's table instead.",
      );
    }
    // Optional rows are documentation, not a contract — but one that is secretly required is
    // the same 500 as an omitted one, so it gets checked too.
    for (const name of optional) {
      assert.ok(
        !actual.has(name),
        `${file} marks ${name} optional, but the ingress refuses to initialise without it.`,
      );
    }
  });
}

/**
 * #229's claim, asserted rather than trusted: the webhook-delivery check adds **no new secret
 * and no new App permission**.
 *
 * `GET /app/hook/config` and `GET /app/hook/deliveries` are available to a JWT-authenticated
 * App, which is the same credential `windkeel doctor` already mints for its ADR-0009 permission
 * check. If that ever stopped being true, the check would start reading a variable of its own —
 * and the first sign would be an operator's deployment failing on a credential no document
 * mentions, which is exactly the class of bug this file exists to prevent.
 */
test("the webhook-delivery check reads no environment variable of its own", () => {
  const source = readFileSync(join(repoRoot, "src", "github", "app-deliveries.ts"), "utf8");

  assert.ok(
    !/process\.env/.test(source),
    "app-deliveries.ts reads process.env directly. Its configuration must arrive as the " +
      "GitHubConfig doctor already loads, or the 'no new secret' claim in #229 is false.",
  );
  assert.match(
    source,
    /createAppJwt/,
    "the check must authenticate as the App, using the credential doctor already has",
  );
  assert.ok(
    !/mintInstallationToken|installations\//.test(source),
    "an installation token would mean a permission grant; the App's own JWT needs none",
  );
});
