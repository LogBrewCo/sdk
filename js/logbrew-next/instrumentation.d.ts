import type {
  LogBrewNextRequestErrorHandler,
  LogBrewNextRequestErrorOptions
} from "./index.js";

export type {
  LogBrewNextRequestError,
  LogBrewNextRequestErrorCaptureContext,
  LogBrewNextRequestErrorContext,
  LogBrewNextRequestErrorEvent,
  LogBrewNextRequestErrorHandler,
  LogBrewNextRequestErrorInput,
  LogBrewNextRequestErrorOptions,
  LogBrewNextRequestErrorRequest,
  LogBrewNextRequestErrorRuntimeContext
} from "./index.js";

export declare function createLogBrewNextRequestErrorHandler(
  options?: LogBrewNextRequestErrorOptions
): LogBrewNextRequestErrorHandler;

declare const defaultExport: {
  createLogBrewNextRequestErrorHandler: typeof createLogBrewNextRequestErrorHandler;
};

export default defaultExport;
