export type LogBrewExpoPluginOptions = {
  /** Add the opt-in Apple native crash and app-hang CocoaPods subspec. Defaults to true. */
  appleNativeDiagnostics?: boolean;
};

export type ExpoConfigLike = Record<string, unknown>;
export type LogBrewExpoConfigPlugin = (
  config: ExpoConfigLike,
  options?: LogBrewExpoPluginOptions
) => ExpoConfigLike;

export declare const withLogBrewReactNative: LogBrewExpoConfigPlugin;
export declare function modifyPodfile(contents: string, enabled?: boolean): string;

declare const defaultExport: LogBrewExpoConfigPlugin;
export default defaultExport;
