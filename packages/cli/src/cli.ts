#!/usr/bin/env node
import "@windkeel/verification/env-compat.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { annotate } from "./commands/annotate.js";
import { formatReport, runBench } from "./commands/bench.js";
import { formatReplay, runReplay } from "./commands/replay.js";
import { verify } from "./commands/verify.js";
import { verifyPackage } from "./commands/verifyPackage.js";
import {
  AUTH_USAGE,
  REMOTE_USAGE,
  consoleIo,
  printRefusal,
} from "./commands/remote.js";
import {
  BUNDLE_REF,
  GITHUB_ACTIONS_ISSUER_REGEXP,
  githubWorkflowIdentityRegexp,
  signPackage,
} from "@windkeel/verification/attest/sigstore.js";
import {
  InvalidGateLevelError,
  gateDecision,
  parseGateLevel,
} from "@windkeel/verification/evidence/gate.js";
import { SPINE_FILES, isEvidencePackage, seal } from "@windkeel/verification/evidence/package.js";
import { TOOL_VERSION } from "@windkeel/verification/version.js";
import { parseArgs, stringFlag, type Args } from "./cli-args.js";

const USAGE = `windkeel ${TOOL_VERSION}

Usage:
  windkeel verify [--repo <dir>] [--out <dir>] [--pr-body <file>] [--issue-body <file>]
               [--intent <file>] [--gate[=fail|criteria|warn]]
      Run the verification pipeline against a checkout and write an evidence package.
      With --gate, exit 1 when the verdict is "fail". See "gate levels" below.

  windkeel verify-package <package-dir> [--gate[=fail|criteria|warn]] [--require-signature]
                       [--certificate-identity <regex>] [--certificate-oidc-issuer <regex>]
                       [--certificate-github-repo <owner/repo>]
      Recompute hashes and verdict for an existing package, and verify its Sigstore
      bundle offline against the expected signer. Identity regexes are anchored at the
      start; --certificate-github-repo builds the fully anchored GitHub Actions identity
      (^https://github.com/OWNER/REPO/.github/workflows/) and issuer for you.
      With --require-signature, a package that is unsigned — or whose signature could not
      be checked against an expected signer — is an integrity failure, not a note.
      Exit 0 clean, 1 gating, 3 on integrity failure.

  gate levels
      A criterion the evidence could not settle is "unknown", and an unknown warns rather
      than fails — inside the factory that is right, because it sends the change to a
      person instead of to a repair loop that could never satisfy it. A CI gate has no
      person, so it can ask for more:

        --gate            exit 1 only on a "fail" verdict. The historical meaning, unchanged.
        --gate=fail       the same thing, said out loud.
        --gate=criteria   also exit 1 when any criterion was never settled, naming each one.
                          A non-blocking finding or an incomplete stage still passes: those
                          are judgements someone made, not judgements nobody made.
        --gate=warn       exit 1 on anything that is not a clean "pass".

      Gating is exit 1 in every case. Exit 3 is an integrity failure — a package that does
      not verify against itself — and is a different kind of problem.

  windkeel annotate <package-dir>
      Emit GitHub Actions annotations for findings and unmet criteria, and append a
      job summary to $GITHUB_STEP_SUMMARY.

  windkeel bench [<corpus-dir>] [--json] [--min-catch <0-1>] [--max-false-positive <0-1>]
              [--require-tools]
      Replay the benchmark corpus and report catch rate, false-positive rate, and
      evidence completeness. Exit 1 when a threshold is not met. Cases needing a tool
      this runner lacks are reported unscored; --require-tools makes that an error.

  windkeel replay [<cases-dir>] [--json] [--cache <dir>] [--out <dir>]
      Replay real merged pull requests whose defects surfaced only after merge, and
      report what the gate says about each. Needs network access to fetch the upstream
      commits, and a reviewer credential to be more than a harness check — so it is
      observational and runs outside CI.

  windkeel bench-factory [<tasks-dir>] [--json] [--out <dir>] [--only <id,...>] [--concurrency <n>]
                      [--dry-run | --check-hidden] [--task-cap-usd <usd>] [--total-cap-usd <usd>]
                      [--poll <ms>]
      Run whole tasks end to end on a deployed factory (WINDKEEL_API_URL) and report the
      success rate, the verifier's false-accept and false-reject rates against hidden
      tests, repair conversion, and cost and time per task. Hidden tests run locally
      afterwards, in a throwaway clone of the delivered head, with a scrubbed environment.
      Caps default to $2 a task and $50 a run. --dry-run validates the tasks and prints
      the plan without submitting anything. --check-hidden clones each task and checks its
      hidden tests fail on the base and pass on its reference solution (runs repo code,
      spends nothing); a live run does the same check first and never submits a task
      that fails it. Observational: a live run needs a deployment and money.

  windkeel sign <package-dir> [--expect-head-sha <sha>] [--expect-repo <repo>] [--verify-only]
      Keyless-sign a package sealed elsewhere, without resealing it: refuses one that
      does not verify (exit 3) or is about another commit. Exit 1 when it could not sign.
      --verify-only runs every check and stops before signing.
      This is what the Action's seal job runs, away from the candidate's code.

  windkeel seal <package-dir> [--sign]
      Rewrite hashes.json and the attestation after editing package files.
      With --sign, keyless-sign the attestation via Sigstore (needs cosign and an
      ambient OIDC identity; a local run stays unsigned rather than failing).

  ${AUTH_USAGE}

  ${REMOTE_USAGE}

  windkeel audit export [--since <date>] [--until <date>] [--format jsonl|csv] [--org <id>]
  windkeel audit verify
      Export the account's audit log to stdout (every part of a long range), or check
      its hash chain. Needs audit.read through an account role; --org exports one
      organization's events with audit.read there.

  windkeel mcp [--org <id>]
      Serve Windkeel's control plane as MCP tools on stdio, so Claude Code or Codex can
      submit work, follow a run and read a verdict. Uses the same credential as every
      other command, and lists only the tools that credential's permissions allow — a
      read-only token gives an agent a read-only Windkeel. See docs/agent-integration.md.

  talking to a deployed factory
      Every command above "login" works on your own machine with no server, no token
      and no network — that is the local PR gate. The commands from "login"
      onwards talk to a deployment over HTTP. On your own machine, sign in once:

        windkeel login --url https://your-ingress.vercel.app

      In CI, or for an agent, set two variables instead. They win over a stored login
      whenever they are set:

        WINDKEEL_API_URL     https://your-ingress.vercel.app
        WINDKEEL_API_TOKEN   a token from "windkeel token create"
        WINDKEEL_ORG         optional: the organization to act on (or --org <id>)

      The URL has no default. A CLI that quietly assumed localhost would, on the day you
      meant production, report an empty factory — which reads as "nothing is running"
      rather than "you are talking to the wrong machine". The stored login lives in
      $XDG_CONFIG_HOME/windkeel (else ~/.config/windkeel), or $WINDKEEL_CONFIG_DIR.
`;

