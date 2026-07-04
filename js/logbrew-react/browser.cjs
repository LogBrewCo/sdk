const React = require("react");
const {
  createLogBrewBrowserContext,
  installLogBrewBrowserInteractionTimingInstrumentation,
  installLogBrewBrowserWebVitalsInstrumentation
} = require("@logbrew/browser");
const { SdkError } = require("@logbrew/sdk");
const { useLogBrew } = require("./index.cjs");

function createLogBrewReactBrowserContext(client, options = {}) {
  if (!client) {
    throw new SdkError("configuration_error", "createLogBrewReactBrowserContext requires a client");
  }
  return createLogBrewBrowserContext(
    client,
    options.transport ?? noTransport(),
    options.browserWindow ?? defaultWindow(),
    () => undefined,
    typeof options.traceContext === "function" ? undefined : options.traceContext
  );
}

function useLogBrewBrowserInstrumentation(options = {}) {
  const client = useLogBrew();
  React.useEffect(() => {
    if (options.enabled === false) {
      return undefined;
    }
    const installed = [];
    const context = createLogBrewReactBrowserContext(client, options);

    installOptionalInstrumentation(
      installed,
      "interactionTiming",
      options.interactionTiming ?? true,
      context,
      options,
      installLogBrewBrowserInteractionTimingInstrumentation
    );
    installOptionalInstrumentation(
      installed,
      "webVitals",
      options.webVitals ?? false,
      context,
      options,
      installLogBrewBrowserWebVitalsInstrumentation
    );

    return () => {
      for (const instrumentation of installed.slice().reverse()) {
        instrumentation.uninstall();
      }
    };
  }, [client, options]);
}

function installOptionalInstrumentation(installed, name, config, context, options, install) {
  if (config === false) {
    return;
  }
  const instrumentationOptions = mergedInstrumentationOptions(options, config);
  try {
    const instrumentation = install(context, instrumentationOptions);
    installed.push(instrumentation);
    if (typeof options.onInstrumentation === "function") {
      options.onInstrumentation(name, instrumentation);
    }
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      options.onCaptureError(error, { name });
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
  }
}

function mergedInstrumentationOptions(options, config) {
  const instrumentationOptions = config === true ? {} : config;
  return {
    ...sharedBrowserOptions(options),
    ...instrumentationOptions,
    metadata: {
      ...(options.metadata ?? {}),
      ...(instrumentationOptions.metadata ?? {})
    },
    flushOnCapture: instrumentationOptions.flushOnCapture ?? options.flushOnCapture ?? false,
    traceContext: instrumentationOptions.traceContext ?? options.traceContext
  };
}

function sharedBrowserOptions(options) {
  return {
    browserWindow: options.browserWindow,
    includeDocumentTitle: options.includeDocumentTitle,
    includeHash: options.includeHash,
    includeQueryString: options.includeQueryString,
    includeUserAgent: options.includeUserAgent,
    metadata: options.metadata,
    now: options.now,
    onCaptureError: options.onCaptureError,
    onFlush: options.onFlush,
    raiseCaptureErrors: options.raiseCaptureErrors,
    randomValues: options.randomValues,
    sampled: options.sampled,
    sanitizeMetadata: options.sanitizeMetadata,
    traceFlags: options.traceFlags
  };
}

function defaultWindow() {
  return typeof globalThis.window === "object" ? globalThis.window : undefined;
}

function noTransport() {
  return {
    async send() {
      throw new SdkError(
        "configuration_error",
        "React browser instrumentation requires options.transport when flushOnCapture is true"
      );
    }
  };
}

module.exports = {
  createLogBrewReactBrowserContext,
  useLogBrewBrowserInstrumentation,
  default: {
    createLogBrewReactBrowserContext,
    useLogBrewBrowserInstrumentation
  }
};
