class LogBrewApi {
  public readonly authenticate = {
    properties: { headers: { Authorization: "=Bearer {{$credentials.apiToken}}" } },
    type: "generic",
  } as const;

  public readonly displayName = "LogBrew API";

  public readonly documentationUrl = "https://github.com/LogBrewCo/sdk/tree/main/apps/n8n#credentials";

  public readonly icon = { dark: "file:../icons/logbrew.dark.svg", light: "file:../icons/logbrew.svg" } as const;

  public readonly name = "logBrewApi";

  public readonly properties = [
    {
      default: "",
      description:
        "Create one in LogBrew under Settings, API Tokens, with Projects read, Telemetry read & write, and Alerts read access",
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
      name: "ingestKey",
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
  ] as const;

  public readonly test = {
    request: { baseURL: "={{$credentials.apiUrl}}", url: "/api/projects" },
  } as const;
}

export { LogBrewApi };
