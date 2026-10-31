type LogBrewMetroSerializerResult = string | {
  code: string;
  map: string;
  [key: string]: unknown;
};

type LogBrewMetroSerializer<TModule = unknown, TGraph = unknown, TOptions = unknown> = (
  entryPoint: string,
  preModules: readonly TModule[],
  graph: TGraph,
  options: TOptions,
) => LogBrewMetroSerializerResult | Promise<LogBrewMetroSerializerResult>;

type LogBrewMetroConfig = {
  serializer?: {
    customSerializer?: unknown;
  } | Record<string, unknown>;
} | Record<string, unknown>;

type LogBrewMetroConfigOptions = {
  enabled?: boolean;
};

type LogBrewExpoSerializationInput<TModule = unknown, TGraph = unknown> = {
  debugId?: string;
  graph: TGraph;
  premodules: TModule[];
};

type LogBrewExpoDebugIdPlugin<TModule = unknown, TGraph = unknown> = (
  input: LogBrewExpoSerializationInput<TModule, TGraph>,
) => TModule[];

type LogBrewExpoConfigOptions<TConfig extends LogBrewMetroConfig = LogBrewMetroConfig> = {
  enabled?: boolean;
  getDefaultConfig?: (...args: never[]) => TConfig;
  unstable_beforeAssetSerializationPlugins?: LogBrewExpoDebugIdPlugin[];
  [key: string]: unknown;
};

declare function createLogBrewMetroSerializer<TModule, TGraph, TOptions>(
  customSerializer: LogBrewMetroSerializer<TModule, TGraph, TOptions>,
): LogBrewMetroSerializer<TModule, TGraph, TOptions>;

declare function createLogBrewMetroSerializer(customSerializer?: null): LogBrewMetroSerializer;

declare function getLogBrewExpoConfig<TConfig extends LogBrewMetroConfig = LogBrewMetroConfig>(
  projectRoot: string,
  options?: LogBrewExpoConfigOptions<TConfig>,
): TConfig;

declare function withLogBrewMetroConfig<TConfig extends LogBrewMetroConfig>(
  config: TConfig,
  options?: LogBrewMetroConfigOptions,
): TConfig;

export type {
  LogBrewExpoConfigOptions,
  LogBrewExpoDebugIdPlugin,
  LogBrewExpoSerializationInput,
  LogBrewMetroConfig,
  LogBrewMetroConfigOptions,
  LogBrewMetroSerializer,
  LogBrewMetroSerializerResult
};
export {
  createLogBrewMetroSerializer,
  getLogBrewExpoConfig,
  withLogBrewMetroConfig
};
export default withLogBrewMetroConfig;
