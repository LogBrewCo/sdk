export type LogBrewMetroSerializerResult = string | {
  code: string;
  map: string;
  [key: string]: unknown;
};

export type LogBrewMetroSerializer<TModule = unknown, TGraph = unknown, TOptions = unknown> = (
  entryPoint: string,
  preModules: readonly TModule[],
  graph: TGraph,
  options: TOptions,
) => LogBrewMetroSerializerResult | Promise<LogBrewMetroSerializerResult>;

export type LogBrewMetroConfig = {
  serializer?: {
    customSerializer?: unknown;
  } | Record<string, unknown>;
} | Record<string, unknown>;

export type LogBrewMetroConfigOptions = {
  enabled?: boolean;
};

export type LogBrewExpoSerializationInput<TModule = unknown, TGraph = unknown> = {
  debugId?: string;
  graph: TGraph;
  premodules: TModule[];
};

export type LogBrewExpoDebugIdPlugin<TModule = unknown, TGraph = unknown> = (
  input: LogBrewExpoSerializationInput<TModule, TGraph>,
) => TModule[];

export type LogBrewExpoConfigOptions<TConfig extends LogBrewMetroConfig = LogBrewMetroConfig> = {
  enabled?: boolean;
  getDefaultConfig?: (...args: never[]) => TConfig;
  unstable_beforeAssetSerializationPlugins?: LogBrewExpoDebugIdPlugin[];
  [key: string]: unknown;
};

export declare function createLogBrewMetroSerializer<TModule, TGraph, TOptions>(
  customSerializer: LogBrewMetroSerializer<TModule, TGraph, TOptions>,
): LogBrewMetroSerializer<TModule, TGraph, TOptions>;

export declare function createLogBrewMetroSerializer(customSerializer?: null): LogBrewMetroSerializer;

export declare function getLogBrewExpoConfig<TConfig extends LogBrewMetroConfig = LogBrewMetroConfig>(
  projectRoot: string,
  options?: LogBrewExpoConfigOptions<TConfig>,
): TConfig;

export declare function withLogBrewMetroConfig<T extends LogBrewMetroConfig>(
  config: T,
  options?: LogBrewMetroConfigOptions,
): T;

export default withLogBrewMetroConfig;
