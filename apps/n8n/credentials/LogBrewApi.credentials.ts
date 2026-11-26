import type { IAuthenticateGeneric, Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from "n8n-workflow";

class LogBrewApi implements ICredentialType {
  public readonly authenticate: IAuthenticateGeneric = {
    properties: { headers: { Authorization: "=Bearer {{$credentials.apiToken}}" } },
    type: "generic",
  };

  public readonly displayName = "LogBrew API";

  public readonly documentationUrl = "https://github.com/LogBrewCo/sdk/tree/main/apps/n8n#credentials";

  public readonly icon: Icon = { dark: "file:../icons/logbrew.dark.svg", light: "file:../icons/logbrew.svg" };

  public readonly name = "logBrewApi";

  public readonly properties: INodeProperties[] = [
    {
      default: "",
      description:
        "Create one at logbrew.co/account/api with the scopes projects:read, telemetry:read, issues:write, and alerts:read",
      displayName: "API Token",
      name: "apiToken",
      required: true,
      type: "string",
      typeOptions: { password: true },
    },
    {
      default: "",
      description:
        "Only Send Log needs it. Create an ingest key under API Keys in your LogBrew project.",
      displayName: "Ingest Key",
      name: "ingestApiKey",
      type: "string",
      typeOptions: { password: true },
    },
    {
      default: "https://api.logbrew.co",
      description: "Keep the default unless your team runs LogBrew at another address",
      displayName: "API URL",
      name: "apiUrl",
      type: "string",
    },
  ];

  public readonly test: ICredentialTestRequest = {
    request: { baseURL: "={{$credentials.apiUrl}}", url: "/api/projects" },
  };
}

export { LogBrewApi };
