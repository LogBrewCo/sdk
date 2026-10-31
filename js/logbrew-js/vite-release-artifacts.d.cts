type LogBrewViteReleaseArtifactUploadOptions = {
  readonly endpoint: string;
  readonly allowHostedUpload?: boolean;
  readonly tokenEnv?: string;
  readonly dryRun?: boolean;
  readonly maxRetries?: number;
  readonly retryDelay?: number;
  readonly timeout?: number;
};

type LogBrewViteReleaseArtifactsPluginOptions = {
  readonly release: string;
  readonly environment: string;
  readonly service: string;
  readonly projectId?: string;
  readonly minifiedPathPrefix: string;
  readonly buildDir?: string;
  readonly manifestPath?: string;
  readonly repositoryUrl?: string;
  readonly commitSha?: string;
  readonly stripSourcesContent?: boolean;
  readonly stripSourcePrefix?: readonly string[];
  readonly enableSourceMaps?: boolean;
  readonly upload?: LogBrewViteReleaseArtifactUploadOptions;
};

type ViteKeepNamesOutput = { readonly keepNames?: boolean };

type ViteUserConfigInput = {
  readonly root?: string;
  readonly build?: {
    readonly sourcemap?: unknown;
    readonly minify?: unknown;
    readonly rolldownOptions?: { readonly output?: ViteKeepNamesOutput | readonly ViteKeepNamesOutput[] };
  };
  readonly esbuild?: false | { readonly keepNames?: boolean };
};

type ViteConfigChanges = {
  build?: { sourcemap?: "hidden"; rolldownOptions?: { output: { keepNames: true } } };
  esbuild?: { keepNames: true };
};

type ViteResolvedConfigInput = {
  readonly root?: string;
  readonly build?: { readonly outDir?: string };
  readonly logger?: { readonly info: (message: string) => void };
};

type LogBrewViteReleaseArtifactsPlugin = {
  readonly name: "logbrew-vite-release-artifacts";
  readonly apply: "build";
  readonly enforce: "post";
  readonly config: (config?: ViteUserConfigInput) => null | ViteConfigChanges;
  readonly configResolved: (config: ViteResolvedConfigInput) => void;
  readonly writeBundle: () => Promise<void>;
};

declare function createLogBrewViteReleaseArtifactsPlugin(
  options: LogBrewViteReleaseArtifactsPluginOptions
): LogBrewViteReleaseArtifactsPlugin;

export type {
  LogBrewViteReleaseArtifactsPlugin,
  LogBrewViteReleaseArtifactsPluginOptions,
  LogBrewViteReleaseArtifactUploadOptions
};
export { createLogBrewViteReleaseArtifactsPlugin };
export default createLogBrewViteReleaseArtifactsPlugin;
