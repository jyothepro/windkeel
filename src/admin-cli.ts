#!/usr/bin/env node
import "@windkeel/verification/env-compat.js";
import { TOOL_VERSION } from "@windkeel/verification/version.js";

const USAGE = `windkeel-admin ${TOOL_VERSION}

The operator's deployment steps. Not part of the published "windkeel" package; run them from a
checkout. Everything a factory's users do — including metrics, reap, submitting a task and
capturing a sandbox — is in "windkeel", over the API.

Usage:
  windkeel-admin doctor [--repository <owner/name>] [--json]
      Preflight a deployment before a run costs anything: validate every worker variable,
      connect to Postgres and confirm it is direct rather than pooled, write and read back
      one object, mint a real installation token and compare the App's grant against
      ADR-0009 in both directions, mint the maker's and verifier's tokens and assert their
      scopes differ, reach both model endpoints, create and destroy one sandbox, and open
      every stored repository secret to prove this worker's key can.
      Every check reports pass, fail, or skipped-with-a-reason. Exit 1 if any check failed.
      No value of any variable is ever printed.

  windkeel-admin secrets keygen
      Mint the X25519 key pair repository secrets and organization model credentials are
      sealed with (ADR-0023 §9, ADR-0026 §2), and print both halves once. Needs no database
      and no network.

      Both go on the deployment: WINDKEEL_SECRET_PUBLIC_KEY, which the API routes seal with,
      and WINDKEEL_SECRET_PRIVATE_KEY, which only the workflow steps open with. Since #213 these
      are one Vercel deployment, so the split is in the code, not the environment: no API
      route can open a value (test/api-routing.test.js), and the database alone cannot.
      Mark the private key sensitive.

      Rotating the pair does not re-seal what is already stored. Set the old private half
      as WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY until every value has been set again; see
      docs/running-the-factory.md, "Rotating the key pair".

  windkeel-admin signup-invite [--note <text>] [--days <n>]
      Mint one invite code for self-serve signup (ADR-0038: invite-only, behind
      WINDKEEL_SELF_SERVE_SIGNUP). Prints the code once; only its SHA-256 is stored. Good for one
      account, for 14 days unless --days says otherwise. Needs DATABASE_URL.

  moved to "windkeel" (ADR-0023 §10)
      windkeel-admin metrics        ->  windkeel metrics
      windkeel-admin reap           ->  windkeel reap [--dry-run]
      windkeel-admin task create    ->  windkeel submit
      windkeel-admin task status    ->  windkeel show <run-id>
      windkeel-admin run report     ->  windkeel show <run-id>
      windkeel-admin run capture    ->  windkeel capture <run-id>
`;

const MOVED: Record<string, string> = {
  metrics: "windkeel metrics [--json]",
  reap: "windkeel reap [--dry-run] [--json]",
  task: "windkeel submit --repo <id|owner/name> --title <text> --description <text|@file>   (task create)\n  windkeel show <run-id>   (task status)",
  run: "windkeel show <run-id>   (run report)\n  windkeel capture <run-id> [--out <dir>]   (run capture)",
};

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUELESS_FLAGS = new Set(["json", "help"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!VALUELESS_FLAGS.has(body) && next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { positional, flags };
}

const stringFlag = (args: Args, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  if (command === undefined || command === "help" || args.flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 2 : 0;
  }

  if (command === "secrets") {
    if (args.positional[0] !== "keygen") {
      process.stderr.write(`usage: windkeel-admin secrets keygen\n`);
      return 2;
    }
    const { generateSecretKeyPair } = await import("./factory/secret-box.js");
    const pair = generateSecretKeyPair();
    process.stdout.write(
      `# Seals secrets and model credentials (the API routes); cannot open them.\n` +
        `WINDKEEL_SECRET_PUBLIC_KEY=${pair.publicKey}\n\n` +
        `# Opens them (the workflow steps only). Mark it a sensitive variable.\n` +
        `WINDKEEL_SECRET_PRIVATE_KEY=${pair.privateKey}\n`,
    );
    return 0;
  }

  if (command === "doctor") {
    const doctorEnv = await import("./commands/doctor-env.js");
    const { formatDoctorReport, runDoctor } = await import("./commands/doctor.js");

    const repositoryFlag = stringFlag(args, "repository");
    const repository = repositoryFlag?.includes("/")
      ? { owner: repositoryFlag.split("/")[0]!, name: repositoryFlag.split("/")[1]! }
      : undefined;

    const environment = doctorEnv.defaultDoctorEnvironment({
      ...(repository ? { repository } : {}),
    });
    const { report, secrets } = await runDoctor(environment, doctorEnv.doctorTempPackage);

    process.stdout.write(
      args.flags.has("json")
        ? `${secrets.redact(JSON.stringify(report, null, 2))}\n`
        : `${formatDoctorReport(report, secrets)}\n`,
    );
    return report.ok ? 0 : 1;
  }

  if (command === "signup-invite") {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      process.stderr.write("windkeel-admin signup-invite needs DATABASE_URL\n");
      return 2;
    }
    const days = stringFlag(args, "days");
    if (days !== undefined && !(Number(days) > 0)) {
      process.stderr.write(`--days must be a positive number (got ${days})\n`);
      return 2;
    }
    const { Pool } = await import("pg");
    const { createSignupInvite } = await import("./billing/onboarding.js");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const invite = await createSignupInvite(pool, {
        note: stringFlag(args, "note") ?? null,
        ...(days !== undefined ? { expiresInDays: Number(days) } : {}),
      });
      process.stdout.write(`${invite.code}\n# expires ${invite.expiresAt.toISOString()} (invite ${invite.id})\n`);
      return 0;
    } finally {
      await pool.end();
    }
  }

  const moved = MOVED[command];
  if (moved) {
    process.stderr.write(
      `windkeel-admin ${command} moved to the published CLI and now goes through the API (ADR-0023 §10):\n` +
        `  ${moved}\n` +
        `It authenticates with "windkeel login" or WINDKEEL_API_URL + WINDKEEL_API_TOKEN, not DATABASE_URL.\n`,
    );
    return 2;
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
}
