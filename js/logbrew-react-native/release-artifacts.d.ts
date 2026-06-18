export type LogBrewReactNativeReleaseArtifactPlatform = "android" | "ios";

export type LogBrewReactNativeReleaseArtifactsOptions = {
  bundle: string;
  platform: LogBrewReactNativeReleaseArtifactPlatform;
  release: string;
  environment: string;
  service: string;
  sourcemap?: string;
  root?: string;
  buildDir?: string;
  manifestPath?: string;
  minifiedPathPrefix?: string;
  repositoryUrl?: string;
  commitSha?: string;
  stripSourcesContent?: boolean;
  stripSourcePrefix?: string[];
};

export type LogBrewReactNativeReleaseArtifactsResult = {
  buildDir: string;
  bundlePath: string;
  sourcemapPath: string;
  manifestPath: string;
  platform: LogBrewReactNativeReleaseArtifactPlatform;
  prepareReport: Record<string, unknown>;
  manifestReport: Record<string, unknown>;
};

export declare function prepareLogBrewReactNativeReleaseArtifacts(
  options: LogBrewReactNativeReleaseArtifactsOptions
): LogBrewReactNativeReleaseArtifactsResult;

export default prepareLogBrewReactNativeReleaseArtifacts;
