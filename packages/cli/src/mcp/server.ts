import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { WindkeelApi } from "../client/api.js";
import { ApiError, adviceFor, effectivePermissions, presetFor } from "../client/api.js";
import type { ToolDefinition } from "./tools.js";
import { TOOLS, toolByName, toolsFor } from "./tools.js";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "windkeel";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpIo {
  send(message: unknown): void;
  log(line: string): void;
}

export async function handleMcpMessage(
  api: WindkeelApi,
  request: JsonRpcRequest,
  options: { version?: string; tools?: readonly ToolDefinition[] } = {},
): Promise<object | null> {
  const { id, method, params } = request;
  const version = options.version ?? PROTOCOL_VERSION;
  const tools = options.tools ?? TOOLS;

  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: "0.2.0" },
        instructions:
          "Windkeel runs a coding task in a sandbox and then verifies the result with a different " +
          "vendor's model, so the review is independent of whoever wrote the change. Submit work " +
          "with windkeel_submit_task, including acceptance criteria as a markdown checklist; follow " +
          "it with windkeel_run_events, passing the previous endCursor as 'after'. When a run fails, " +
          "windkeel_run_attempts says which criterion and why.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : reply(id, {});

    case "tools/list":
      return reply(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      });

    case "tools/call": {
      const name = typeof params?.["name"] === "string" ? (params["name"]) : "";
      const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
      const tool = toolByName(name);
      if (!tool) {
        return errorReply(id, -32602, `no such tool: ${name}`);
      }
      if (!tools.includes(tool)) {
        return reply(id, toolError(lacks(tool.requires ?? "a permission")));
      }
      const missing = missingRequired(name, args);
      if (missing) {
        return reply(id, toolError(`${name} requires ${missing}`));
      }
      try {
        return reply(id, toolOk(await callTool(api, name, args)));
      } catch (err) {
        if (err instanceof ApiError) {
          const missing = err.missingPermission;
          if (missing) return reply(id, toolError(`${lacks(missing)} [${err.code}]`));
          const advice = adviceFor(err);
          return reply(id, toolError(`${err.message} [${err.code}]${advice ? ` — ${advice}` : ""}`));
        }
        return reply(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }

    default:
      return isNotification ? null : errorReply(id, -32601, `unsupported method: ${method}`);
  }
}

async function callTool(api: WindkeelApi, name: string, args: Record<string, unknown>): Promise<unknown> {
  const runId = (): string => String(args["runId"]);
  switch (name) {
    case "windkeel_whoami": {
      const [identity, health] = await Promise.all([api.self(), api.health()]);
      return {
        ...identity,
        effectivePermissions: effectivePermissions(identity, api.org),
        ...(api.org ? { addressedOrganization: api.org } : {}),
        credentialSource: api.tokenSource,
        database: health.database,
      };
    }
    case "windkeel_list_runs":
      return api.listRuns({
        ...(args["status"] ? { status: String(args["status"]) } : {}),
        ...(args["repository"] ? { repository: String(args["repository"]) } : {}),
        ...(args["task"] ? { task: String(args["task"]) } : {}),
        ...(args["limit"] ? { limit: String(args["limit"]) } : {}),
      });
    case "windkeel_get_run":
      return api.getRun(runId());
    case "windkeel_run_events":
      return api.events(runId(), args["after"] === undefined ? undefined : String(args["after"]));
    case "windkeel_run_attempts":
      return api.attempts(runId());
    case "windkeel_run_cost":
      return api.cost(runId());
    case "windkeel_queue":
      return api.queue();
    case "windkeel_list_repositories":
      return api.get("/v1/repositories");
    case "windkeel_submit_task":
      return api.submitTask({
        repositoryId: String(args["repositoryId"]),
        title: String(args["title"]),
        description: String(args["description"]),
        ...(args["riskLevel"] ? { riskLevel: String(args["riskLevel"]) } : {}),
        ...(args["playbook"] ? { playbook: String(args["playbook"]) } : {}),
      });
    case "windkeel_approve":
      return api.approve(runId());
    case "windkeel_cancel":
      return api.cancel(runId(), args["reason"] === undefined ? undefined : String(args["reason"]));
    case "windkeel_guide":
      return api.guide(runId(), String(args["message"]));
    case "windkeel_messages":
      return api.messages(runId());
    case "windkeel_list_secrets":
      return api.listSecrets(String(args["repositoryId"]));
    default:
      throw new Error(`unrouted tool: ${name}`);
  }
}

function missingRequired(name: string, args: Record<string, unknown>): string | null {
  const required = toolByName(name)?.inputSchema.required ?? [];
  const absent = required.filter((field) => args[field] === undefined || args[field] === "");
  return absent.length === 0 ? null : absent.join(", ");
}

function reply(id: JsonRpcRequest["id"], result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function errorReply(id: JsonRpcRequest["id"], code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolOk(value: unknown): object {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false };
}

function toolError(message: string): object {
  return { content: [{ type: "text", text: message }], isError: true };
}

function lacks(permission: string): string {
  return `this token lacks ${permission}; create one with \`windkeel token create --name <name> --scope ${presetFor(permission)}\``;
}

export async function toolsForCredential(api: WindkeelApi): Promise<{ tools: readonly ToolDefinition[]; permissions: string[] | null; reason?: string }> {
  try {
    const permissions = effectivePermissions(await api.self(), api.org);
    return { tools: toolsFor(permissions), permissions };
  } catch (err) {
    return {
      tools: TOOLS,
      permissions: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function serveMcp(
  api: WindkeelApi,
  io: McpIo,
  input: ReadlineInterface,
  tools: readonly ToolDefinition[] = TOOLS,
): Promise<void> {
  for await (const line of input) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      io.log(`ignored a line that is not JSON (${trimmed.length} bytes)`);
      continue;
    }
    try {
      const response = await handleMcpMessage(api, request, { tools });
      if (response !== null) io.send(response);
    } catch (err) {
      io.log(`handler threw: ${err instanceof Error ? err.message : String(err)}`);
      if (request.id !== undefined && request.id !== null) {
        io.send(errorReply(request.id, -32603, "internal error"));
      }
    }
  }
}

export async function runMcpServer(options: { org?: string } = {}): Promise<number> {
  const api = WindkeelApi.fromEnv(process.env, options.org ? { org: options.org } : {});
  const io: McpIo = {
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log: (line) => process.stderr.write(`windkeel-mcp: ${line}\n`),
  };
  const { tools, permissions, reason } = await toolsForCredential(api);
  io.log(
    permissions === null
      ? `serving all ${tools.length} tools on stdio (permissions unknown${reason ? `: ${reason}` : ""}; the API will refuse what this token cannot do)`
      : `serving ${tools.length} of ${TOOLS.length} tools on stdio for a token that can: ${permissions.join(", ") || "nothing"}`,
  );
  await serveMcp(api, io, createInterface({ input: process.stdin }), tools);
  return 0;
}
