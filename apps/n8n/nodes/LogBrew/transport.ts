import type {
  ICredentialDataDecryptedObject,
  IExecuteFunctions,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
  IPollFunctions,
} from "n8n-workflow";
import { LogBrewError, defaultApiUrl, listProjects, noHttpStatus } from "./client";
import type { Reply, Request, Send } from "./client";

type Connection = Readonly<{ apiUrl: string; send: Send }>;

type Context = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

const credentialName = "logBrewApi";

function setting(credentials: ICredentialDataDecryptedObject, key: string): string {
  const value = credentials[key];
  return typeof value === "string" ? value.trim() : "";
}

function replyOf(response: unknown): Reply {
  if (typeof response !== "object" || response === null) {
    return { body: undefined, status: noHttpStatus };
  }
  const body: unknown = Reflect.get(response, "body");
  const status: unknown = Reflect.get(response, "statusCode");
  return { body, status: typeof status === "number" ? status : noHttpStatus };
}

async function connect(context: Context): Promise<Connection> {
  const credentials = await context.getCredentials(credentialName);
  const configured = setting(credentials, "apiUrl").replace(/\/+$/u, "");
  const apiUrl = configured === "" ? defaultApiUrl : configured;
  const ingestKey = setting(credentials, "ingestApiKey");
  async function send(request: Request): Promise<Reply> {
    const options: IHttpRequestOptions = {
      ignoreHttpStatusErrors: true,
      json: true,
      method: request.method,
      returnFullResponse: true,
      url: `${apiUrl}${request.path}`,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.query === undefined ? {} : { qs: request.query }),
    };
    if (request.credential === "apiToken") {
      return replyOf(await context.helpers.httpRequestWithAuthentication.call(context, credentialName, options));
    }
    if (ingestKey === "") {
      throw new LogBrewError(noHttpStatus, "Ingest key missing. Add one to the LogBrew credential to send logs.");
    }
    return replyOf(await context.helpers.httpRequest({ ...options, headers: { Authorization: `Bearer ${ingestKey}` } }));
  }
  return { apiUrl, send };
}

async function projectOptions(context: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const { send } = await connect(context);
  const projects = await listProjects(send);
  return projects.map((project) => ({ name: project.name, value: project.id }));
}

export { connect, projectOptions };
