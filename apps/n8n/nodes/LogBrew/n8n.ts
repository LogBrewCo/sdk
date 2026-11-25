type Json = Readonly<Record<string, unknown>>;

type HttpRequest = Readonly<{
  body?: Json;
  headers?: Readonly<Record<string, string>>;
  ignoreHttpStatusErrors: true;
  json: true;
  method: "GET" | "PATCH" | "POST";
  qs?: Readonly<Record<string, string>>;
  returnFullResponse: true;
  url: string;
}>;

type Helpers = Readonly<{
  httpRequest: (options: HttpRequest) => Promise<unknown>;
  httpRequestWithAuthentication: (this: unknown, credential: string, options: HttpRequest) => Promise<unknown>;
}>;

type BaseContext = Readonly<{
  getCredentials: (name: string) => Promise<Json>;
  helpers: Helpers;
}>;

type ExecuteContext = BaseContext &
  Readonly<{
    continueOnFail: () => boolean;
    getInputData: () => readonly unknown[];
    getNodeParameter: (name: string, index: number, fallback: unknown) => unknown;
  }>;

type PollContext = BaseContext &
  Readonly<{
    getMode: () => string;
    getNodeParameter: (name: string, fallback: unknown) => unknown;
    getWorkflowStaticData: (scope: "node") => Record<string, unknown>;
  }>;

type Item = Readonly<{ json: Json; pairedItem?: Readonly<{ item: number }> }>;

type Option = Readonly<{ action?: string; description?: string; name: string; value: string }>;

type Property = Readonly<{
  default: string;
  description?: string;
  displayName: string;
  displayOptions?: Readonly<{ show: Readonly<Record<string, readonly string[]>> }>;
  name: string;
  noDataExpression?: boolean;
  options?: readonly Option[];
  placeholder?: string;
  required?: boolean;
  type: "json" | "options" | "string";
  typeOptions?: Readonly<{ loadOptionsMethod?: string; password?: boolean }>;
}>;

type Icon = Readonly<{ dark: string; light: string }>;

type NodeDescription = Readonly<{
  credentials: readonly Readonly<{ name: string; required: boolean }>[];
  defaults: Readonly<{ name: string }>;
  description: string;
  displayName: string;
  group: readonly string[];
  icon: Icon;
  inputs: readonly "main"[];
  name: string;
  outputs: readonly "main"[];
  polling?: true;
  properties: readonly Property[];
  subtitle: string;
  usableAsTool?: true;
  version: number;
}>;

export {
  type BaseContext,
  type ExecuteContext,
  type HttpRequest,
  type Icon,
  type Item,
  type Json,
  type NodeDescription,
  type Option,
  type PollContext,
  type Property,
};
