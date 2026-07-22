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
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type LogBrewMetroConfigOptions = {
  enabled?: boolean;
};

export declare function createLogBrewMetroSerializer<TModule, TGraph, TOptions>(
  customSerializer: LogBrewMetroSerializer<TModule, TGraph, TOptions>,
): LogBrewMetroSerializer<TModule, TGraph, TOptions>;

export declare function createLogBrewMetroSerializer(customSerializer?: null): LogBrewMetroSerializer;

export declare function withLogBrewMetroConfig<T extends LogBrewMetroConfig>(
  config: T,
  options?: LogBrewMetroConfigOptions,
): T;

export default withLogBrewMetroConfig;
