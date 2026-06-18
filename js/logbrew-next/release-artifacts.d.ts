export type LogBrewNextReleaseArtifactsOptions = {
  release: string;
  environment: string;
  service: string;
  minifiedPathPrefix?: string;
  root?: string;
  buildDir?: string;
  manifestPath?: string;
  repositoryUrl?: string;
  commitSha?: string;
  stripSourcesContent?: boolean;
  stripSourcePrefix?: string[];
  enableSourceMaps?: boolean;
};

export declare function withLogBrewNextReleaseArtifacts<TConfig>(
  nextConfig: TConfig,
  options: LogBrewNextReleaseArtifactsOptions
): TConfig;

declare const defaultExport: typeof withLogBrewNextReleaseArtifacts;

export default defaultExport;
