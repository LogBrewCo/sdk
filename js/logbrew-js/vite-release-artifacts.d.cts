export interface LogBrewViteReleaseArtifactsPluginOptions {
  release: string;
  environment: string;
  service: string;
  minifiedPathPrefix: string;
  buildDir?: string;
  manifestPath?: string;
  repositoryUrl?: string;
  commitSha?: string;
  stripSourcesContent?: boolean;
  stripSourcePrefix?: string[];
  enableSourceMaps?: boolean;
}

export interface LogBrewViteReleaseArtifactsPlugin {
  name: "logbrew-vite-release-artifacts";
  apply: "build";
  enforce: "post";
  config(config?: { build?: { sourcemap?: unknown } }): null | { build: { sourcemap: "hidden" } };
  configResolved(config: { root?: string; build?: { outDir?: string } }): void;
  closeBundle(): Promise<void>;
}

export declare function createLogBrewViteReleaseArtifactsPlugin(
  options: LogBrewViteReleaseArtifactsPluginOptions
): LogBrewViteReleaseArtifactsPlugin;

export default createLogBrewViteReleaseArtifactsPlugin;