const REMOTE_COMMANDS = new Set([
  "audit",
  "runs",
  "queue",
  "show",
  "watch",
  "attempts",
  "approve",
  "cancel",
  "say",
  "messages",
  "secrets",
  "secret",
  "env",
  "submit",
  "task",
  "metrics",
  "usage",
  "billing",
  "reap",
  "capture",
  "whoami",
  "token",
  "org",
  "member",
  "service-principal",
  "integration",
  "schedule",
  "batch",
  "webhook",
  "models",
  "playbook",
]);

function expectedSigner(
  args: Args,
): { identity: string | undefined; issuer: string | undefined } | { error: string } {
  const repo = stringFlag(args, "certificate-github-repo");
  const identity = stringFlag(args, "certificate-identity");
  const issuer = stringFlag(args, "certificate-oidc-issuer");
  if (!repo) return { identity, issuer };
  if (identity) return { error: "give --certificate-github-repo or --certificate-identity, not both" };
  try {
    return {
      identity: githubWorkflowIdentityRegexp(repo, process.env["GITHUB_SERVER_URL"] || undefined),
      issuer: issuer ?? GITHUB_ACTIONS_ISSUER_REGEXP,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  if (command === undefined || command === "help" || args.flags.has("help")) {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }

  let gate;
  try {
    gate = parseGateLevel(args.flags.get("gate"));
  } catch (error) {
    if (!(error instanceof InvalidGateLevelError)) throw error;
    process.stderr.write(`windkeel: ${error.message}\n`);
    return 2;
  }
  if (command === "verify") {
    const repo = resolve(stringFlag(args, "repo") ?? process.cwd());
    const out = resolve(stringFlag(args, "out") ?? ".windkeel/evidence");
    const result = await verify({
      repo,
      out,
      prBodyFile: stringFlag(args, "pr-body"),
      issueBodyFile: stringFlag(args, "issue-body"),
      intentFile: stringFlag(args, "intent"),
    });
    process.stdout.write(
      `verdict: ${result.verdict.toUpperCase()}\npackage: ${result.out}\nsignature: ${
        result.signature.signed ? result.signature.reason : `unsigned — ${result.signature.reason}`
      }\n`,
    );
    const decision = gateDecision(gate, result.verdict, result.mapping);
    if (decision.lines.length) process.stdout.write(decision.lines.join("\n") + "\n");
    return decision.gated ? 1 : 0;
  }

  if (command === "verify-package") {
    const dir = args.positional[0];
    if (!dir) {
      process.stderr.write(USAGE);
      return 2;
    }
    const packageDir = resolve(dir);

    if (!isEvidencePackage(packageDir)) {
      process.stderr.write(
        `windkeel: not an evidence package (none of ${SPINE_FILES.join(", ")}): ${packageDir}\n`,
      );
      return 2;
    }
    const signer = expectedSigner(args);
    if ("error" in signer) {
      process.stderr.write(`windkeel: ${signer.error}\n`);
      return 2;
    }
    const report = verifyPackage(packageDir, {
      certificateIdentity: signer.identity,
      certificateOidcIssuer: signer.issuer,
      requireSignature: args.flags.has("require-signature"),
    });
    const decision = gateDecision(gate, report.verdict, report.mapping);
    process.stdout.write([...report.lines, ...decision.lines].join("\n") + "\n");

    if (report.problems.length) return 3;
    return decision.gated ? 1 : 0;
  }

  if (command === "annotate") {
    const dir = args.positional[0];
    if (!dir || !existsSync(join(resolve(dir), "manifest.json"))) {
      process.stderr.write(`not an evidence package: ${dir ?? "(no directory given)"}\n`);
      return 2;
    }
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    const lines = annotate(resolve(dir), summaryPath);
    process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
    return 0;
  }

  if (command === "bench") {
    const corpus = resolve(args.positional[0] ?? "bench/corpus");
    if (!existsSync(corpus)) {
      process.stderr.write(`no corpus at ${corpus}\n`);
      return 2;
    }
    const report = await runBench(corpus);
    process.stdout.write(
      args.flags.has("json")
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatReport(report)}\n`,
    );
    const minCatch = Number(stringFlag(args, "min-catch") ?? 1);
    const maxFalsePositive = Number(stringFlag(args, "max-false-positive") ?? 0);

    if (args.flags.has("require-tools") && report.skipped.length) {
      process.stderr.write(
        `windkeel: ${report.skipped.length} corpus case(s) could not run: ${report.skipped
          .map((s) => `${s.id} (${s.reason})`)
          .join("; ")}\n`,
      );
      return 1;
    }
    return report.catch_rate < minCatch || report.false_positive_rate > maxFalsePositive ? 1 : 0;
  }

  if (command === "replay") {
    const cases = resolve(args.positional[0] ?? "bench/replay/cases");
    if (!existsSync(cases)) {
      process.stderr.write(`no replay cases at ${cases}\n`);
      return 2;
    }
    const cache = resolve(stringFlag(args, "cache") ?? join(tmpdir(), "windkeel-replay-cache"));
    const outFlag = stringFlag(args, "out");
    const report = await runReplay(cases, cache, outFlag ? resolve(outFlag) : undefined);
    process.stdout.write(
      args.flags.has("json")
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatReplay(report)}\n`,
    );

    return report.errors ? 1 : 0;
  }

  if (command === "bench-factory") {
    const { BenchFactoryCommandError, benchFactoryCommand } = await import("./commands/bench-factory-command.js");
    try {
      return await benchFactoryCommand({
        tasksDir: resolve(args.positional[0] ?? "bench/factory/tasks"),
        json: args.flags.has("json"),
        dryRun: args.flags.has("dry-run"),
        checkHidden: args.flags.has("check-hidden"),
        out: stringFlag(args, "out"),
        only: stringFlag(args, "only"),
        concurrency: stringFlag(args, "concurrency"),
        taskCapUsd: stringFlag(args, "task-cap-usd"),
        totalCapUsd: stringFlag(args, "total-cap-usd"),
        pollMs: stringFlag(args, "poll"),
      });
    } catch (error) {
      if (!(error instanceof BenchFactoryCommandError)) throw error;
      process.stderr.write(`windkeel: ${error.message}\n`);
      return 2;
    }
  }

  if (command === "sign") {
    const dir = args.positional[0];
    if (!dir) {
      process.stderr.write(USAGE);
      return 2;
    }
    const packageDir = resolve(dir);
    if (!isEvidencePackage(packageDir)) {
      process.stderr.write(`windkeel: not an evidence package: ${packageDir}\n`);
      return 2;
    }
    if (existsSync(join(packageDir, BUNDLE_REF))) {
      process.stderr.write(`windkeel: ${packageDir} already carries a Sigstore bundle; refusing to sign it again\n`);
      return 2;
    }
    const report = verifyPackage(packageDir, {});
    if (report.problems.length) {
      process.stdout.write([...report.lines, "refusing to sign a package that does not verify"].join("\n") + "\n");
      return 3;
    }
    const expectedHead = stringFlag(args, "expect-head-sha");
    if (expectedHead && report.manifest.subject.head_sha !== expectedHead) {
      process.stderr.write(
        `windkeel: package is about ${report.manifest.subject.head_sha}, expected ${expectedHead}; refusing to sign\n`,
      );
      return 3;
    }
    const expectedRepo = stringFlag(args, "expect-repo");
    if (expectedRepo && report.manifest.subject.repo !== expectedRepo) {
      process.stderr.write(
        `windkeel: package is about ${report.manifest.subject.repo}, expected ${expectedRepo}; refusing to sign\n`,
      );
      return 3;
    }

    if (args.flags.has("verify-only")) {
      process.stdout.write("verified: package is self-consistent and about the expected commit; not signed (--verify-only)\n");
      return 0;
    }
    const signature = signPackage(packageDir);
    process.stdout.write(
      signature.signed ? `signed: ${signature.reason}\n` : `unsigned: ${signature.reason}\n`,
    );
    return signature.signed ? 0 : 1;
  }

  if (command === "seal") {
    const dir = args.positional[0];
    if (!dir) {
      process.stderr.write(USAGE);
      return 2;
    }
    const packageDir = resolve(dir);

    if (
      existsSync(join(packageDir, BUNDLE_REF)) &&
      !args.flags.has("sign") &&
      !args.flags.has("force")
    ) {
      process.stderr.write(
        `refusing to reseal ${packageDir}: it carries a Sigstore bundle over the current attestation.\n` +
          `Re-run with --sign to sign the rewritten attestation, or --force to reseal and leave the\n` +
          `stale bundle in place (it will then fail verification).\n`,
      );
      return 2;
    }
    seal(packageDir);
    process.stdout.write("sealed: hashes.json + attestation/ written\n");
    if (args.flags.has("sign")) {
      const signature = signPackage(packageDir);
      process.stdout.write(
        signature.signed ? `signed: ${signature.reason}\n` : `unsigned: ${signature.reason}\n`,
      );
    }
    return 0;
  }

  if (command === "login" || command === "logout") {
    const auth = await import("./commands/auth.js");
    const { ApiError } = await import("./client/api.js");
    const { CredentialsFileError } = await import("./client/credentials.js");
    try {
      if (command === "logout") return await auth.logoutCommand(consoleIo);
      if (args.flags.has("token")) {
        process.stderr.write(
          "windkeel login does not take a token as a flag: it would be saved in your shell history.\n" +
            "Pipe it in instead:  windkeel login --with-token < token.txt\n",
        );
        return 2;
      }
      const url = stringFlag(args, "url");
      const org = stringFlag(args, "org");
      if (args.flags.has("with-token")) {
        return await auth.loginWithTokenCommand(consoleIo, { ...(url ? { url } : {}), ...(org ? { org } : {}) });
      }
      const scope = stringFlag(args, "scope");
      const permissions = stringFlag(args, "permissions");
      return await auth.loginCommand(consoleIo, {
        ...(url ? { url } : {}),
        ...(org ? { org } : {}),
        ...(scope ? { scope } : {}),
        ...(permissions ? { permissions } : {}),
        admin: args.flags.has("admin"),
        noBrowser: args.flags.has("no-browser"),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        printRefusal(consoleIo, err);
        return 1;
      }
      if (err instanceof CredentialsFileError) {
        process.stderr.write(`${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  if (command === "webhook" && args.positional[0] === "send") {
    const { webhookSendCommand, WEBHOOK_USAGE } = await import("./commands/webhook.js");
    const endpointId = args.positional[1];
    const secret = stringFlag(args, "secret") ?? process.env["WINDKEEL_WEBHOOK_SECRET"];
    const title = stringFlag(args, "title");
    const description = stringFlag(args, "description");
    let baseUrl = stringFlag(args, "url") ?? process.env["WINDKEEL_API_URL"];
    if (!baseUrl) {
      try {
        const { WindkeelApi } = await import("./client/api.js");
        baseUrl = WindkeelApi.fromEnv(process.env).baseUrl;
      } catch {
        baseUrl = undefined;
      }
    }
    if (!endpointId || !secret || !title || !description || !baseUrl) {
      process.stderr.write(WEBHOOK_USAGE);
      return 2;
    }
    const risk = stringFlag(args, "risk");
    const externalId = stringFlag(args, "external-id");
    const delivery = stringFlag(args, "delivery");
    return webhookSendCommand(consoleIo, {
      baseUrl,
      endpointId,
      secret,
      title,
      description,
      ...(risk ? { riskLevel: risk } : {}),
      ...(externalId ? { externalId } : {}),
      ...(delivery ? { deliveryId: delivery } : {}),
      json: args.flags.has("json"),
    });
  }

  if (REMOTE_COMMANDS.has(command)) {
    const { runRemoteCommand } = await import("./cli-remote.js");
    const code = await runRemoteCommand(command, args);
    if (code !== null) return code;
  }

  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp/server.js");
    const { MissingApiConfigError } = await import("./client/api.js");
    const { CredentialsFileError } = await import("./client/credentials.js");
    try {
      const org = stringFlag(args, "org");
      return await runMcpServer(org ? { org } : {});
    } catch (err) {
      if (err instanceof MissingApiConfigError || err instanceof CredentialsFileError) {

        process.stderr.write(`windkeel-mcp: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`windkeel: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
}