export interface LogBrewViteReleaseArtifactUploadOptions {
  endpoint: string;
  allowHostedUpload?: boolean;
  tokenEnv?: string;
  dryRun?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
}

export interface LogBrewViteReleaseArtifactsPluginOptions {
  release: string;
  environment: string;
  service: string;
  projectId?: string;
  minifiedPathPrefix: string;
  buildDir?: string;
  manifestPath?: string;
  repositoryUrl?: string;
  commitSha?: string;
  stripSourcesContent?: boolean;
  stripSourcePrefix?: string[];
  enableSourceMaps?: boolean;
  upload?: LogBrewViteReleaseArtifactUploadOptions;
}

export interface LogBrewViteReleaseArtifactsPlugin {
  name: "logbrew-vite-release-artifacts";
  apply: "build";
  enforce: "post";
  config(config?: { root?: string; build?: { sourcemap?: unknown; minify?: unknown; rolldownOptions?: { output?: { keepNames?: boolean } | Array<{ keepNames?: boolean }> } }; esbuild?: false | { keepNames?: boolean } }): null | { build?: { sourcemap?: "hidden"; rolldownOptions?: { output: { keepNames: true } } }; esbuild?: { keepNames: true } };
  configResolved(config: {
    root?: string;
    build?: { outDir?: string };
    logger?: { info(message: string): void };
  }): void;
  writeBundle(): Promise<void>;
}

export declare function createLogBrewViteReleaseArtifactsPlugin(
  options: LogBrewViteReleaseArtifactsPluginOptions
): LogBrewViteReleaseArtifactsPlugin;

export default createLogBrewViteReleaseArtifactsPlugin;
