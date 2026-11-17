

import { join } from "node:path";
import {
  approveCommand,
  attemptsCommand,
  cancelCommand,
  consoleIo,
  deleteSecretCommand,
  messagesCommand,
  queueCommand,
  secretsCommand,
  setSecretCommand,
  printRefusal,
  runsCommand,
  sayCommand,
  showCommand,
  submitCommand,
  watchCommand,
  whoamiCommand,
} from "./commands/remote.js";
import { stringFlag, type Args } from "./cli-args.js";

export async function runRemoteCommand(command: string, args: Args): Promise<number | null> {
  const { MissingApiConfigError, WindkeelApi } = await import("./client/api.js");
  const { CredentialsFileError } = await import("./client/credentials.js");
  let api;
  try {
    const org = stringFlag(args, "org");

    api = WindkeelApi.fromEnv(process.env, org && command !== "token" ? { org } : {});
  } catch (err) {
    if (err instanceof MissingApiConfigError || err instanceof CredentialsFileError) {
      process.stderr.write(`${err.message}\n\nSee "windkeel help", "talking to a deployed factory".\n`);
      return 2;
    }
    throw err;
  }
  const json = args.flags.has("json");

  try {
    switch (command) {
      case "token": {
        const auth = await import("./commands/auth.js");
        const [subcommand, tokenId] = args.positional;
        if (subcommand === "list") return await auth.tokenListCommand(api, consoleIo, json);
        if (subcommand === "revoke" && tokenId) return await auth.tokenRevokeCommand(api, consoleIo, tokenId);
        if (subcommand === "create") {
          const flag = (name: string) => stringFlag(args, name);
          return await auth.tokenCreateCommand(api, consoleIo, {
            ...(flag("name") ? { name: flag("name")! } : {}),
            ...(flag("scope") ? { scope: flag("scope")! } : {}),
            ...(flag("permissions") ? { permissions: flag("permissions")! } : {}),
            ...(flag("org") ? { org: flag("org")! } : {}),
            ...(flag("expires-in-days") ? { expiresInDays: flag("expires-in-days")! } : {}),
            json,
          });
        }
        process.stderr.write(
          "usage: windkeel token create --name <name> [--scope <preset> | --permissions <a,b>] [--org <id>] [--expires-in-days <n>]\n" +
            "       windkeel token list [--json]\n" +
            "       windkeel token revoke <token-id>\n",
        );
        return 2;
      }
      case "org": {
        const auth = await import("./commands/auth.js");
        const [subcommand, wanted] = args.positional;
        if (subcommand === "list" || subcommand === undefined) return await auth.orgListCommand(api, consoleIo, json);
        if (subcommand === "use" && wanted) return await auth.orgUseCommand(api, consoleIo, wanted);
        process.stderr.write("usage: windkeel org list [--json]\n       windkeel org use <id|name>\n");
        return 2;
      }
      case "member": {
        const auth = await import("./commands/auth.js");
        const [subcommand, first, second] = args.positional;
        const role = stringFlag(args, "role");
        if (subcommand === "list") return await auth.memberCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "invitations") {
          return await auth.memberCommand(api, consoleIo, { kind: "invitations", json });
        }
        if (subcommand === "invite" && first) {
          return await auth.memberCommand(api, consoleIo, {
            kind: "invite",
            githubLogin: first,
            ...(role ? { role } : {}),
          });
        }
        if (subcommand === "role" && first && (second ?? role)) {
          return await auth.memberCommand(api, consoleIo, { kind: "role", principalId: first, role: (second ?? role)! });
        }
        if (subcommand === "remove" && first) {
          return await auth.memberCommand(api, consoleIo, { kind: "remove", principalId: first });
        }
        process.stderr.write(
          "usage: windkeel member list [--json]\n" +
            "       windkeel member invitations [--json]\n" +
            "       windkeel member invite <github-login> [--role admin|member|viewer]\n" +
            "       windkeel member role <principal-id> <admin|member|viewer>\n" +
            "       windkeel member remove <principal-id>\n",
        );
        return 2;
      }
      case "service-principal": {
        const sp = await import("./commands/service-principal.js");
        const [subcommand, first, second, third] = args.positional;
        const flag = (name: string) => stringFlag(args, name);
        if (subcommand === "list") return await sp.servicePrincipalCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "create") {
          return await sp.servicePrincipalCommand(api, consoleIo, {
            kind: "create",
            ...(flag("name") ? { name: flag("name")! } : {}),
            ...(flag("role") ? { role: flag("role")! } : {}),
            json,
          });
        }
        if (subcommand === "delete" && first) {
          return await sp.servicePrincipalCommand(api, consoleIo, { kind: "delete", principalId: first });
        }
        if (subcommand === "token" && first === "list" && second) {
          return await sp.servicePrincipalCommand(api, consoleIo, { kind: "token-list", principalId: second, json });
        }
        if (subcommand === "token" && first === "create" && second) {
          return await sp.servicePrincipalCommand(api, consoleIo, {
            kind: "token-create",
            principalId: second,
            ...(flag("name") ? { name: flag("name")! } : {}),
            ...(flag("scope") ? { scope: flag("scope")! } : {}),
            ...(flag("permissions") ? { permissions: flag("permissions")! } : {}),
            ...(flag("expires-at") ? { expiresAt: flag("expires-at")! } : {}),
            json,
          });
        }
        if (subcommand === "token" && first === "revoke" && second && third) {
          return await sp.servicePrincipalCommand(api, consoleIo, {
            kind: "token-revoke",
            principalId: second,
            tokenId: third,
          });
        }
        process.stderr.write(sp.SERVICE_PRINCIPAL_USAGE);
        return 2;
      }
      case "integration": {
        const { integrationCommand, INTEGRATION_USAGE } = await import("./commands/integration.js");
        const [subcommand, first, second, third] = args.positional;
        const flag = (name: string) => stringFlag(args, name);
        if (subcommand === "list") return await integrationCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "connect" && first && second) {
          return await integrationCommand(api, consoleIo, { kind: "connect", provider: first, installationId: second, json });
        }
        if (subcommand === "disconnect" && first) {
          return await integrationCommand(api, consoleIo, { kind: "disconnect", integrationId: first });
        }
        if (subcommand === "route" && first === "add" && second && flag("repo")) {
          return await integrationCommand(api, consoleIo, {
            kind: "route-add",
            integrationId: second,
            repositoryId: flag("repo")!,
            ...(flag("scope") ? { scopeKind: flag("scope")! } : {}),
            ...(flag("value") ? { scopeValue: flag("value")! } : {}),
            ...(flag("label") ? { triggerLabel: flag("label")! } : {}),
            json,
          });
        }
        if (subcommand === "route" && first === "rm" && second && third) {
          return await integrationCommand(api, consoleIo, { kind: "route-rm", integrationId: second, routeId: third });
        }
        process.stderr.write(INTEGRATION_USAGE);
        return 2;
      }
      case "schedule": {
        const { capFlag, scheduleCommand, SCHEDULE_USAGE } = await import("./commands/schedule.js");
        const [subcommand, first] = args.positional;
        const flag = (name: string) => stringFlag(args, name);
        const text = async (name: string): Promise<string | undefined> => {
          const raw = flag(name);
          if (raw === undefined || !raw.startsWith("@")) return raw;
          return (await import("node:fs")).readFileSync(raw.slice(1), "utf8");
        };
        const numberFlag = (name: string): number | null | undefined => capFlag(flag(name));
        const fields = async () => {
          const description = await text("description");
          const risk = flag("risk");
          const spend = numberFlag("spend-cap");
          const wall = numberFlag("wall-clock");
          return {
            ...(flag("name") ? { name: flag("name")! } : {}),
            ...(flag("repo") ? { repositoryId: flag("repo")! } : {}),
            ...(flag("cron") ? { cron: flag("cron")! } : {}),
            ...(flag("tz") ? { timezone: flag("tz")! } : {}),
            ...(flag("title") ? { title: flag("title")! } : {}),
            ...(description !== undefined ? { description } : {}),

            ...(risk !== undefined ? { riskLevel: risk as "low" | "medium" | "high" } : {}),
            ...(spend !== undefined ? { spendCapUsd: spend } : {}),
            ...(wall !== undefined ? { wallClockCapSeconds: wall } : {}),
          };
        };
        if (subcommand === "list") return await scheduleCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "create") {
          const input = await fields();
          if (input.name && input.repositoryId && input.cron && input.title && input.description) {
            return await scheduleCommand(api, consoleIo, {
              kind: "create",
              input: { ...input, name: input.name, repositoryId: input.repositoryId, cron: input.cron, title: input.title, description: input.description },
              json,
            });
          }
        }
        if (subcommand === "update" && first) {
          const change = {
            ...(await fields()),
            ...(args.flags.has("enable") ? { enabled: true } : {}),
            ...(args.flags.has("disable") ? { enabled: false } : {}),
          };
          return await scheduleCommand(api, consoleIo, { kind: "update", scheduleId: first, change, json });
        }
        if (subcommand === "delete" && first) return await scheduleCommand(api, consoleIo, { kind: "delete", scheduleId: first });
        if (subcommand === "fire" && first) return await scheduleCommand(api, consoleIo, { kind: "fire", scheduleId: first, json });
        if (subcommand === "preview" && first) {
          return await scheduleCommand(api, consoleIo, { kind: "preview", cron: first, timezone: flag("tz") ?? "UTC", json });
        }
        process.stderr.write(SCHEDULE_USAGE);
        return 2;
      }
      case "playbook": {
        const { playbookCommand, PLAYBOOK_USAGE } = await import("./commands/playbook.js");
        const [subcommand, first] = args.positional;
        if (subcommand === "list") return await playbookCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "show" && first) return await playbookCommand(api, consoleIo, { kind: "show", slug: first, json });
        process.stderr.write(PLAYBOOK_USAGE);
        return 2;
      }
      case "batch": {
        const { batchCapFlag, batchCommand, BATCH_USAGE, parseCriteria } = await import("./commands/batch.js");
        const [subcommand, first] = args.positional;
        const flag = (name: string) => stringFlag(args, name);
        const read = async (path: string) => (await import("node:fs")).readFileSync(path, "utf8");
        const text = async (name: string): Promise<string | undefined> => {
          const raw = flag(name);
          if (raw === undefined || !raw.startsWith("@")) return raw;
          return read(raw.slice(1));
        };
        const number = (name: string): number | undefined => (flag(name) === undefined ? undefined : Number(flag(name)));
        if (subcommand === "list") return await batchCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "create") {
          const title = flag("title");
          const description = await text("description");
          const repos = flag("repos");
          const itemsFile = flag("items");
          const repo = flag("repo");
          if (title && description && (repos || (itemsFile && repo))) {
            const criteriaFile = flag("criteria-file");
            const cap = batchCapFlag(flag("cap"));
            const risk = flag("risk");
            const ratio = flag("stop-on-failure-ratio");
            const common = {
              title,
              description,
              ...(criteriaFile ? { criteria: parseCriteria(await read(criteriaFile)) } : {}),

              ...(risk !== undefined ? { riskLevel: risk as "low" | "medium" | "high" } : {}),
              ...(number("max-concurrency") !== undefined ? { maxConcurrency: number("max-concurrency")! } : {}),
              ...(cap !== undefined ? { batchSpendCapUsd: cap } : {}),
              ...(args.flags.has("uncapped-confirmed") ? { uncappedConfirmed: true } : {}),
              ...(number("child-cap") !== undefined ? { spendCapUsd: number("child-cap")! } : {}),
              ...(number("wall-clock") !== undefined ? { wallClockCapSeconds: number("wall-clock")! } : {}),
              ...(ratio !== undefined ? { stopOnFailureRatio: ratio === "none" ? null : Number(ratio) } : {}),
            };
            const input = repos
              ? { ...common, kind: "multi_repo" as const, repositories: repos.split(",").map((r) => r.trim()).filter(Boolean) }
              : { ...common, kind: "fanout" as const, repositoryId: repo!, items: JSON.parse(await read(itemsFile!)) };
            return await batchCommand(api, consoleIo, { kind: "create", input, json });
          }
        }
        if (subcommand === "status" && first) {
          return await batchCommand(api, consoleIo, { kind: "status", batchId: first, watch: args.flags.has("watch"), json });
        }
        if ((subcommand === "pause" || subcommand === "resume" || subcommand === "cancel") && first) {
          return await batchCommand(api, consoleIo, { kind: subcommand, batchId: first, json });
        }
        process.stderr.write(BATCH_USAGE);
        return 2;
      }
      case "models": {
        const { modelsCommand, MODELS_USAGE } = await import("./commands/models.js");
        const [noun, subcommand, first] = args.positional;
        const flag = (name: string) => stringFlag(args, name);

        for (const name of ["value", "key", "api-key", "secret"]) {
          if (args.flags.has(name)) {
            process.stderr.write(
              `windkeel models: --${name} is not accepted — a key on the command line lands in shell ` +
                "history and `ps`. Pipe it on stdin or use --from-env <VAR>, and consider rotating " +
                "the key you just typed.\n",
            );
            return 2;
          }
        }
        const fromEnv = flag("from-env");

        if (
          noun === "credentials" &&
          ((subcommand === "add" && args.positional.length > 2) ||
            (subcommand === "rotate" && args.positional.length > 3))
        ) {
          process.stderr.write(
            "windkeel models: the key is never accepted as an argument — it lands in shell history and " +
              "`ps`. Pipe it on stdin or use --from-env <VAR>, and consider rotating it.\n",
          );
          return 2;
        }
        if (noun === "policy") {
          const repositoryId = flag("repo");
          const role = flag("role");
          if (role !== undefined && role !== "maker" && role !== "checker") {
            process.stderr.write("windkeel models policy: --role must be maker or checker\n");
            return 2;
          }
          if (subcommand === "show") {
            return await modelsCommand(api, consoleIo, {
              kind: "policy-show",
              ...(repositoryId ? { repositoryId } : {}),
              json,
            });
          }
          if (subcommand === "set" && role && flag("model")) {
            return await modelsCommand(api, consoleIo, {
              kind: "policy-set",
              role,
              model: flag("model")!,
              ...(flag("provider") ? { provider: flag("provider")! } : {}),
              ...(flag("credential") ? { credentialId: flag("credential")! } : {}),
              ...(flag("vendor") ? { vendor: flag("vendor")! } : {}),
              ...(repositoryId ? { repositoryId } : {}),
              json,
            });
          }
          if (subcommand === "clear") {
            return await modelsCommand(api, consoleIo, {
              kind: "policy-clear",
              ...(role ? { role } : {}),
              ...(repositoryId ? { repositoryId } : {}),
            });
          }
        }
        if (noun === "credentials") {
          if (subcommand === "list") {
            return await modelsCommand(api, consoleIo, { kind: "list", all: args.flags.has("all"), json });
          }
          if (subcommand === "add" && flag("provider") && flag("label")) {
            return await modelsCommand(api, consoleIo, {
              kind: "add",
              provider: flag("provider")!,
              label: flag("label")!,
              ...(flag("base-url") ? { baseUrl: flag("base-url")! } : {}),
              ...(flag("vendor") ? { vendor: flag("vendor")! } : {}),
              ...(fromEnv ? { fromEnv } : {}),
              json,
            });
          }
          if (subcommand === "rotate" && first) {
            return await modelsCommand(api, consoleIo, {
              kind: "rotate",
              credentialId: first,
              ...(fromEnv ? { fromEnv } : {}),
              json,
            });
          }
          if (subcommand === "revoke" && first) {
            return await modelsCommand(api, consoleIo, { kind: "revoke", credentialId: first, json });
          }
          if (subcommand === "validate" && first) {
            return await modelsCommand(api, consoleIo, { kind: "validate", credentialId: first, json });
          }
        }
        process.stderr.write(MODELS_USAGE);
        return 2;
      }
      case "env": {
        const { envCommand, ENV_USAGE } = await import("./commands/environment.js");
        const subcommand = args.positional[0];
        const repo = stringFlag(args, "repo");
        if (!repo || (subcommand !== "status" && subcommand !== "rebuild" && subcommand !== "invalidate")) {
          process.stderr.write(ENV_USAGE);
          return 2;
        }
        return await envCommand(
          api,
          consoleIo,
          subcommand === "status" ? { kind: "status", repo, json } : { kind: subcommand, repo },
        );
      }
      case "audit": {
        const { auditCommand, AUDIT_USAGE } = await import("./commands/audit.js");
        const [subcommand] = args.positional;
        if (subcommand === "verify") return await auditCommand(api, consoleIo, { kind: "verify", json });
        const format = stringFlag(args, "format") ?? "jsonl";
        if (subcommand === "export" && (format === "jsonl" || format === "csv")) {
          const since = stringFlag(args, "since");
          const until = stringFlag(args, "until");
          const action = stringFlag(args, "action");
          const org = stringFlag(args, "org");
          return await auditCommand(api, consoleIo, {
            kind: "export",
            format,
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
            ...(action ? { action } : {}),
            ...(org ? { org } : {}),
            write: (chunk) => void process.stdout.write(chunk),
          });
        }
        process.stderr.write(AUDIT_USAGE);
        return 2;
      }
      case "webhook": {
        const { webhookCommand, WEBHOOK_USAGE } = await import("./commands/webhook.js");
        const [subcommand, first] = args.positional;
        const flag = (name: string) => stringFlag(args, name);
        if (subcommand === "list") return await webhookCommand(api, consoleIo, { kind: "list", json });
        if (subcommand === "create" && flag("name") && flag("repo")) {
          return await webhookCommand(api, consoleIo, {
            kind: "create",
            name: flag("name")!,
            repositoryId: flag("repo")!,
            ...(flag("risk") ? { defaultRiskLevel: flag("risk")! } : {}),
            json,
          });
        }
        if (subcommand === "rotate" && first) return await webhookCommand(api, consoleIo, { kind: "rotate", endpointId: first, json });
        if (subcommand === "delete" && first) return await webhookCommand(api, consoleIo, { kind: "delete", endpointId: first });
        process.stderr.write(WEBHOOK_USAGE);
        return 2;
      }
      case "runs":
        return await runsCommand(api, consoleIo, {
          ...(stringFlag(args, "status") ? { status: stringFlag(args, "status")! } : {}),
          ...(stringFlag(args, "repo") ? { repo: stringFlag(args, "repo")! } : {}),
          ...(stringFlag(args, "task") ? { task: stringFlag(args, "task")! } : {}),
          ...(stringFlag(args, "limit") ? { limit: stringFlag(args, "limit")! } : {}),
          json,
        });
      case "queue":
        return await queueCommand(api, consoleIo, json);
      case "whoami":
        return await whoamiCommand(api, consoleIo, { json });
      case "show":
      case "watch":
      case "attempts":
      case "approve":
      case "cancel":
      case "say":
      case "messages": {
        const runId = args.positional[0];
        if (!runId) {
          process.stderr.write(`windkeel ${command} needs a run id\n`);
          return 2;
        }
        if (command === "show") return await showCommand(api, consoleIo, runId, json);
        if (command === "messages") return await messagesCommand(api, consoleIo, runId, json);
        if (command === "attempts") return await attemptsCommand(api, consoleIo, runId, json);
        if (command === "approve") return await approveCommand(api, consoleIo, runId);
        if (command === "cancel") {
          return await cancelCommand(api, consoleIo, runId, stringFlag(args, "reason"));
        }
        if (command === "say") {

          const message = args.positional.slice(1).join(" ");
          if (message === "") {
            process.stderr.write("windkeel say needs a message\n");
            return 2;
          }
          return await sayCommand(api, consoleIo, runId, message);
        }
        const poll = stringFlag(args, "poll");
        return await watchCommand(api, consoleIo, runId, {
          json,
          ...(poll ? { pollMs: Number(poll) } : {}),
        });
      }
      case "secrets": {
        const repositoryId = args.positional[0];
        if (!repositoryId) {
          process.stderr.write("windkeel secrets needs a repository id\n");
          return 2;
        }
        return await secretsCommand(api, consoleIo, repositoryId, json);
      }
      case "secret": {
        const [subcommand, repositoryId, key, ...rest] = args.positional;
        if (!repositoryId || !key || (subcommand !== "set" && subcommand !== "rm")) {
          process.stderr.write(
            "usage: windkeel secret set <repository-id> <KEY> <value|@file> [--note <text>]\n" +
              "       windkeel secret rm  <repository-id> <KEY>\n",
          );
          return 2;
        }
        if (subcommand === "rm") {
          return await deleteSecretCommand(api, consoleIo, repositoryId, key);
        }
        const raw = rest.join(" ");
        if (raw === "") {
          process.stderr.write("windkeel secret set needs a value\n");
          return 2;
        }

        const value = raw.startsWith("@")
          ? (await import("node:fs")).readFileSync(raw.slice(1), "utf8").trim()
          : raw;
        return await setSecretCommand(
          api,
          consoleIo,
          repositoryId,
          key,
          value,
          stringFlag(args, "note"),
        );
      }
      case "task":
      case "submit": {

        if (command === "task" && args.positional[0] !== "create") {
          process.stderr.write("usage: windkeel task create --repo … --title … --description … (see windkeel submit)\n");
          return 2;
        }
        const repo = stringFlag(args, "repo");
        const title = stringFlag(args, "title");
        const rawDescription = stringFlag(args, "description");
        if (!repo || !title || !rawDescription) {
          process.stderr.write("windkeel submit needs --repo, --title and --description\n");
          return 2;
        }
        const { readFileSync } = await import("node:fs");

        let description = rawDescription.startsWith("@")
          ? readFileSync(rawDescription.slice(1), "utf8")
          : rawDescription;

        const criteriaFile = stringFlag(args, "criteria");
        if (criteriaFile) {
          description = `${description.trimEnd()}\n\n## Acceptance criteria\n\n${readFileSync(criteriaFile, "utf8").trim()}\n`;
        }
        const spendCap = stringFlag(args, "spend-cap");
        const wallClock = stringFlag(args, "wall-clock");
        for (const [flag, raw] of [["--spend-cap", spendCap], ["--wall-clock", wallClock]] as const) {
          if (raw !== undefined && !(Number(raw) > 0)) {
            process.stderr.write(`${flag} must be a positive number (got ${raw})\n`);
            return 2;
          }
        }
        return await submitCommand(api, consoleIo, {
          repo,
          title,
          description,
          ...(stringFlag(args, "risk") ? { riskLevel: stringFlag(args, "risk")! } : {}),
          ...(spendCap !== undefined ? { spendCapUsd: Number(spendCap) } : {}),
          ...(wallClock !== undefined ? { wallClockCapSeconds: Number(wallClock) } : {}),
          ...(stringFlag(args, "playbook") ? { playbook: stringFlag(args, "playbook")! } : {}),
          ...(stringFlag(args, "maker-model") || stringFlag(args, "checker-model")
            ? {
                models: {
                  ...(stringFlag(args, "maker-model") ? { maker: stringFlag(args, "maker-model")! } : {}),
                  ...(stringFlag(args, "checker-model") ? { checker: stringFlag(args, "checker-model")! } : {}),
                },
              }
            : {}),
        });
      }
      case "metrics": {
        const { metricsCommand } = await import("./commands/operator.js");
        return await metricsCommand(api, consoleIo, json);
      }
      case "usage": {
        const { usageCommand } = await import("./commands/operator.js");
        return await usageCommand(api, consoleIo, { period: stringFlag(args, "period"), json });
      }
      case "billing": {
        const { billingCommand } = await import("./commands/billing.js");
        return await billingCommand(api, consoleIo, {
          subcommand: args.positional[0],
          period: stringFlag(args, "period"),
          csv: args.flags.has("csv"),
          json,
        });
      }
      case "reap": {
        const { reapCommand } = await import("./commands/operator.js");
        return await reapCommand(api, consoleIo, { dryRun: args.flags.has("dry-run"), json });
      }
      case "capture": {
        const runId = args.positional[0];
        if (!runId) {
          process.stderr.write("windkeel capture needs a run id\n");
          return 2;
        }
        const { captureCommand } = await import("./commands/operator.js");
        return await captureCommand(api, consoleIo, runId, {
          out: stringFlag(args, "out") ?? join(".windkeel", "capture", runId),
        });
      }
    }
  } catch (err) {
    const { ApiError } = await import("./client/api.js");
    if (err instanceof ApiError) {
      printRefusal(consoleIo, err);
      return 1;
    }
    throw err;
  }

  return null;
}
