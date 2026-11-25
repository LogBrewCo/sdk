import type { BaseContext, ExecuteContext, Item, Json, NodeDescription, Option } from "./n8n";
import { connect, projectOptions } from "./transport";
import { levelOf, resolveIssue, sendLog } from "./client";
import type { Send } from "./client";

type Connection = Readonly<{ apiUrl: string; send: Send }>;
type Outcome = Readonly<{ error: Error } | { json: Json }>;

function attributesOf(value: unknown): Readonly<Record<string, unknown>> {
  const parsed: unknown = typeof value === "string" && value.trim() !== "" ? JSON.parse(value) : value;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return Object.fromEntries(Object.entries(parsed));
  }
  return {};
}

function text(context: ExecuteContext, name: string, index: number): string {
  const value = context.getNodeParameter(name, index, "");
  return typeof value === "string" ? value.trim() : "";
}

async function runOne(context: ExecuteContext, connection: Connection, index: number): Promise<Json> {
  const operation = text(context, "operation", index);
  if (operation === "resolve") {
    const issue = await resolveIssue(connection.send, connection.apiUrl, text(context, "issueId", index));
    return { ...issue };
  }
  const environment = text(context, "environment", index);
  const reply = await sendLog(connection.send, {
    attributes: attributesOf(context.getNodeParameter("attributes", index, "{}")),
    environment: environment === "" ? "production" : environment,
    id: crypto.randomUUID(),
    level: levelOf(text(context, "level", index)),
    message: text(context, "message", index),
    occurredAt: new Date().toISOString(),
    projectId: text(context, "projectId", index),
    release: text(context, "release", index),
    serviceName: text(context, "serviceName", index),
  });
  return typeof reply === "object" && reply !== null ? { ...reply } : {};
}

async function settle(context: ExecuteContext, connection: Connection, index: number): Promise<Outcome> {
  try {
    return { json: await runOne(context, connection, index) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

class LogBrew {
  public readonly description: NodeDescription = {
    credentials: [{ name: "logBrewApi", required: true }],
    defaults: { name: "LogBrew" },
    description: "Send logs to LogBrew and resolve LogBrew issues",
    displayName: "LogBrew",
    group: ["output"],
    icon: { dark: "file:../../icons/logbrew.dark.svg", light: "file:../../icons/logbrew.svg" },
    inputs: ["main"],
    name: "logBrew",
    outputs: ["main"],
    properties: [
      {
        displayName: "Resource",
        default: "log",
        name: "resource",
        noDataExpression: true,
        options: [
          { name: "Issue", value: "issue" },
          { name: "Log", value: "log" },
        ],
        type: "options",
      },
      {
        displayName: "Operation",
        default: "send",
        displayOptions: { show: { resource: ["log"] } },
        name: "operation",
        noDataExpression: true,
        options: [{ action: "Send a log", description: "Send one log line to a project", name: "Send", value: "send" }],
        type: "options",
      },
      {
        displayName: "Operation",
        default: "resolve",
        displayOptions: { show: { resource: ["issue"] } },
        name: "operation",
        noDataExpression: true,
        options: [
          { action: "Resolve an issue", description: "Mark an issue resolved", name: "Resolve", value: "resolve" },
        ],
        type: "options",
      },
      {
        displayName: "Issue ID",
        default: "",
        description: "The issue to resolve. Triggers and issue links give you its ID.",
        displayOptions: { show: { operation: ["resolve"], resource: ["issue"] } },
        name: "issueId",
        required: true,
        type: "string",
      },
      {
        displayName: "Project Name or ID",
        default: "",
        description:
          'Project that receives the log. Use the project of your ingest key. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "projectId",
        required: true,
        type: "options",
        typeOptions: { loadOptionsMethod: "getProjects" },
      },
      {
        displayName: "Message",
        default: "",
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "message",
        required: true,
        type: "string",
      },
      {
        displayName: "Level",
        default: "info",
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "level",
        options: [
          { name: "Critical", value: "critical" },
          { name: "Debug", value: "debug" },
          { name: "Error", value: "error" },
          { name: "Info", value: "info" },
          { name: "Warning", value: "warning" },
        ],
        type: "options",
      },
      {
        displayName: "Service Name",
        default: "n8n",
        description: "The service that LogBrew groups this log under",
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "serviceName",
        required: true,
        type: "string",
      },
      {
        displayName: "Release",
        default: "workflow",
        description: "The release, version, or commit of the service",
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "release",
        required: true,
        type: "string",
      },
      {
        displayName: "Environment",
        default: "production",
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "environment",
        type: "string",
      },
      {
        displayName: "Attributes",
        default: "{}",
        description: "Extra fields to store with the log, such as an order ID",
        displayOptions: { show: { operation: ["send"], resource: ["log"] } },
        name: "attributes",
        type: "json",
      },
    ],
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    usableAsTool: true,
    version: 1,
  };

  public readonly methods = {
    loadOptions: {
      async getProjects(this: BaseContext): Promise<readonly Option[]> {
        return projectOptions(this);
      },
    },
  };

  public async execute(this: ExecuteContext): Promise<readonly (readonly Item[])[]> {
    const connection = await connect(this);
    const results: Item[] = [];
    for (const [index] of this.getInputData().entries()) {
      const outcome = await settle(this, connection, index);
      if ("error" in outcome && !this.continueOnFail()) {
        throw outcome.error;
      }
      results.push({ json: "error" in outcome ? { error: outcome.error.message } : outcome.json, pairedItem: { item: index } });
    }
    return [results];
  }
}

export { LogBrew };
