type LogBrewExpoPluginOptions = {
  /** Add the opt-in Apple native crash and app-hang CocoaPods subspec. Defaults to true. */
  appleNativeDiagnostics?: boolean;
};

type ExpoConfigLike = Record<string, unknown>;
type LogBrewExpoConfigPlugin = (
  config: Readonly<ExpoConfigLike>,
  options?: Readonly<LogBrewExpoPluginOptions>
) => ExpoConfigLike;

declare const withLogBrewReactNative: LogBrewExpoConfigPlugin;
declare function modifyPodfile(contents: string, enabled?: boolean): string;

export type { ExpoConfigLike, LogBrewExpoConfigPlugin, LogBrewExpoPluginOptions };
export { modifyPodfile, withLogBrewReactNative };
export default withLogBrewReactNative;
