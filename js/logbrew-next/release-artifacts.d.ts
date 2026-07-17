export type LogBrewNextReleaseArtifactUploadOptions = {
  endpoint: string;
  allowHostedUpload?: boolean;
  tokenEnv?: string;
  dryRun?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
};

export type LogBrewNextReleaseArtifactsOptions = {
  release: string;
  environment: string;
  service: string;
  projectId?: string;
  minifiedPathPrefix?: string;
  root?: string;
  buildDir?: string;
  manifestPath?: string;
  repositoryUrl?: string;
  commitSha?: string;
  stripSourcesContent?: boolean;
  stripSourcePrefix?: string[];
  enableSourceMaps?: boolean;
  upload?: LogBrewNextReleaseArtifactUploadOptions;
};

export declare function withLogBrewNextReleaseArtifacts<TConfig>(
  nextConfig: TConfig,
  options: LogBrewNextReleaseArtifactsOptions
): TConfig;

declare const defaultExport: typeof withLogBrewNextReleaseArtifacts;

export default defaultExport;
