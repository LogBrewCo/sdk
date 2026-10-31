type LogBrewReactNativeReleaseArtifactPlatform = "android" | "ios";

type LogBrewReactNativeReleaseArtifactsOptions = {
  bundle: string;
  platform: LogBrewReactNativeReleaseArtifactPlatform;
  release: string;
  environment: string;
  service: string;
  projectId?: string;
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

type LogBrewReactNativeReleaseArtifactsResult = {
  buildDir: string;
  bundlePath: string;
  sourcemapPath: string;
  manifestPath: string;
  platform: LogBrewReactNativeReleaseArtifactPlatform;
  prepareReport: Record<string, unknown>;
  manifestReport: Record<string, unknown>;
};

type LogBrewReactNativeReleaseArtifactUploadOptions = LogBrewReactNativeReleaseArtifactsOptions & {
  endpoint: string;
  allowHostedUpload?: boolean;
  tokenEnv?: string;
  dryRun?: boolean;
  maxRetries?: string | number;
  retryDelay?: string | number;
  timeout?: string | number;
};

type LogBrewReactNativeReleaseArtifactUploadResult = LogBrewReactNativeReleaseArtifactsResult & {
  uploadReport: Record<string, unknown>;
};

declare function prepareLogBrewReactNativeReleaseArtifacts(
  options: LogBrewReactNativeReleaseArtifactsOptions
): LogBrewReactNativeReleaseArtifactsResult;

declare function uploadLogBrewReactNativeReleaseArtifacts(
  options: LogBrewReactNativeReleaseArtifactUploadOptions
): LogBrewReactNativeReleaseArtifactUploadResult;

export type {
  LogBrewReactNativeReleaseArtifactPlatform,
  LogBrewReactNativeReleaseArtifactUploadOptions,
  LogBrewReactNativeReleaseArtifactUploadResult,
  LogBrewReactNativeReleaseArtifactsOptions,
  LogBrewReactNativeReleaseArtifactsResult
};
export {
  prepareLogBrewReactNativeReleaseArtifacts,
  uploadLogBrewReactNativeReleaseArtifacts
};
export default prepareLogBrewReactNativeReleaseArtifacts;
